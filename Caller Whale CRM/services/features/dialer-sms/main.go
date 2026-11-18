// dialer-sms: calling, auto dialing and texting through the carrier (Telnyx first), and the carrier's webhooks. Each finished
// call is logged in the CRM (crm-core) as the person who made it. With TELNYX_MODE=simulate it talks to a built-in Telnyx
// simulator instead, so the CRM's calling and texting can be tried end to end before any minute is bought.
// Plan: docs/plans/messaging-sms-voice.md; how to run, simulate and go live: README.md.
//
//	dialer-sms             serve (PORT, default 8113)
//	dialer-sms health      the container's health check
//	dialer-sms sim         the simulator on its own (SIM_PORT, default 8119)
//	dialer-sms scenarios   play every scenario against a running dialer (-h for the options)
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type config struct {
	port, databaseURL, jwksURL, authzURL, authzToken string
	origins                                          map[string]bool
	grantTTL                                         time.Duration
	crmURL, crmToken                                 string
	billingURL, billingToken                         string // billing's budgets (step 22); without them nothing is limited
	assistantURL, assistantToken                     string // the in-app assistant (step 26): the assistant service and its AGENT_TOKEN

	simulate        bool
	apiURL, apiKey  string
	connectionID    string
	sipConnectionID string
	profileID       string
	publicKey       string
	webhookURL      string
	fromNumber      string
	amdMode         string // detect, detect_beep, premium, or "" (off)
	recordCalls     bool
	ringSeconds     int
	settleDelay     time.Duration
	wrapup          time.Duration
	simSpeed        float64
	simPrivateKey   string
	noTimers        bool // tests: settle only when asked
	anyHours        bool // simulate mode only (SIM_ANY_HOURS=true): try calls and texts at any hour; live always keeps the hours
}

