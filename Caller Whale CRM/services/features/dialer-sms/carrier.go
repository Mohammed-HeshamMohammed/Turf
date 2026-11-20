package main

// Build step 39 (migrations/0009_carrier.sql): each agency registers its own texting brand and campaign with the US carriers (10DLC)
// through Telnyx (D268). Nobody in the agency calls until its brand is verified, or texts until its campaign is provisioned with
// the carriers (D314), so one agency's behaviour cannot get the others blocked. With CARRIER_CHECK=off (tests and local work) the
// registration is not required. Telnyx's 10DLC API, read 2026-11-18:
//
//   POST /v2/10dlc/brand, GET /v2/10dlc/brand/{brandId}            brandId, identityStatus, status, failureReasons
//   POST /v2/10dlc/campaignBuilder, GET /v2/10dlc/campaign/{id}     campaignId, campaignStatus (TCR_PENDING ... MNO_PROVISIONED)
//   POST /v2/10dlc/phone_number_campaigns {phoneNumber, campaignId}
//   Webhooks 10dlc.brand.update, 10dlc.campaign.update, 10dlc.phone_number.update: each makes us read the registration again.

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// registrar is the carrier's registration API; *telnyx is the one we have.
type registrar interface {
	createBrand(ctx context.Context, body map[string]any) (map[string]any, error)
	getBrand(ctx context.Context, id string) (map[string]any, error)
	createCampaign(ctx context.Context, body map[string]any) (map[string]any, error)
	getCampaign(ctx context.Context, id string) (map[string]any, error)
	assignNumber(ctx context.Context, phone, campaign string) error
}

func (t *telnyx) tenDLC(ctx context.Context, method, path string, body any) (map[string]any, error) {
	var out map[string]any
	if err := t.do(ctx, method, path, body, "", &out); err != nil {
		return nil, err
	}
	// The reference shows the fields at the top; the guide's examples under "data". Either is read.
	if data, ok := out["data"].(map[string]any); ok {
		return data, nil
	}
	return out, nil
}

func (t *telnyx) createBrand(ctx context.Context, body map[string]any) (map[string]any, error) {
	if t.webhookURL != "" {
		body["webhookURL"] = t.webhookURL
	}
	return t.tenDLC(ctx, http.MethodPost, "/10dlc/brand", body)
}
func (t *telnyx) getBrand(ctx context.Context, id string) (map[string]any, error) {
	return t.tenDLC(ctx, http.MethodGet, "/10dlc/brand/"+id, nil)
}
func (t *telnyx) createCampaign(ctx context.Context, body map[string]any) (map[string]any, error) {
	if t.webhookURL != "" {
		body["webhookURL"] = t.webhookURL
	}
	return t.tenDLC(ctx, http.MethodPost, "/10dlc/campaignBuilder", body)
}
func (t *telnyx) getCampaign(ctx context.Context, id string) (map[string]any, error) {
	return t.tenDLC(ctx, http.MethodGet, "/10dlc/campaign/"+id, nil)
}
func (t *telnyx) assignNumber(ctx context.Context, phone, campaign string) error {
	_, err := t.tenDLC(ctx, http.MethodPost, "/10dlc/phone_number_campaigns", map[string]any{"phoneNumber": phone, "campaignId": campaign})
	return err
}

var (
	brandVerified    = []string{"VERIFIED", "VETTED_VERIFIED"}
	campaignLive     = "MNO_PROVISIONED"
	campaignFailures = []string{"TCR_FAILED", "TCR_SUSPENDED", "TCR_EXPIRED", "TELNYX_FAILED", "MNO_REJECTED", "MNO_PROVISIONING_FAILED"}
	entityTypes      = []string{"PRIVATE_PROFIT", "PUBLIC_PROFIT", "NON_PROFIT", "SOLE_PROPRIETOR"}
	usStates         = regexp.MustCompile(`^[A-Z]{2}$`)
	einPattern       = regexp.MustCompile(`^\d{2}-?\d{7}$`)
)

