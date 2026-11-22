// crm-core: the CRM's backend. The web CRM (app.callerwhale.com) and the desktop app sync their leads, tasks, notes, calls, deals and
// handoffs here. The import worker receives lists and writes SQL source rows for Core to merge. Who someone is comes from the auth service's signed tokens (checked locally); what they
// may do comes from the authorization service. Plan: docs/plans/crm-core-and-imports.md.
package crm

import (
	"callerwhale/authverify"
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

type config struct {
	port          string
	databaseURL   string
	jwksURL       string          // the auth service's public keys
	authzURL      string          // the authorization service, private
	authzToken    string          // crm-core's own token there (AUTHZ_TOKENS "core-api=...")
	notifyURL     string          // where the website's contact form goes on to; empty turns it off
	importRole    string          // the import worker's database login, to be given the holding tables
	origins       map[string]bool // pages that may call from a browser (CORS_ORIGINS)
	grantTTL      time.Duration
	learningURL   string // the learning service (private); empty turns the learning copy off
	learningToken string
	dialerToken   string // the dialer service's token for /internal/v1/dialer (DIALER_TOKEN); empty turns those routes off
	// The in-app assistant: the assistant service and its AGENT_TOKEN; billing and crm-core's token there, to charge its use.
	assistantURL, assistantToken string
	billingURL, billingToken     string
	// Google Calendar: the Google Cloud app, the key that encrypts stored tokens, and the CRM web app for links and returns.
	googleClientID, googleSecret, googleRedirect string
	googleKey                                    []byte
	appURL                                       string
	// Email to leads: Amazon SES's region (its login from AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY), this API's public
	// address, the domain replies go to, and the SNS topic SES puts them on.
	emailRegion, emailPublicURL, emailReplyDomain, emailTopic string
	// Scheduled report emails: the notification service and crm-core's token in its NOTIFY_TOKENS.
	notifyMailURL, notifyMailToken string
	sharedLearning                 bool   // SHARED_LEARNING=on once the lawyer approved the agreement
	restoreCopyURL                 string // The database a backup was restored into, to restore one agency from
	carrierCheck                   bool   // Imports wait for the carriers to verify the agency (CARRIER_CHECK=on)
	clamdAddr                      string // ClamAV's daemon, like clamav:3310
	runJobs                        bool   // CRM_RUN_JOBS (default on): this process also works the job queue (split 2)
}

func loadConfig(getenv func(string) string) (config, error) { return loadConfigFor("api", getenv) }

// loadConfigFor reads the settings of one program: "api" (crm-core), "merge" (crm-merge) or "outbox" (crm-outbox). The job containers
// read the same names; each needs only some of them (env/crm-merge.production.example, env/crm-outbox.production.example).
func loadConfigFor(role string, getenv func(string) string) (config, error) {
	trim := func(v string) string { return strings.TrimRight(strings.TrimSpace(v), "/") }
	c := config{
		port:          strings.TrimSpace(getenv("PORT")),
		databaseURL:   strings.TrimSpace(getenv("DATABASE_URL")),
		jwksURL:       trim(getenv("AUTH_JWKS_URL")),
		authzURL:      trim(getenv("AUTHZ_URL")),
		authzToken:    strings.TrimSpace(getenv("AUTHZ_TOKEN")),
		notifyURL:     trim(getenv("NOTIFY_URL")),
		importRole:    strings.TrimSpace(getenv("IMPORT_DB_ROLE")),
		grantTTL:      5 * time.Second,
		learningURL:   trim(getenv("LEARNING_URL")),
		learningToken: strings.TrimSpace(getenv("LEARNING_TOKEN")),
		dialerToken:   strings.TrimSpace(getenv("DIALER_TOKEN")),
		assistantURL:  trim(getenv("ASSISTANT_URL")), assistantToken: strings.TrimSpace(getenv("ASSISTANT_TOKEN")),
		billingURL: trim(getenv("BILLING_URL")), billingToken: strings.TrimSpace(getenv("BILLING_TOKEN")),
		googleClientID: strings.TrimSpace(getenv("GOOGLE_CLIENT_ID")), googleSecret: strings.TrimSpace(getenv("GOOGLE_CLIENT_SECRET")),
		googleRedirect: strings.TrimSpace(getenv("GOOGLE_REDIRECT_URL")), appURL: trim(getenv("APP_URL")),
		emailRegion: strings.TrimSpace(getenv("EMAIL_SES_REGION")), emailPublicURL: trim(getenv("EMAIL_PUBLIC_URL")),
		emailReplyDomain: strings.ToLower(strings.TrimSpace(getenv("EMAIL_REPLY_DOMAIN"))), emailTopic: strings.TrimSpace(getenv("EMAIL_SNS_TOPIC_ARN")),
		notifyMailURL: trim(getenv("NOTIFY_MAIL_URL")), notifyMailToken: strings.TrimSpace(getenv("NOTIFY_MAIL_TOKEN")),
		clamdAddr: strings.TrimSpace(getenv("CLAMD_ADDR")), carrierCheck: strings.EqualFold(strings.TrimSpace(getenv("CARRIER_CHECK")), "on"),
		restoreCopyURL: strings.TrimSpace(getenv("RESTORE_COPY_URL")),
		sharedLearning: strings.EqualFold(strings.TrimSpace(getenv("SHARED_LEARNING")), "on"),
		runJobs:        !strings.EqualFold(strings.TrimSpace(getenv("CRM_RUN_JOBS")), "false"),
	}
	if c.port == "" {
		c.port = map[string]string{"api": "8107", "merge": "8120", "outbox": "8121"}[role]
	}
	var err error
	if c.origins, err = parseOrigins(getenv("CORS_ORIGINS")); err != nil {
		return c, err
	}
	switch {
	case c.databaseURL == "":
		return c, errors.New("set DATABASE_URL")
	case role == "api" && (c.jwksURL == "" || c.authzURL == ""):
		return c, errors.New("set DATABASE_URL, AUTH_JWKS_URL and AUTHZ_URL")
	case role == "outbox" && c.authzURL == "": // emails and reports look up teams and members
		return c, errors.New("set AUTHZ_URL and AUTHZ_TOKEN: crm-outbox looks up teams and members for emails and reports")
	}
	if c.authzURL != "" && len(c.authzToken) < 32 {
		return c, errors.New("AUTHZ_TOKEN must be at least 32 characters: crm-core's token in authz's AUTHZ_TOKENS (core-api=...)")
	}
	if c.learningURL != "" && len(c.learningToken) < 32 {
		return c, errors.New("LEARNING_TOKEN must be at least 32 characters when LEARNING_URL is set")
	}
	if c.dialerToken != "" && len(c.dialerToken) < 32 {
		return c, errors.New("DIALER_TOKEN must be at least 32 characters when set: the dialer service's CRM_TOKEN")
	}
	if c.assistantURL != "" && len(c.assistantToken) < 32 {
		return c, errors.New("ASSISTANT_TOKEN must be at least 32 characters when ASSISTANT_URL is set: the assistant service's AGENT_TOKEN")
	}
	if c.billingURL != "" && len(c.billingToken) < 32 {
		return c, errors.New("BILLING_TOKEN must be at least 32 characters when BILLING_URL is set: crm-core's token in billing's BILLING_TOKENS (crm-core=...)")
	}
	if c.googleClientID != "" {
		if c.googleSecret == "" || c.googleRedirect == "" || c.appURL == "" {
			return c, errors.New("set GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URL and APP_URL with GOOGLE_CLIENT_ID")
		}
		if c.googleKey, err = parseTokenKey(getenv("GOOGLE_TOKEN_KEY")); err != nil {
			return c, err
		}
	}
	return c, nil
}

// Main runs crm-core: the API, and until the split's job containers take them over, every background job (cmd/crm-core starts it).
func Main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8107"
	}
	healthProbe(port)
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stopAll := context.WithCancel(context.Background())
	defer stopAll()
	log.Print("INFO opening CRM database and applying migrations")
	st, err := openStore(ctx, cfg.databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer st.close()
	log.Print("INFO CRM database ready; granting importer access")
	if err = st.grantImporter(ctx, cfg.importRole); err != nil {
		log.Fatal(err)
	}
	log.Print("INFO importer access ready")
	s := &server{cfg: cfg, keys: authverify.NewKeyset(cfg.jwksURL), rules: newAuthz(cfg.authzURL, cfg.authzToken, cfg.grantTTL), st: st, hub: newHub(), now: time.Now}
	if cfg.googleClientID != "" {
		s.calendar = newGoogleAPI(cfg.googleClientID, cfg.googleSecret, cfg.googleRedirect)
	}
	s.fetchCert = defaultFetchCert
	if cfg.clamdAddr != "" {
		s.scanner = clamd{addr: cfg.clamdAddr}
	}
	if cfg.emailRegion != "" {
		ses, err := newSES(ctx, cfg.emailRegion)
		if err != nil {
			log.Fatal(err)
		}
		s.mail = ses
	}
	go s.hub.listen(ctx, cfg.databaseURL)
	// The merges and assignments run through the job queue. CRM_RUN_JOBS=false leaves them to the crm-merge container (split 2):
	// until that container is running, keep the default, so there is never a time when nobody does them.
	queues := allQueues
	if !cfg.runJobs {
		queues = nil
	}
	if err = s.startJobs(ctx, queues); err != nil {
		log.Fatal(err)
	}
	defer s.stopJobs()
	go st.keepBuildingLateIndexes(ctx, 5*time.Minute)
	srv := &http.Server{Addr: ":" + cfg.port, Handler: s.handler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 5 * time.Minute, WriteTimeout: 5 * time.Minute, IdleTimeout: 2 * time.Minute}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		stopAll()
		sctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	fmt.Printf("[START] Caller Whale CRM core | Listening on port %s\n", cfg.port)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