func loadConfig(getenv func(string) string) (config, error) {
	trim := func(v string) string { return strings.TrimRight(strings.TrimSpace(getenv(v)), "/") }
	seconds := func(name string, fallback int) (int, error) {
		v := strings.TrimSpace(getenv(name))
		if v == "" {
			return fallback, nil
		}
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			return 0, fmt.Errorf("%s must be a number of seconds", name)
		}
		return n, nil
	}
	c := config{
		port: trim("PORT"), databaseURL: trim("DATABASE_URL"), jwksURL: trim("AUTH_JWKS_URL"), authzURL: trim("AUTHZ_URL"),
		authzToken: trim("AUTHZ_TOKEN"), grantTTL: 5 * time.Second, crmURL: trim("CRM_URL"), crmToken: trim("CRM_TOKEN"),
		billingURL: strings.TrimSuffix(trim("BILLING_URL"), "/"), billingToken: trim("BILLING_TOKEN"),
		assistantURL: strings.TrimSuffix(trim("ASSISTANT_URL"), "/"), assistantToken: trim("ASSISTANT_TOKEN"),
		apiURL: trim("TELNYX_API_URL"), apiKey: trim("TELNYX_API_KEY"), connectionID: trim("TELNYX_CONNECTION_ID"),
		sipConnectionID: trim("TELNYX_SIP_CONNECTION_ID"), profileID: trim("TELNYX_MESSAGING_PROFILE_ID"),
		publicKey: trim("TELNYX_PUBLIC_KEY"), webhookURL: trim("TELNYX_WEBHOOK_URL"), fromNumber: e164(getenv("TELNYX_FROM_NUMBER")),
		recordCalls: trim("RECORD_CALLS") == "true", simPrivateKey: trim("TELNYX_SIM_PRIVATE_KEY"),
	}
	if c.port == "" {
		c.port = "8113"
	}
	var err error
	if c.origins, err = parseOrigins(getenv("CORS_ORIGINS")); err != nil {
		return c, err
	}
	switch mode := strings.ToLower(trim("TELNYX_MODE")); mode {
	case "", "simulate":
		c.simulate = true
		c.anyHours = strings.EqualFold(trim("SIM_ANY_HOURS"), "true")
	case "live":
	default:
		return c, fmt.Errorf("TELNYX_MODE is simulate or live, not %q", mode)
	}
	switch amd := strings.ToLower(trim("TELNYX_AMD")); amd {
	case "":
		c.amdMode = "detect"
	case "off":
	case "detect", "detect_beep", "premium":
		c.amdMode = amd
	default:
		return c, errors.New("TELNYX_AMD is detect, detect_beep, premium or off")
	}
	ring, err := seconds("RING_SECONDS", 30)
	if err != nil {
		return c, err
	}
	settle, err := seconds("SETTLE_SECONDS", 5)
	if err != nil {
		return c, err
	}
	wrap, err := seconds("WRAPUP_SECONDS", 600)
	if err != nil {
		return c, err
	}
	c.ringSeconds, c.settleDelay, c.wrapup = ring, time.Duration(settle)*time.Second, time.Duration(wrap)*time.Second
	c.simSpeed = 1
	if v := trim("SIM_SPEED"); v != "" {
		if c.simSpeed, err = strconv.ParseFloat(v, 64); err != nil || c.simSpeed <= 0 {
			return c, errors.New("SIM_SPEED is how many times faster than real time the simulator runs, like 1 or 10")
		}
	}
	if c.databaseURL == "" || c.jwksURL == "" || c.authzURL == "" || c.crmURL == "" {
		return c, errors.New("set DATABASE_URL, AUTH_JWKS_URL, AUTHZ_URL and CRM_URL")
	}
	if len(c.authzToken) < 32 || len(c.crmToken) < 32 {
		return c, errors.New("AUTHZ_TOKEN (this service's token in authz, dialer-sms=...) and CRM_TOKEN (crm-core's DIALER_TOKEN) need at least 32 characters")
	}
	if !c.simulate && (c.apiKey == "" || c.connectionID == "" || c.publicKey == "") {
		return c, errors.New("TELNYX_MODE=live needs TELNYX_API_KEY, TELNYX_CONNECTION_ID and TELNYX_PUBLIC_KEY")
	}
	if c.simulate && c.apiURL != "" && c.publicKey == "" {
		return c, errors.New("with an outside simulator (TELNYX_API_URL), set TELNYX_PUBLIC_KEY to the key it prints")
	}
	return c, nil
}

// newServer puts the parts together. In simulate mode without TELNYX_API_URL the simulator runs inside this service: the
// carrier client calls it over HTTP on this port and it sends its signed webhooks back to this port.
func newServer(cfg config, st *store, keys *keyset, r rules, c crm) (*server, error) {
	s := &server{cfg: cfg, st: st, keys: keys, rules: r, crm: c, now: time.Now}
	if cfg.billingURL != "" && cfg.billingToken != "" {
		s.budget = &billingClient{base: cfg.billingURL, token: cfg.billingToken, http: &http.Client{Timeout: 5 * time.Second}}
	}
	t := &telnyx{base: cfg.apiURL, key: cfg.apiKey, connectionID: cfg.connectionID, sipConnID: cfg.sipConnectionID,
		profileID: cfg.profileID, webhookURL: cfg.webhookURL, simulate: cfg.simulate, http: &http.Client{Timeout: 10 * time.Second}}
	if t.base == "" {
		t.base = "https://api.telnyx.com/v2"
	}
	if cfg.simulate && cfg.apiURL == "" {
		key, err := simKey(cfg.simPrivateKey)
		if err != nil {
			return nil, err
		}
		if t.key == "" {
			t.key = newUUID()
			s.cfg.apiKey = t.key
		}
		if t.connectionID == "" {
			t.connectionID = "sim-connection"
		}
		local := "http://127.0.0.1:" + cfg.port
		s.sim = newSimulator(key, t.key, local+"/webhooks/telnyx", cfg.simSpeed)
		t.base, t.webhookURL = local+"/telnyx-sim/v2", ""
		s.webhookKey = key.Public().(ed25519.PublicKey)
	} else {
		pub, err := parsePublicKey(cfg.publicKey)
		if err != nil {
			return nil, err
		}
		s.webhookKey = pub
	}
	s.carrier = t
	return s, nil
}

