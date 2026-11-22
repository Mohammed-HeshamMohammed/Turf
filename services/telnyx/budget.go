package telnyx

// Build step 22: budgets. Before a call or a text the dialer asks billing whether the lead's team, the person and the lead's client
// still have budget (and the agency its allowance); after it, it charges the call's minutes or the text to them, whoever made it
// (D120, D122, D135). A budget used up stops those paid actions for the people under it, who can ask for more (D123). Replies from
// leads are never charged. Without BILLING_URL nothing is limited.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"slices"
	"time"
)

// budgets is what the dialer asks billing about usage and budgets.
type budgets interface {
	use(ctx context.Context, ask usageAsk) error
	setBudget(ctx context.Context, org string, b budgetSet) error
	list(ctx context.Context, org string) (map[string]any, error)
	askRaise(ctx context.Context, org string, r raiseAsk) (string, error)
}

type usageAsk struct {
	OrgID     string  `json:"org_id"`
	Kind      string  `json:"kind"`
	Amount    int     `json:"amount"`
	RequestID string  `json:"request_id"`
	TeamID    *string `json:"team_id"`
	UserID    *string `json:"user_id"`
	ClientID  *string `json:"client_id"`
	CheckOnly bool    `json:"check_only"`
}

type budgetSet struct {
	Scope     string `json:"scope"`
	SubjectID string `json:"subject_id"`
	Kind      string `json:"kind"`
	Monthly   *int   `json:"monthly"`
	SetBy     string `json:"set_by"`
}

type raiseAsk struct {
	Scope     string `json:"scope"`
	SubjectID string `json:"subject_id"`
	Kind      string `json:"kind"`
	AskedBy   string `json:"asked_by"`
	Note      string `json:"note"`
}

type billingClient struct {
	base, token string
	http        *http.Client
}

func (b *billingClient) call(ctx context.Context, method, path string, body, into any) error {
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, b.base+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+b.token)
	req.Header.Set("Content-Type", "application/json")
	res, err := b.http.Do(req)
	if err != nil {
		return &apiError{http.StatusServiceUnavailable, "billing_unavailable", "Budgets cannot be checked right now. Try again in a moment."}
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode >= 300 {
		var refused struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(data, &refused)
		if refused.Error.Code == "" {
			return fmt.Errorf("billing answered %d", res.StatusCode)
		}
		return &apiError{res.StatusCode, refused.Error.Code, refused.Error.Message}
	}
	if into != nil {
		return json.Unmarshal(data, into)
	}
	return nil
}

func (b *billingClient) use(ctx context.Context, ask usageAsk) error {
	return b.call(ctx, http.MethodPost, "/v1/usage", ask, nil)
}
func (b *billingClient) setBudget(ctx context.Context, org string, s budgetSet) error {
	return b.call(ctx, http.MethodPut, "/v1/orgs/"+url.PathEscape(org)+"/budgets", s, nil)
}
func (b *billingClient) list(ctx context.Context, org string) (map[string]any, error) {
	var out map[string]any
	return out, b.call(ctx, http.MethodGet, "/v1/orgs/"+url.PathEscape(org)+"/budgets", nil, &out)
}
func (b *billingClient) askRaise(ctx context.Context, org string, r raiseAsk) (string, error) {
	var out struct {
		ID string `json:"id"`
	}
	return out.ID, b.call(ctx, http.MethodPost, "/v1/orgs/"+url.PathEscape(org)+"/raise-requests", r, &out)
}

func optional(id string) *string {
	if id == "" {
		return nil
	}
	return &id
}

// mayUse asks billing whether one more of this kind is within every budget the lead's use falls under.
func (s *server) mayUse(ctx context.Context, org, user string, lead leadInfo, kind string) error {
	if s.budget == nil {
		return nil
	}
	return s.budget.use(ctx, usageAsk{OrgID: org, Kind: kind, Amount: 1, RequestID: newUUID(), TeamID: optional(lead.TeamID), UserID: optional(user), ClientID: optional(lead.ClientID), CheckOnly: true})
}