// business is what the owner enters about the agency (D268).
type business struct {
	EntityType  string `json:"entity_type"`
	LegalName   string `json:"legal_name"`
	DisplayName string `json:"display_name"`
	EIN         string `json:"ein"`
	FirstName   string `json:"first_name"`
	LastName    string `json:"last_name"`
	Email       string `json:"email"`
	Phone       string `json:"phone"`
	Street      string `json:"street"`
	City        string `json:"city"`
	State       string `json:"state"`
	PostalCode  string `json:"postal_code"`
	Website     string `json:"website"`
}

// campaignWords are what the carriers read about how the agency texts; defaults are filled in for real estate. *For the lawyer.*
type campaignWords struct {
	Description string `json:"description"`
	MessageFlow string `json:"message_flow"`
	Sample1     string `json:"sample1"`
	Sample2     string `json:"sample2"`
	PrivacyLink string `json:"privacy_link"`
	TermsLink   string `json:"terms_link"`
}

func (w *campaignWords) fill(name string) {
	if w.Description == "" {
		w.Description = name + " is a real estate agency. It texts homeowners and buyers who agreed to be texted about selling or buying property: replies to their questions, appointment times and offers."
	}
	if w.MessageFlow == "" {
		w.MessageFlow = "People agree to texts by ticking an unticked box on " + name + "'s website form, by texting the agency first, or by saying yes on a recorded call, which the agent confirms by text. Each first text names the agency and says Reply STOP to opt out."
	}
	if w.Sample1 == "" {
		w.Sample1 = "Hi {name}, this is {agent} with " + name + ". Thanks for your interest in selling 12 Oak St. Is Tuesday at 4 a good time to talk? Reply STOP to opt out."
	}
	if w.Sample2 == "" {
		w.Sample2 = name + ": your appointment with {agent} is confirmed for Thursday at 10am. Reply HELP for help or STOP to opt out."
	}
}

func (b business) check() error {
	if !slices.Contains(entityTypes, b.EntityType) {
		return bad("entity_type is PRIVATE_PROFIT, PUBLIC_PROFIT, NON_PROFIT or SOLE_PROPRIETOR.")
	}
	if strings.TrimSpace(b.DisplayName) == "" || len(b.DisplayName) > 100 {
		return bad("Give the name people know the agency by (display_name).")
	}
	if b.EntityType == "SOLE_PROPRIETOR" {
		if strings.TrimSpace(b.FirstName) == "" || strings.TrimSpace(b.LastName) == "" {
			return bad("A sole proprietor gives their first and last name.")
		}
	} else {
		if strings.TrimSpace(b.LegalName) == "" {
			return bad("Give the business's legal name, as on its tax registration (legal_name).")
		}
		if !einPattern.MatchString(strings.TrimSpace(b.EIN)) {
			return bad("Give the business's EIN, like 12-3456789.")
		}
	}
	if !strings.Contains(b.Email, "@") || e164(b.Phone) == "" || strings.TrimSpace(b.Street) == "" || strings.TrimSpace(b.City) == "" ||
		!usStates.MatchString(strings.ToUpper(strings.TrimSpace(b.State))) || strings.TrimSpace(b.PostalCode) == "" {
		return bad("Give the business's email, phone, street, city, two-letter state and ZIP code.")
	}
	return nil
}

func (b business) brandBody() map[string]any {
	body := map[string]any{"entityType": b.EntityType, "displayName": strings.TrimSpace(b.DisplayName), "country": "US", "email": b.Email,
		"vertical": "REAL_ESTATE", "phone": e164(b.Phone), "street": b.Street, "city": b.City, "state": strings.ToUpper(strings.TrimSpace(b.State)),
		"postalCode": b.PostalCode}
	if b.EntityType == "SOLE_PROPRIETOR" {
		body["firstName"], body["lastName"], body["mobilePhone"] = b.FirstName, b.LastName, e164(b.Phone)
	} else {
		body["companyName"], body["ein"] = b.LegalName, strings.ReplaceAll(strings.TrimSpace(b.EIN), "-", "")
	}
	if b.EntityType == "PUBLIC_PROFIT" {
		body["businessContactEmail"] = b.Email
	}
	if b.Website != "" {
		body["website"] = b.Website
	}
	return body
}