func simKey(text string) (ed25519.PrivateKey, error) {
	if text == "" {
		_, key, err := ed25519.GenerateKey(rand.Reader)
		return key, err
	}
	seed, err := base64.StdEncoding.DecodeString(text)
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errors.New("TELNYX_SIM_PRIVATE_KEY must be a base64 Ed25519 seed (32 bytes)")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "health":
			port := envOr("PORT", "8113")
			res, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://127.0.0.1:" + port + "/healthz")
			if err != nil || res.StatusCode != http.StatusOK {
				log.Printf("health probe failed: %v", err)
				os.Exit(1)
			}
			os.Exit(0)
		case "scenarios":
			os.Exit(runScenarios(os.Args[2:]))
		case "sim":
			os.Exit(runSim())
		}
	}
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stopAll := context.WithCancel(context.Background())
	defer stopAll()
	st, err := openStore(ctx, cfg.databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer st.close()
	s, err := newServer(cfg, st, newKeyset(cfg.jwksURL), newAuthz(cfg.authzURL, cfg.authzToken, cfg.grantTTL),
		&crmClient{base: cfg.crmURL, token: cfg.crmToken, http: &http.Client{Timeout: 10 * time.Second}})
	if err != nil {
		log.Fatal(err)
	}
	if cfg.simulate {
		log.Printf("WARN TELNYX_MODE=simulate: calls and texts go to the Telnyx simulator (speed %vx); nothing reaches a phone", cfg.simSpeed)
	} else {
		log.Print("INFO TELNYX_MODE=live: calls and texts go to Telnyx and cost money")
	}
	go s.settlePeriodically(ctx)
	go s.checkWaitingPeriodically(ctx)
	go s.sendDuePeriodically(ctx)
	go s.checkCallbacksPeriodically(ctx)
	srv := &http.Server{Addr: ":" + cfg.port, Handler: s.handler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: time.Minute, WriteTimeout: time.Minute, IdleTimeout: 2 * time.Minute}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		stopAll()
		sctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	fmt.Printf("[START] Caller Whale dialer and SMS | Listening on port %s\n", cfg.port)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// runSim runs the simulator on its own: SIM_PORT, SIM_WEBHOOK_URL (the dialer's /webhooks/telnyx), TELNYX_API_KEY,
// TELNYX_SIM_PRIVATE_KEY (optional; printed when made) and SIM_SPEED.
func runSim() int {
	key, err := simKey(os.Getenv("TELNYX_SIM_PRIVATE_KEY"))
	if err != nil {
		log.Print(err)
		return 2
	}
	apiKey, hook := os.Getenv("TELNYX_API_KEY"), os.Getenv("SIM_WEBHOOK_URL")
	if apiKey == "" || hook == "" {
		log.Print("set TELNYX_API_KEY (any value; the dialer must use the same) and SIM_WEBHOOK_URL")
		return 2
	}
	speed, _ := strconv.ParseFloat(envOr("SIM_SPEED", "1"), 64)
	if speed <= 0 {
		speed = 1
	}
	port := envOr("SIM_PORT", "8119")
	fmt.Printf("Telnyx simulator on :%s; give the dialer TELNYX_API_URL=http://<this host>:%s/v2 and TELNYX_PUBLIC_KEY=%s\n",
		port, port, base64.StdEncoding.EncodeToString(key.Public().(ed25519.PublicKey)))
	if err := http.ListenAndServe(":"+port, newSimulator(key, apiKey, hook, speed).handler()); err != nil {
		log.Print(err)
		return 1
	}
	return 0
}
