package telnyx

// The six containers this code base runs as (D389, split 4), named for the work and the carrier (owner, 2026-11-22). Each is a
// program under cmd/ with its own image, port and health; all share the dialer_sms database. Calls and texts are apart because
// Telnyx sends their webhooks to separate addresses (a call's webhook URL, the messaging profile's), so a texting burst never
// slows a call, and Telnyx wants each webhook answered within about two seconds.
//
//   telnyx-phone-api       8113  the browser's calls, numbers, hours, agent status and budgets
//   telnyx-phone-webhooks  8122  Telnyx call.* webhooks: saved once, answered and acted on at once
//   telnyx-phone-jobs      8123  settling finished calls into the CRM, callback reminders, old captions, erasures
//   telnyx-sms-api         8124  the browser's texts: sending, threads, consent, opt-outs, templates, bulk, settings, alerts
//   telnyx-sms-webhooks    8125  Telnyx message.* and 10dlc.* webhooks
//   telnyx-sms-jobs        8126  scheduled texts, unanswered-text alerts, 10DLC registration, opt-out standing
//
// roleAll ("dialer-sms", cmd/dialer-sms) is every part in one program, as deployed before the split.

import (
	"context"
	"hash/fnv"
	"log"
	"net/http"
	"strings"
)

type role string

const (
	roleAll           role = "dialer-sms"
	rolePhoneAPI      role = "telnyx-phone-api"
	rolePhoneWebhooks role = "telnyx-phone-webhooks"
	rolePhoneJobs     role = "telnyx-phone-jobs"
	roleSMSAPI        role = "telnyx-sms-api"
	roleSMSWebhooks   role = "telnyx-sms-webhooks"
	roleSMSJobs       role = "telnyx-sms-jobs"
)

var roles = []role{roleAll, rolePhoneAPI, rolePhoneWebhooks, rolePhoneJobs, roleSMSAPI, roleSMSWebhooks, roleSMSJobs}

// defaultPort is each container's port when PORT is not set.
func (r role) defaultPort() string {
	switch r {
	case rolePhoneWebhooks:
		return "8122"
	case rolePhoneJobs:
		return "8123"
	case roleSMSAPI:
		return "8124"
	case roleSMSWebhooks:
		return "8125"
	case roleSMSJobs:
		return "8126"
	}
	return "8113"
}

func (r role) phone() bool { return r == rolePhoneAPI || r == rolePhoneWebhooks || r == rolePhoneJobs }
func (r role) sms() bool   { return r == roleSMSAPI || r == roleSMSWebhooks || r == roleSMSJobs }

// hostsSimulator: in simulate mode the fake Telnyx runs in the API containers (calls in one, texts in the other) and in roleAll.
// The others talk to their side's API container's simulator.
func (r role) hostsSimulator() bool { return r == roleAll || r == rolePhoneAPI || r == roleSMSAPI }

// simulatorURL is where a container that does not host the simulator finds its side's one (TELNYX_API_URL overrides it).
func (r role) simulatorURL() string {
	if r.sms() {
		return "http://telnyx-sms-api:8124/telnyx-sim/v2"
	}
	return "http://telnyx-phone-api:8113/telnyx-sim/v2"
}

// simulatorWebhookURL is where the simulator in an API container sends its webhooks (SIM_WEBHOOK_URL overrides it).
func (r role) simulatorWebhookURL() string {
	if r == roleSMSAPI {
		return "http://telnyx-sms-webhooks:8125/webhooks/telnyx"
	}
	return "http://telnyx-phone-webhooks:8122/webhooks/telnyx"
}

// serves says whether this container answers a request path. Health, version and status are everyone's.
func (r role) serves(path string) bool {
	if path == "/healthz" || path == "/version" || path == "/status" || r == roleAll || r == "" {
		return true
	}
	under := func(prefixes ...string) bool {
		for _, p := range prefixes {
			if path == p || strings.HasPrefix(path, p+"/") {
				return true
			}
		}
		return false
	}
	switch r {
	case rolePhoneAPI:
		return under("/api/v1/calls", "/api/v1/budgets", "/api/v1/recording", "/api/v1/voicemail-drops", "/api/v1/status",
			"/api/v1/leads", "/api/v1/numbers", "/telnyx-sim")
	case roleSMSAPI:
		return under("/api/v1/sms", "/telnyx-sim")
	case rolePhoneWebhooks, roleSMSWebhooks:
		// Either takes any Telnyx event (the same checks and the same code), so a webhook sent to the wrong address is not lost;
		// Telnyx is set up to send calls to one and texts to the other.
		return under("/webhooks/telnyx")
	}
	return false // the jobs containers answer only health, version and status
}

// loops is the timed work a container runs. Each is safe with two copies: settling and scheduled texts lock their rows (SKIP
// LOCKED), and every other pass runs on one copy at a time (onlyOne).
func (r role) loops() []string {
	switch r {
	case roleAll:
		return []string{"settle", "callbacks", "erasures", "scheduled_texts", "unanswered_texts", "carrier"}
	case rolePhoneJobs:
		return []string{"settle", "callbacks", "erasures"}
	case roleSMSJobs:
		return []string{"scheduled_texts", "unanswered_texts", "carrier"}
	}
	return nil
}

// roleFilter answers 404 for any path this container does not serve.
func roleFilter(r role, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if !r.serves(req.URL.Path) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": map[string]any{"code": "not_found", "message": "Not here: this is " + string(r) + "."}})
			return
		}
		next.ServeHTTP(w, req)
	})
}

// onlyOne runs one pass of a timed task on one copy at a time: the copy that holds the task's advisory lock does it, another
// skips this round. The lock lives on one connection for the length of the pass.
func (s *server) onlyOne(ctx context.Context, task string, pass func(context.Context)) {
	conn, err := s.st.db.Acquire(ctx)
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("WARN %s: %v", task, err)
		}
		return
	}
	defer conn.Release()
	h := fnv.New64a()
	h.Write([]byte("telnyx:" + task))
	key := int64(h.Sum64())
	var got bool
	if err = conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, key).Scan(&got); err != nil || !got {
		return
	}
	defer conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, key)
	pass(ctx)
}

// startLoops starts this container's timed work.
func (s *server) startLoops(ctx context.Context, r role) {
	for _, l := range r.loops() {
		switch l {
		case "settle":
			go s.settlePeriodically(ctx)
		case "callbacks":
			go s.checkCallbacksPeriodically(ctx)
		case "erasures":
			go s.erasePeriodically(ctx)
		case "scheduled_texts":
			go s.sendDuePeriodically(ctx)
		case "unanswered_texts":
			go s.checkWaitingPeriodically(ctx)
		case "carrier":
			go s.carrierPeriodically(ctx)
		}
	}
}