type registration struct {
	Business       business      `json:"business"`
	Campaign       campaignWords `json:"campaign"`
	BrandID        *string       `json:"brand_id"`
	BrandIdentity  string        `json:"brand_identity"`
	BrandStatus    string        `json:"brand_status"`
	BrandFailure   string        `json:"brand_failure"`
	CampaignID     *string       `json:"campaign_id"`
	CampaignStatus string        `json:"campaign_status"`
	CampaignFail   string        `json:"campaign_failure"`
	SubmittedAt    *time.Time    `json:"submitted_at"`
}

func (s *server) loadRegistration(ctx context.Context, org string) (*registration, error) {
	var r registration
	var biz, words []byte
	err := s.st.db.QueryRow(ctx, `SELECT business, campaign, brand_id, brand_identity, brand_status, brand_failure, campaign_id, campaign_status, campaign_failure, submitted_at
		FROM carrier_registrations WHERE org_id = $1`, org).Scan(&biz, &words, &r.BrandID, &r.BrandIdentity, &r.BrandStatus, &r.BrandFailure, &r.CampaignID, &r.CampaignStatus, &r.CampaignFail, &r.SubmittedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return &registration{}, nil
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(biz, &r.Business)
	_ = json.Unmarshal(words, &r.Campaign)
	return &r, nil
}

func (r *registration) mayCall() bool { return slices.Contains(brandVerified, r.BrandIdentity) }
func (r *registration) mayText() bool { return r.mayCall() && r.CampaignStatus == campaignLive }

// state is what the owner sees: where the registration is, in words.
func (r *registration) state() string {
	switch {
	case r.BrandID == nil:
		return "not_submitted"
	case r.BrandStatus == "REGISTRATION_FAILED" || r.BrandIdentity == "UNVERIFIED" && r.BrandFailure != "":
		return "brand_failed"
	case !r.mayCall():
		return "brand_pending"
	case slices.Contains(campaignFailures, r.CampaignStatus):
		return "campaign_failed"
	case !r.mayText():
		return "campaign_pending"
	default:
		return "approved"
	}
}

// callingAllowed is the carrier check before a call (D314).
func (s *server) callingAllowed(ctx context.Context, org string) error {
	if !s.cfg.carrierCheck {
		return nil
	}
	r, err := s.loadRegistration(ctx, org)
	if err != nil {
		return err
	}
	if !r.mayCall() {
		return &apiError{http.StatusForbidden, "carrier_check", "Calling opens once the carriers verify the agency's business. The owner submits it under Settings → Carrier registration."}
	}
	return nil
}

// textingAllowed is the carrier check and the agency's texting standing before a text (D268, D269, D314). A bulk text is refused
// while texting is limited.
func (s *server) textingAllowed(ctx context.Context, org string, bulk bool) error {
	if s.cfg.carrierCheck {
		r, err := s.loadRegistration(ctx, org)
		if err != nil {
			return err
		}
		if !r.mayText() {
			return &apiError{http.StatusForbidden, "carrier_check", "Texting opens once the carriers approve the agency's texting registration. The owner submits it under Settings → Carrier registration."}
		}
	}
	var step string
	err := s.st.db.QueryRow(ctx, `SELECT step FROM texting_standing WHERE org_id = $1`, org).Scan(&step)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	switch step {
	case "suspended":
		return &apiError{http.StatusForbidden, "texting_suspended", "Texting is suspended for this agency after too many opt-outs or complaints, until Caller Whale reviews it. The owner can appeal."}
	case "limited":
		if bulk {
			return &apiError{http.StatusForbidden, "texting_limited", "Texting is limited for this agency after many opt-outs or complaints: one text to many leads is off for now."}
		}
		var today int
		if err := s.st.db.QueryRow(ctx, `SELECT count(*) FROM sms_messages WHERE org_id = $1 AND direction = 'outgoing' AND created_at > now() - interval '1 day'`, org).Scan(&today); err != nil {
			return err
		}
		if today >= limitedTextsPerDay {
			return &apiError{http.StatusTooManyRequests, "texting_limited", "Texting is limited for this agency after many opt-outs or complaints: the day's texts are used up."}
		}
	}
	return nil
}

// ---- the owner's side ----

func (s *server) carrierRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/carrier", s.member(s.getCarrier))
	mux.Handle("PUT /api/v1/carrier", s.member(s.putCarrier))
	mux.Handle("POST /api/v1/carrier/submit", s.member(s.submitCarrier))
	mux.Handle("POST /api/v1/carrier/appeal", s.member(s.appealTexting))
}