// charge records a use once (the request id is the call's or the text's own). A failure is logged: the call or text already happened.
func (s *server) charge(ctx context.Context, org, user string, lead leadInfo, kind string, amount int, request string) {
	if s.budget == nil || amount <= 0 {
		return
	}
	if err := s.budget.use(ctx, usageAsk{OrgID: org, Kind: kind, Amount: amount, RequestID: request, TeamID: optional(lead.TeamID), UserID: optional(user), ClientID: optional(lead.ClientID)}); err != nil {
		log.Printf("WARN charging %s %s %d: %v", kind, request, amount, err)
	}
}

// chargeCall charges a finished call's talk time, rounded up to the minute, to the lead's team and the person who called.
func (s *server) chargeCall(ctx context.Context, c *callRow) {
	if s.budget == nil || c.AnsweredAt == nil || c.EndedAt == nil || c.LeadID == nil {
		return
	}
	minutes := int(math.Ceil(c.EndedAt.Sub(*c.AnsweredAt).Minutes()))
	lead, err := s.crm.lead(ctx, c.OrgID, c.UserID, *c.LeadID)
	if err != nil {
		lead = leadInfo{}
	}
	s.charge(ctx, c.OrgID, c.UserID, lead, "minutes", max(minutes, 1), c.ID)
}

// putBudget is PUT /api/v1/budgets {scope, subject_id, kind, monthly}: the owner and admins set a team's or a client's budget and
// anyone's limit; a team's lead sets limits for the people of their team (D120, D121, D135). monthly null removes it.
func (s *server) putBudget(ctx context.Context, sc scope, b budgetSet) error {
	if s.budget == nil {
		return &apiError{http.StatusServiceUnavailable, "budgets_off", "Budgets are not set up on this server."}
	}
	if !validID(b.SubjectID) {
		return bad("Choose whose budget this is (subject_id).")
	}
	allowed := sc.runsAgency()
	if !allowed && b.Scope == "person" && len(sc.managed) > 0 {
		g, err := s.rules.grant(ctx, b.SubjectID, sc.orgID, false)
		if err != nil {
			return err
		}
		allowed = g.Allowed && slices.ContainsFunc(g.TeamIDs, func(t string) bool { return slices.Contains(sc.managed, t) })
	}
	if !allowed {
		return forbidden("The owner and admins set budgets; a team lead sets limits for the people of their team.")
	}
	b.SetBy = sc.userID
	return s.budget.setBudget(ctx, sc.orgID, b)
}

// budgetList is GET /api/v1/budgets: the agency's budgets with this month's use and the requests to raise them (owner, admins, leads).
func (s *server) budgetList(ctx context.Context, sc scope) (map[string]any, error) {
	if s.budget == nil {
		return map[string]any{"budgets": []any{}, "raise_requests": []any{}}, nil
	}
	if !sc.runsAgency() && len(sc.managed) == 0 {
		return nil, forbidden("The owner, admins and team leads see the budgets.")
	}
	return s.budget.list(ctx, sc.orgID)
}

// askForMore is POST /api/v1/budgets/raise {scope, subject_id, kind, note}: anyone stopped by a budget asks the people who set it
// (D123). A person's own limit is theirs to ask about; a team's or client's, any of its people.
func (s *server) askForMore(ctx context.Context, sc scope, r raiseAsk) (string, error) {
	if s.budget == nil {
		return "", &apiError{http.StatusServiceUnavailable, "budgets_off", "Budgets are not set up on this server."}
	}
	if r.Scope == "person" {
		r.SubjectID = sc.userID
	}
	if !validID(r.SubjectID) {
		return "", bad("Choose the budget to raise.")
	}
	r.AskedBy = sc.userID
	return s.budget.askRaise(ctx, sc.orgID, r)
}

var _ = time.Second