func isOwner(sc scope) bool {
	return slices.ContainsFunc(sc.roles, func(r string) bool { return r == "owner" || r == "solo" })
}

// getCarrier is GET /api/v1/carrier: the registration, whether calling and texting are open, and the texting standing.
func (s *server) getCarrier(q *req) error {
	if !q.sc.runsAgency() {
		return forbidden("The owner and admins see the agency's carrier registration.")
	}
	ctx := q.r.Context()
	r, err := s.loadRegistration(ctx, q.sc.orgID)
	if err != nil {
		return err
	}
	standing, err := s.standingOf(ctx, q.sc.orgID)
	if err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"registration": r, "state": r.state(), "check_required": s.cfg.carrierCheck,
		"may_call": !s.cfg.carrierCheck || r.mayCall(), "may_text": !s.cfg.carrierCheck || r.mayText(), "texting": standing,
		"thresholds": thresholds})
	return nil
}

// putCarrier is PUT /api/v1/carrier {business, campaign}: the owner or an admin enters the details; they are checked on submit.
func (s *server) putCarrier(q *req) error {
	if !q.sc.runsAgency() {
		return forbidden("The owner and admins enter the agency's business details.")
	}
	var body struct {
		Business business      `json:"business"`
		Campaign campaignWords `json:"campaign"`
	}
	if err := readJSON(q.w, q.r, &body); err != nil {
		return err
	}
	ctx := q.r.Context()
	r, err := s.loadRegistration(ctx, q.sc.orgID)
	if err != nil {
		return err
	}
	if st := r.state(); st != "not_submitted" && st != "brand_failed" && st != "campaign_failed" {
		return conflictErr("The registration is with the carriers; it can be changed if they turn it down.")
	}
	biz, _ := json.Marshal(body.Business)
	words, _ := json.Marshal(body.Campaign)
	_, err = s.st.db.Exec(ctx, `INSERT INTO carrier_registrations (org_id, business, campaign) VALUES ($1, $2, $3)
		ON CONFLICT (org_id) DO UPDATE SET business = EXCLUDED.business, campaign = EXCLUDED.campaign, updated_at = now()`, q.sc.orgID, biz, words)
	if err != nil {
		return err
	}
	writeJSON(q.w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// submitCarrier is POST /api/v1/carrier/submit: the owner sends the agency's brand to the carriers; its campaign follows once the
// brand is verified. After a refusal it sends what failed again.
func (s *server) submitCarrier(q *req) error {
	if !isOwner(q.sc) {
		return forbidden("The owner submits the agency's carrier registration.")
	}
	ctx := q.r.Context()
	r, err := s.loadRegistration(ctx, q.sc.orgID)
	if err != nil {
		return err
	}
	if err := r.Business.check(); err != nil {
		return err
	}
	switch r.state() {
	case "not_submitted", "brand_failed":
		brand, err := s.reg.createBrand(ctx, r.Business.brandBody())
		if err != nil {
			log.Printf("WARN brand registration for %s: %v", q.sc.orgID, err)
			return &apiError{http.StatusBadGateway, "carrier", "The carrier did not take the registration: " + carrierDetail(err)}
		}
		if _, err := s.st.db.Exec(ctx, `UPDATE carrier_registrations SET brand_id = $2, brand_identity = $3, brand_status = $4, brand_failure = $5,
			campaign_id = NULL, campaign_status = '', campaign_failure = '', submitted_by = $6, submitted_at = now(), checked_at = now(), updated_at = now() WHERE org_id = $1`,
			q.sc.orgID, str(brand, "brandId"), str(brand, "identityStatus"), str(brand, "status"), str(brand, "failureReasons"), q.sc.userID); err != nil {
			return err
		}
	case "campaign_failed":
		if _, err := s.st.db.Exec(ctx, `UPDATE carrier_registrations SET campaign_id = NULL, campaign_status = '', campaign_failure = '', updated_at = now() WHERE org_id = $1`, q.sc.orgID); err != nil {
			return err
		}
	default:
		return conflictErr("The registration is already with the carriers.")
	}
	if err := s.advanceRegistration(ctx, q.sc.orgID); err != nil {
		log.Printf("WARN registration of %s: %v", q.sc.orgID, err)
	}
	return s.getCarrier(q)
}

// carrierDetail is the carrier's reason, without our own wording around it.
func carrierDetail(err error) string {
	msg := err.Error()
	if i := strings.LastIndex(msg, ": "); i >= 0 {
		return msg[i+2:]
	}
	return msg
}

// advanceRegistration reads the brand and campaign again and takes the next step: the campaign once the brand is verified, the
// agency's texting numbers once the campaign is provisioned. The standing is then told to the CRM.
func (s *server) advanceRegistration(ctx context.Context, org string) error {
	r, err := s.loadRegistration(ctx, org)
	if err != nil || r.BrandID == nil {
		return err
	}
	if !r.mayCall() && r.BrandStatus != "REGISTRATION_FAILED" {
		brand, err := s.reg.getBrand(ctx, *r.BrandID)
		if err != nil {
			return err
		}
		r.BrandIdentity, r.BrandStatus, r.BrandFailure = str(brand, "identityStatus"), str(brand, "status"), str(brand, "failureReasons")
		if _, err := s.st.db.Exec(ctx, `UPDATE carrier_registrations SET brand_identity = $2, brand_status = $3, brand_failure = $4, checked_at = now(), updated_at = now() WHERE org_id = $1`,
			org, r.BrandIdentity, r.BrandStatus, r.BrandFailure); err != nil {
			return err
		}
	}
	if r.mayCall() && r.CampaignID == nil {
		r.Campaign.fill(r.Business.DisplayName)
		body := map[string]any{"brandId": *r.BrandID, "usecase": "MIXED", "description": r.Campaign.Description, "messageFlow": r.Campaign.MessageFlow,
			"sample1": r.Campaign.Sample1, "sample2": r.Campaign.Sample2, "subscriberOptin": true, "subscriberOptout": true, "subscriberHelp": true,
			"optinKeywords": "START,YES", "optoutKeywords": "STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT", "helpKeywords": "HELP,INFO",
			"optoutMessage": r.Business.DisplayName + ": you will not get more texts from us. Reply START to text again.",
			"helpMessage":   r.Business.DisplayName + ": reply STOP to opt out. Questions: " + r.Business.Email + ".",
			"embeddedLink":  false, "embeddedPhone": false, "numberPool": false, "ageGated": false, "directLending": false, "termsAndConditions": true}
		if r.Business.EntityType == "SOLE_PROPRIETOR" {
			body["usecase"] = "SOLE_PROPRIETOR"
		}
		if r.Campaign.PrivacyLink != "" {
			body["privacyPolicyLink"] = r.Campaign.PrivacyLink
		}
		if r.Campaign.TermsLink != "" {
			body["termsAndConditionsLink"] = r.Campaign.TermsLink
		}
		campaign, err := s.reg.createCampaign(ctx, body)
		if err != nil {
			_, _ = s.st.db.Exec(ctx, `UPDATE carrier_registrations SET campaign_status = 'TELNYX_FAILED', campaign_failure = $2, updated_at = now() WHERE org_id = $1`, org, carrierDetail(err))
			return err
		}
		id := str(campaign, "campaignId")
		r.CampaignID, r.CampaignStatus = &id, str(campaign, "campaignStatus")
		if _, err := s.st.db.Exec(ctx, `UPDATE carrier_registrations SET campaign_id = $2, campaign_status = $3, campaign = $4, updated_at = now() WHERE org_id = $1`,
			org, id, r.CampaignStatus, mustJSON(r.Campaign)); err != nil {
			return err
		}
	} else if r.CampaignID != nil && !r.mayText() && !slices.Contains(campaignFailures, r.CampaignStatus) {
		campaign, err := s.reg.getCampaign(ctx, *r.CampaignID)
		if err != nil {
			return err
		}
		r.CampaignStatus = str(campaign, "campaignStatus")
		if _, err := s.st.db.Exec(ctx, `UPDATE carrier_registrations SET campaign_status = $2, checked_at = now(), updated_at = now() WHERE org_id = $1`, org, r.CampaignStatus); err != nil {
			return err
		}
	}
	if r.mayText() {
		s.assignNumbers(ctx, org, *r.CampaignID)
	}
	s.tellCRM(ctx, org)
	return nil
}

// assignNumbers puts the agency's texting numbers on its campaign.
func (s *server) assignNumbers(ctx context.Context, org, campaign string) {
	rows, err := s.st.db.Query(ctx, `SELECT phone_number FROM numbers WHERE org_id = $1 AND texts AND campaign_status NOT IN ('ADDED', 'ASSIGNED')`, org)
	if err != nil {
		return
	}
	phones, _ := pgx.CollectRows(rows, pgx.RowTo[string])
	for _, p := range phones {
		status := "ASSIGNED"
		if err := s.reg.assignNumber(ctx, p, campaign); err != nil {
			log.Printf("WARN putting %s on the campaign: %v", maskNumber(p), err)
			status = "FAILED"
		}
		_, _ = s.st.db.Exec(ctx, `UPDATE numbers SET campaign_status = $2 WHERE phone_number = $1`, p, status)
	}
}

// registrationEvent is a 10dlc.* webhook: the registration it is about is read again.
func (s *server) registrationEvent(ctx context.Context, ev event) error {
	var org string
	brand, campaign := ev.str("brandId"), ev.str("campaignId")
	err := s.st.db.QueryRow(ctx, `SELECT org_id::text FROM carrier_registrations WHERE (brand_id = $1 AND $1 <> '') OR (campaign_id = $2 AND $2 <> '')`, brand, campaign).Scan(&org)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if ev.EventType == "10dlc.phone_number.update" {
		if phone, status := e164(ev.str("phoneNumber")), ev.str("status"); phone != "" && status != "" {
			_, _ = s.st.db.Exec(ctx, `UPDATE numbers SET campaign_status = $2 WHERE phone_number = $1 AND org_id = $3`, phone, strings.ToUpper(status), org)
		}
	}
	return s.advanceRegistration(ctx, org)
}

// advanceAll checks every registration still on its way, in case a webhook was missed.
func (s *server) advanceAll(ctx context.Context) {
	rows, err := s.st.db.Query(ctx, `SELECT org_id::text FROM carrier_registrations WHERE brand_id IS NOT NULL
		AND NOT (campaign_status = $1 OR campaign_status = ANY($2) OR brand_status = 'REGISTRATION_FAILED')
		AND (checked_at IS NULL OR checked_at < now() - interval '10 minutes')`, campaignLive, campaignFailures)
	if err != nil {
		log.Printf("WARN registrations: %v", err)
		return
	}
	orgs, _ := pgx.CollectRows(rows, pgx.RowTo[string])
	for _, org := range orgs {
		if err := s.advanceRegistration(ctx, org); err != nil {
			log.Printf("WARN registration of %s: %v", org, err)
		}
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
