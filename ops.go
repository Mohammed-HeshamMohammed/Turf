package main

// CRM changes as operations. Online requests and offline queues both come here, so deduplication, permission checks,
// conflict rules and the audit trail are the same for every path.
//
// Each operation carries a client-chosen id; a replay returns the first answer with status "duplicate". Edits to existing
// records carry the values the client edited from (`base`): a field applies when the server still holds the base value, or
// already holds the new one; otherwise the operation is a conflict and nothing in it applies. Client clocks never decide.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type op struct {
	ID            string         `json:"id"`
	Kind          string         `json:"kind"`
	Payload       map[string]any `json:"payload"`
	ClaimedAt     *time.Time     `json:"claimed_at"`
	QueuedOffline bool           `json:"queued_offline"`
	DeviceID      string         `json:"device_id"`
	// internal is set only for operations sent by another Caller Whale service over the private network (dialer.go), never
	// from a device's request body: it allows the carrier's own fields on a call (details, recording, record id).
	internal bool
}

type opResult struct {
	ID             string `json:"id"`
	Status         string `json:"status"` // applied, duplicate, rejected or conflict
	OriginalStatus string `json:"original_status,omitempty"`
	Result         any    `json:"result,omitempty"`
	Message        string `json:"message,omitempty"`
}

// rejection stops an operation with a sentence for the person; conflict stops it with the fields that moved.
type rejection string

func (r rejection) Error() string { return string(r) }

type conflict map[string]any

func (conflict) Error() string { return "conflict" }

func reject(format string, a ...any) error { return rejection(fmt.Sprintf(format, a...)) }

// Changes that alter ownership, permissions or many records are never accepted from an offline queue.
var onlineOnly = []string{"lead.assign", "lead.claim", "lead.delete", "lead.share", "handoff.decide", "task.delete", "deal.delete", "note.delete"}

var (
	leadStages = []string{"New", "Contacted", "Interested", "Qualified", "Closed"}
	dealStages = []string{"Qualified", "Appointment", "Offer preparation", "Offer sent", "Negotiation", "Under contract", "Closed won", "Closed lost"}
)

type outcome struct {
	label, code, meaning string
	recallDays           int // days until the next try; 0 for none
}

var outcomes = []outcome{
	{"Transfer", "Trans", "reached", 0}, {"Callback", "CB", "reached", 0}, {"Not interested", "NI", "reached", 90},
	{"Language barrier", "Lang", "reached", 0}, {"Reached", "R", "reached", 0}, {"Voicemail", "VM", "voicemail", 1},
	{"Not available", "NA", "no_answer", 1}, {"No answer", "NoA", "no_answer", 1}, {"Dead call", "Dead", "no_answer", 1},
	{"Wrong number", "W#", "wrong_number", 0}, {"Wrong person", "WP", "wrong_person", 0}, {"Disconnected", "Disc", "disconnected", 0},
	{"Do not call", "DNC", "do_not_call", 0},
}

func findOutcome(label string) *outcome {
	label = strings.ToLower(strings.TrimSpace(label))
	for i := range outcomes {
		if strings.ToLower(outcomes[i].label) == label || strings.ToLower(outcomes[i].code) == label {
			return &outcomes[i]
		}
	}
	return nil
}

// run is one operation in flight: the person, the open transaction and what is being applied.
type run struct {
	s   *server
	ctx context.Context
	sc  scope
	tx  pgx.Tx
	op  op
}

func (s *server) apply(ctx context.Context, sc scope, o op) (opResult, error) {
	if !validID(o.ID) {
		return opResult{ID: o.ID, Status: "rejected", Message: "An operation needs an id."}, nil
	}
	if o.Payload == nil {
		o.Payload = map[string]any{}
	}
	tx, err := s.st.begin(ctx, sc)
	if err != nil {
		return opResult{}, err
	}
	defer tx.Rollback(ctx)
	var inserted string
	err = tx.QueryRow(ctx, `INSERT INTO operations (id, org_id, user_id, device_id, kind, payload, status, claimed_at)
		VALUES ($1, cw_org(), $2, $3, $4, $5, 'applied', $6) ON CONFLICT (id) DO NOTHING RETURNING id::text`,
		o.ID, sc.userID, o.DeviceID, o.Kind, o.Payload, o.ClaimedAt).Scan(&inserted)
	if errors.Is(err, pgx.ErrNoRows) {
		var status string
		var result any
		var owner string
		err = tx.QueryRow(ctx, `SELECT status, result, user_id::text FROM operations WHERE id = $1`, o.ID).Scan(&status, &result, &owner)
		if err != nil || owner != sc.userID {
			// An id from another person or workspace is never revealed.
			return opResult{ID: o.ID, Status: "rejected", Message: "That operation id is already used"}, nil
		}
		return opResult{ID: o.ID, Status: "duplicate", OriginalStatus: status, Result: result}, nil
	}
	if err != nil {
		return opResult{}, err
	}
	var answer opResult
	if o.QueuedOffline && slices.Contains(onlineOnly, o.Kind) {
		answer = opResult{ID: o.ID, Status: "rejected", Message: "This change needs a connection; it was not applied"}
	} else {
		answer, err = s.runInner(ctx, tx, sc, o)
		if err != nil {
			return opResult{}, err
		}
	}
	stored := answer.Result
	if stored == nil {
		stored = map[string]any{"message": answer.Message}
	}
	if _, err = tx.Exec(ctx, `UPDATE operations SET status = $2, result = $3 WHERE id = $1`, o.ID, answer.Status, stored); err != nil {
		return opResult{}, err
	}
	return answer, tx.Commit(ctx)
}

// runInner applies the change inside a savepoint: a refusal undoes all of it and leaves the operation's own record.
func (s *server) runInner(ctx context.Context, outer pgx.Tx, sc scope, o op) (opResult, error) {
	inner, err := outer.Begin(ctx)
	if err != nil {
		return opResult{}, err
	}
	r := &run{s: s, ctx: ctx, sc: sc, tx: inner, op: o}
	value, err := r.dispatch()
	var rej rejection
	var con conflict
	switch {
	case err == nil:
		if err = inner.Commit(ctx); err != nil {
			return opResult{}, err
		}
		return opResult{ID: o.ID, Status: "applied", Result: value}, nil
	case errors.As(err, &con):
		_ = inner.Rollback(ctx)
		return opResult{ID: o.ID, Status: "conflict", Result: map[string]any{"fields": map[string]any(con)}, Message: "Someone changed this since you edited it"}, nil
	case errors.As(err, &rej):
		_ = inner.Rollback(ctx)
		return opResult{ID: o.ID, Status: "rejected", Message: string(rej)}, nil
	default:
		_ = inner.Rollback(ctx)
		if ctx.Err() != nil {
			return opResult{}, ctx.Err()
		}
		log.Printf("ERROR operation %s (%s): %v", o.ID, o.Kind, err)
		return opResult{ID: o.ID, Status: "rejected", Message: "The server could not apply this change; try again"}, nil
	}
}

func (r *run) dispatch() (any, error) {
	p := r.op.Payload
	switch r.op.Kind {
	case "lead.create":
		return r.leadCreate(p)
	case "lead.update":
		return r.leadUpdate(p)
	case "lead.assign":
		return r.leadAssign(p)
	case "lead.claim":
		return r.leadClaim(p)
	case "lead.delete":
		return r.leadDelete(p)
	case "lead.archive":
		return r.leadArchive(p, true)
	case "lead.restore":
		return r.leadArchive(p, false)
	case "lead.share":
		return r.leadShare(p)
	case "note.add":
		return r.noteAdd(p)
	case "note.edit":
		return r.noteChange(p, false)
	case "note.delete":
		return r.noteChange(p, true)
	case "call.record":
		return r.callRecord(p)
	case "task.create":
		return r.taskCreate(p)
	case "task.update":
		return r.taskUpdate(p)
	case "task.complete":
		return r.taskComplete(p)
	case "task.delete":
		return r.taskDelete(p)
	case "handoff.request":
		return r.handoffRequest(p)
	case "handoff.decide":
		return r.handoffDecide(p)
	case "deal.create":
		return r.dealCreate(p)
	case "deal.update":
		return r.dealUpdate(p)
	case "deal.delete":
		return r.dealDelete(p)
	case "call.recording":
		if !r.op.internal {
			return nil, reject("Unknown operation kind: %s", r.op.Kind)
		}
		return r.callRecording(p)
	case "message.draft":
		return nil, reject("Messaging is not available yet")
	}
	return nil, reject("Unknown operation kind: %s", r.op.Kind)
}

// ------------------------------------------------------------------------------------------------------ helpers

// handTo answers whether the asking person may give work (a lead or a task) to someone: themself always; anyone else only with
// the assign capability, and then only the people they may give leads to (assignTargets: their teams, or everyone for the whole
// workspace). A request made by hand (the console) cannot reach past it.
func (r *run) handTo(to string) (assignTarget, error) {
	if to == r.sc.userID {
		return assignTarget{UserID: to}, nil
	}
	if !r.sc.can("assign") {
		return assignTarget{}, reject("You can only give this to yourself")
	}
	mine, err := r.s.rules.grant(r.ctx, r.sc.userID, r.sc.orgID, r.sc.secondStep)
	if err != nil {
		return assignTarget{}, err
	}
	targets, err := r.s.assignTargets(r.ctx, r.sc, mine.ManagedTeamIDs)
	if err != nil {
		return assignTarget{}, err
	}
	target, ok := targets[to]
	if !ok {
		return assignTarget{}, reject("You can give this only to the people you manage")
	}
	return target, nil
}

// teamAllowed answers whether a lead may be put in a team the request names: the receiver's own team, one of the asker's teams or the
// teams they run, or any team for someone who sees the whole workspace.
func (r *run) teamAllowed(team, receiverTeam string) error {
	if team == receiverTeam || slices.Contains(r.sc.scopes, "organization") || slices.Contains(r.sc.teamIDs, team) {
		return nil
	}
	mine, err := r.s.rules.grant(r.ctx, r.sc.userID, r.sc.orgID, r.sc.secondStep)
	if err != nil {
		return err
	}
	if slices.Contains(mine.ManagedTeamIDs, team) {
		return nil
	}
	return reject("That team is not one of yours")
}

func (r *run) need(capability string) error {
	if r.sc.can(capability) {
		return nil
	}
	return reject("Your role does not allow this (%s)", capability)
}

func str(p map[string]any, name string) string {
	s, _ := p[name].(string)
	return strings.TrimSpace(s)
}

func uuidField(p map[string]any, name string) (string, error) {
	s, _ := p[name].(string)
	if !validID(s) {
		return "", reject("%s is required", name)
	}
	return strings.ToLower(s), nil
}

func optUUID(p map[string]any, name string) (*string, error) {
	switch v := p[name].(type) {
	case nil:
		return nil, nil
	case string:
		if v == "" {
			return nil, nil
		}
		if validID(v) {
			v = strings.ToLower(v)
			return &v, nil
		}
	}
	return nil, reject("%s is not valid", name)
}

func optTime(p map[string]any, name string) (*time.Time, error) {
	switch v := p[name].(type) {
	case nil:
		return nil, nil
	case string:
		if v == "" {
			return nil, nil
		}
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			return &t, nil
		}
		return nil, reject("%s must be an RFC 3339 time with an offset", name)
	}
	return nil, reject("%s is not valid", name)
}

func uuidList(p map[string]any, name string) []string {
	out := []string{}
	list, _ := p[name].([]any)
	for _, v := range list {
		if s, ok := v.(string); ok && validID(s) {
			out = append(out, strings.ToLower(s))
		}
	}
	return out
}

func asString(v any) string { s, _ := v.(string); return s }

func isNull(v any) bool { return v == nil }

// one runs a query that returns at most one jsonb record; nil means no row.
func (r *run) one(sql string, args ...any) (map[string]any, error) {
	return queryOne(r.ctx, r.tx, sql, args...)
}

func queryOne(ctx context.Context, tx pgx.Tx, sql string, args ...any) (map[string]any, error) {
	var m map[string]any
	err := tx.QueryRow(ctx, sql, args...).Scan(&m)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return m, err
}

func queryJSON(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]json.RawMessage, error) {
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []json.RawMessage{}
	for rows.Next() {
		var raw json.RawMessage
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		out = append(out, raw)
	}
	return out, rows.Err()
}

func (r *run) exec(sql string, args ...any) error {
	_, err := r.tx.Exec(r.ctx, sql, args...)
	return err
}

// lead is a lead as the person may see it, locked for update when asked; nil is missing or outside their scope.
func (r *run) lead(id string, lock bool) (map[string]any, error) {
	sql := `SELECT to_jsonb(l) FROM leads l WHERE l.id = $1 AND cw_visible_lead(l.id)`
	if lock {
		sql += ` FOR UPDATE`
	}
	return r.one(sql, id)
}

func (r *run) visibleLead(id string, lock bool) (map[string]any, error) {
	l, err := r.lead(id, lock)
	if err == nil && l == nil {
		err = reject("The lead was not found, was deleted, or is outside your access")
	}
	return l, err
}

// redactLead removes what the person may not read: values without "finance", internal fields for external clients.
func redactLead(lead map[string]any, sc scope) map[string]any {
	if !sc.can("finance") {
		delete(lead, "value_amount")
		delete(lead, "value_currency")
	}
	if sc.external() {
		for _, f := range []string{"qualification", "verdict", "source", "priority", "do_not_call", "team_id", "project_id", "contact_id"} {
			delete(lead, f)
		}
	}
	return lead
}

func canEditLead(sc scope, lead map[string]any) bool {
	for _, wide := range []string{"organization", "team", "project"} {
		if slices.Contains(sc.scopes, wide) {
			return true
		}
	}
	return asString(lead["assignee_id"]) == sc.userID
}

// change is one committed change: the audit trail, the pull feed and the live notification all come from it.
type change struct {
	entity, kind, id, leadID string
	before, after            any
	deleted                  bool
}

func (r *run) record(c change) error {
	var lead any
	if c.leadID != "" {
		lead = c.leadID
	}
	if err := r.exec(`INSERT INTO audit_events (org_id, actor_id, actor_label, entity, entity_id, action, before, after, operation_id, occurred_at)
		VALUES (cw_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`, r.sc.userID, r.sc.label, c.entity, c.id, c.kind, c.before, c.after, r.op.ID, r.op.ClaimedAt); err != nil {
		return err
	}
	verb := "upsert"
	if c.deleted {
		verb = "delete"
	}
	var seq int64
	if err := r.tx.QueryRow(r.ctx, `INSERT INTO change_log (org_id, entity, entity_id, lead_id, op) VALUES (cw_org(), $1, $2, $3, $4) RETURNING seq`,
		c.entity, c.id, lead, verb).Scan(&seq); err != nil {
		return err
	}
	return r.exec(`SELECT pg_notify('cw_events', jsonb_build_object('org_id', cw_org(), 'kind', $1::text, 'entity', $2::text, 'seq', $3::bigint)::text)`, c.kind, c.entity, seq)
}

// accessChanged tells every device in the workspace to start over from a fresh snapshot.
func (r *run) accessChanged() error {
	return r.exec(`SELECT pg_notify('cw_events', jsonb_build_object('org_id', cw_org(), 'kind', 'access.changed', 'entity', 'organization', 'seq', 0)::text)`)
}

// checkBase applies a versioned edit only over the values it was made from.
func checkBase(current, changes, base map[string]any) error {
	conflicts := conflict{}
	for field, local := range changes {
		server := current[field]
		if sameValue(server, local) {
			continue
		}
		if edited, ok := base[field]; ok && !sameValue(edited, server) {
			conflicts[field] = map[string]any{"local": local, "server": server, "base": edited}
		}
	}
	if len(conflicts) > 0 {
		return conflicts
	}
	return nil
}

// Numbers and times may come back from PostgreSQL spelled differently than the client sent them.
func sameValue(a, b any) bool {
	if a == nil && b == nil {
		return true
	}
	if x, y := asNumber(a), asNumber(b); x != nil && y != nil {
		return *x == *y
	}
	x, xs := a.(string)
	y, ys := b.(string)
	switch {
	case xs && ys:
		if tx, err := time.Parse(time.RFC3339, x); err == nil {
			if ty, err := time.Parse(time.RFC3339, y); err == nil {
				return tx.Equal(ty)
			}
		}
		return x == y
	case a == nil && ys:
		return y == ""
	case b == nil && xs:
		return x == ""
	}
	return false
}

func asNumber(v any) *float64 {
	switch n := v.(type) {
	case float64:
		return &n
	case string:
		if f, err := strconv.ParseFloat(n, 64); err == nil && !math.IsNaN(f) {
			return &f
		}
	}
	return nil
}

func merge(before, changes map[string]any) map[string]any {
	merged := make(map[string]any, len(before))
	for k, v := range before {
		merged[k] = v
	}
	for k, v := range changes {
		merged[k] = v
	}
	return merged
}

func objectField(p map[string]any, name string) map[string]any {
	m, _ := p[name].(map[string]any)
	if m == nil {
		m = map[string]any{}
	}
	return m
}

// ------------------------------------------------------------------------------------------------------- leads

var leadEditable = []string{"name", "phone", "email", "stage", "verdict", "next_action", "next_action_at", "next_action_tz", "priority", "qualification", "sent_to", "value_amount", "value_currency", "do_not_call", "source"}

func (r *run) leadCreate(p map[string]any) (any, error) {
	if err := r.need("edit"); err != nil {
		return nil, err
	}
	name := str(p, "name")
	if name == "" {
		return nil, reject("A lead needs a name")
	}
	id, err := optUUID(p, "id")
	if err != nil {
		return nil, err
	}
	newID := ""
	if id != nil {
		newID = *id
	}
	assignee, err := optUUID(p, "assignee_id")
	if err != nil {
		return nil, err
	}
	if assignee == nil {
		assignee = &r.sc.userID
	}
	receiver, err := r.handTo(*assignee)
	if err != nil {
		return nil, err
	}
	team, err := optUUID(p, "team_id")
	if err != nil {
		return nil, err
	}
	if team != nil {
		if err = r.teamAllowed(*team, receiver.TeamID); err != nil {
			return nil, err
		}
	}
	if team == nil && receiver.TeamID != "" {
		team = &receiver.TeamID
	}
	if team == nil && len(r.sc.teamIDs) > 0 && validID(r.sc.teamIDs[0]) {
		team = &r.sc.teamIDs[0]
	}
	project, err := optUUID(p, "project_id")
	if err != nil {
		return nil, err
	}
	stage := "New"
	if s, ok := p["stage"].(string); ok {
		stage = s
	}
	if !slices.Contains(leadStages, stage) {
		return nil, reject("%s is not a lead stage", stage)
	}
	var property *string
	if _, has := p["address"]; has || p["latitude"] != nil {
		lat, lon := asNumber(p["latitude"]), asNumber(p["longitude"])
		if lat == nil || lon == nil || math.Abs(*lat) > 90 || math.Abs(*lon) > 180 {
			lat, lon = nil, nil // a partial or invalid pair is no location
		}
		var pid string
		err = r.tx.QueryRow(r.ctx, `INSERT INTO properties (org_id, address, unit, city, region, postal_code, country, latitude, longitude, location_source)
			VALUES (cw_org(), $1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $7::float8 IS NULL THEN 'none' ELSE 'supplied' END) RETURNING id::text`,
			str(p, "address"), str(p, "unit"), str(p, "city"), str(p, "region"), str(p, "zip"), str(p, "country"), lat, lon).Scan(&pid)
		if err != nil {
			return nil, err
		}
		property = &pid
	}
	next, err := optTime(p, "next_action_at")
	if err != nil {
		return nil, err
	}
	source := str(p, "source")
	if source == "" {
		source = "Added manually"
	}
	var created string
	err = r.tx.QueryRow(r.ctx, `INSERT INTO leads (id, org_id, project_id, team_id, property_id, assignee_id, name, phone, email, stage, source, next_action_at, priority)
		VALUES (coalesce(nullif($1, '')::uuid, gen_random_uuid()), cw_org(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, coalesce(nullif($12, ''), 'Normal')) RETURNING id::text`,
		newID, project, team, property, assignee, name, str(p, "phone"), str(p, "email"), stage, source, next, str(p, "priority")).Scan(&created)
	if err != nil {
		return nil, err
	}
	after, err := r.visibleLead(created, false)
	if err != nil {
		return nil, err
	}
	if err = r.record(change{entity: "lead", kind: "lead.created", id: created, leadID: created, after: after}); err != nil {
		return nil, err
	}
	return redactLead(after, r.sc), nil
}

func (r *run) leadUpdate(p map[string]any) (any, error) {
	id, err := uuidField(p, "id")
	if err != nil {
		return nil, err
	}
	changes, base := objectField(p, "changes"), objectField(p, "base")
	if len(changes) == 0 {
		return nil, reject("Nothing to change")
	}
	if err = r.need("edit"); err != nil {
		return nil, err
	}
	for field := range changes {
		if !slices.Contains(leadEditable, field) {
			return nil, reject("%s cannot be changed this way", field)
		}
	}
	_, hasAmount := changes["value_amount"]
	_, hasCurrency := changes["value_currency"]
	if (hasAmount || hasCurrency) && !r.sc.can("finance") {
		return nil, reject("Changing values needs the finance permission")
	}
	before, err := r.visibleLead(id, true)
	if err != nil {
		return nil, err
	}
	if !canEditLead(r.sc, before) {
		return nil, reject("You can only edit leads assigned to you")
	}
	if changes["do_not_call"] == false && before["do_not_call"] == true && !r.sc.can("assign") {
		return nil, reject("Only a manager can lift a do-not-call")
	}
	if err = checkBase(before, changes, base); err != nil {
		return nil, err
	}
	if stage, ok := changes["stage"].(string); ok && !slices.Contains(leadStages, stage) {
		return nil, reject("%s is not a lead stage", stage)
	}
	err = r.exec(`UPDATE leads l SET (name, phone, email, stage, verdict, next_action, next_action_at, next_action_tz, priority, qualification, sent_to,
			value_amount, value_currency, do_not_call, source) =
		(SELECT x.name, x.phone, x.email, x.stage, x.verdict, x.next_action, x.next_action_at, x.next_action_tz, x.priority, x.qualification, x.sent_to,
			x.value_amount, x.value_currency, x.do_not_call, x.source FROM jsonb_populate_record(NULL::leads, $2::jsonb) x),
		version = l.version + 1, updated_at = now() WHERE l.id = $1`, id, merge(before, changes))
	if err != nil {
		return nil, err
	}
	after, err := r.visibleLead(id, false)
	if err != nil {
		return nil, err
	}
	kind := "lead.updated"
	if _, ok := changes["stage"]; ok && before["stage"] != after["stage"] {
		kind = "lead.stage_changed"
	}
	if err = r.record(change{entity: "lead", kind: kind, id: id, leadID: id, before: before, after: after}); err != nil {
		return nil, err
	}
	return redactLead(after, r.sc), nil
}

func (r *run) leadAssign(p map[string]any) (any, error) {
	if err := r.need("assign"); err != nil {
		return nil, err
	}
	ids := uuidList(p, "ids")
	if len(ids) == 0 || len(ids) > 5000 {
		return nil, reject("Choose between 1 and 5000 leads")
	}
	to, err := optUUID(p, "assignee_id")
	if err != nil {
		return nil, err
	}
	team, err := optUUID(p, "team_id")
	if err != nil {
		return nil, err
	}
	if to != nil {
		mine, err := r.s.rules.grant(r.ctx, r.sc.userID, r.sc.orgID, r.sc.secondStep)
		if err != nil {
			return nil, err
		}
		targets, err := r.s.assignTargets(r.ctx, r.sc, mine.ManagedTeamIDs)
		if err != nil {
			return nil, err
		}
		target, ok := targets[*to]
		if !ok {
			return nil, reject("You can give leads only to the people you manage")
		}
		if team == nil && target.TeamID != "" {
			team = &target.TeamID // the lead moves into the receiver's team, so their manager sees it
		}
	}
	if team != nil {
		receiverTeam := ""
		if to != nil {
			if t, err := r.handTo(*to); err == nil {
				receiverTeam = t.TeamID
			}
		}
		if err = r.teamAllowed(*team, receiverTeam); err != nil {
			return nil, err
		}
	}
	reason := str(p, "reason")
	for _, id := range ids {
		before, err := r.visibleLead(id, true)
		if err != nil {
			return nil, err
		}
		from, _ := before["assignee_id"].(string)
		// A lead moves between teams only for someone who runs both, or sees the whole workspace (D108).
		if current := asString(before["team_id"]); team != nil && current != "" && current != *team && !slices.Contains(r.sc.scopes, "organization") {
			mine, err := r.s.rules.grant(r.ctx, r.sc.userID, r.sc.orgID, r.sc.secondStep)
			if err != nil {
				return nil, err
			}
			if !slices.Contains(mine.ManagedTeamIDs, current) || !slices.Contains(mine.ManagedTeamIDs, *team) {
				return nil, reject("A team lead moves leads only between teams they lead")
			}
		}
		if err = r.exec(`UPDATE leads SET assignee_id = $2, team_id = coalesce($3, team_id), version = version + 1, updated_at = now() WHERE id = $1`, id, to, team); err != nil {
			return nil, err
		}
		if err = r.exec(`INSERT INTO assignments (org_id, lead_id, from_user, to_user, reason, actor_id) VALUES (cw_org(), $1, nullif($2, '')::uuid, $3, $4, $5)`, id, from, to, reason, r.sc.userID); err != nil {
			return nil, err
		}
		// Open tasks follow the lead to its new owner.
		open, err := queryJSON(r.ctx, r.tx, `UPDATE tasks SET assignee_id = $2, version = version + 1 WHERE lead_id = $1 AND done_at IS NULL AND assignee_id IS NOT DISTINCT FROM nullif($3, '')::uuid RETURNING jsonb_build_object('id', id)`, id, to, from)
		if err != nil {
			return nil, err
		}
		for _, t := range open {
			var m map[string]string
			_ = json.Unmarshal(t, &m)
			if err = r.record(change{entity: "task", kind: "task.updated", id: m["id"], leadID: id}); err != nil {
				return nil, err
			}
		}
		after, err := r.one(`SELECT to_jsonb(l) FROM leads l WHERE id = $1`, id)
		if err != nil {
			return nil, err
		}
		if err = r.record(change{entity: "lead", kind: "lead.assigned", id: id, leadID: id, before: before, after: after}); err != nil {
			return nil, err
		}
	}
	return map[string]any{"assigned": len(ids), "ids": ids}, nil
}

// leadArchive takes a lead out of everyday lists without removing anything; restoring brings it back as it was.
func (r *run) leadArchive(p map[string]any, archive bool) (any, error) {
	if err := r.need("edit"); err != nil {
		return nil, err
	}
	id, err := uuidField(p, "id")
	if err != nil {
		return nil, err
	}
	before, err := r.visibleLead(id, true)
	if err != nil {
		return nil, err
	}
	if !canEditLead(r.sc, before) {
		return nil, reject("You can only archive leads you can edit")
	}
	if isNull(before["archived_at"]) != archive {
		if archive {
			return nil, reject("This lead is already archived")
		}
		return nil, reject("This lead is not archived")
	}
	if err = r.exec(`UPDATE leads SET archived_at = CASE WHEN $2 THEN now() END, version = version + 1, updated_at = now() WHERE id = $1`, id, archive); err != nil {
		return nil, err
	}
	after, err := r.visibleLead(id, false)
	if err != nil {
		return nil, err
	}
	kind := "lead.restored"
	if archive {
		kind = "lead.archived"
	}
	if err = r.record(change{entity: "lead", kind: kind, id: id, leadID: id, before: before, after: after}); err != nil {
		return nil, err
	}
	return redactLead(after, r.sc), nil
}

// leadDelete removes a lead for good: the owner and admins only, after a confirmation on screen (D232). Everyone else archives.
func (r *run) leadDelete(p map[string]any) (any, error) {
	if !r.sc.can("admin") {
		return nil, reject("Only the agency owner or an admin deletes a lead for good. Archive it instead")
	}
	id, err := uuidField(p, "id")
	if err != nil {
		return nil, err
	}
	before, err := r.visibleLead(id, true)
	if err != nil {
		return nil, err
	}
	propertyID := asString(before["property_id"])
	if err = r.exec(`DELETE FROM leads WHERE id = $1`, id); err != nil {
		return nil, err
	}
	if propertyID != "" {
		if err = r.exec(`DELETE FROM properties p WHERE p.id = $1
			AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.property_id = p.id)
			AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.property_id = p.id)`, propertyID); err != nil {
			return nil, err
		}
	}
	if err = r.record(change{entity: "lead", kind: "lead.deleted", id: id, leadID: id, deleted: true}); err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "deleted": true}, nil
}

func (r *run) leadShare(p map[string]any) (any, error) {
	if err := r.need("assign"); err != nil {
		return nil, err
	}
	id, err := uuidField(p, "id")
	if err != nil {
		return nil, err
	}
	user, err := uuidField(p, "user_id")
	if err != nil {
		return nil, err
	}
	share := p["shared"] != false
	if _, err = r.visibleLead(id, true); err != nil {
		return nil, err
	}
	if share {
		err = r.exec(`INSERT INTO lead_shares (org_id, lead_id, user_id) VALUES (cw_org(), $1, $2) ON CONFLICT DO NOTHING`, id, user)
	} else {
		err = r.exec(`DELETE FROM lead_shares WHERE lead_id = $1 AND user_id = $2`, id, user)
	}
	if err == nil {
		err = r.exec(`UPDATE leads SET shared_external = EXISTS (SELECT 1 FROM lead_shares WHERE lead_id = $1), version = version + 1 WHERE id = $1`, id)
	}
	if err == nil {
		err = r.accessChanged()
	}
	if err == nil {
		err = r.record(change{entity: "lead", kind: "lead.shared", id: id, leadID: id, after: map[string]any{"user_id": user, "shared": share}})
	}
	return map[string]any{"id": id, "user_id": user, "shared": share}, err
}

// ------------------------------------------------------------------------------------------------ notes and calls

func (r *run) noteChange(p map[string]any, remove bool) (any, error) {
	id, err := uuidField(p, "id")
	if err != nil {
		return nil, err
	}
	before, err := r.one(`SELECT to_jsonb(n) FROM notes n WHERE n.id = $1 AND cw_visible_lead(n.lead_id) FOR UPDATE`, id)
	if err != nil {
		return nil, err
	}
	if before == nil {
		return nil, reject("The note was not found or is outside your access")
	}
	leadID := asString(before["lead_id"])
	author := asString(before["author_id"]) == r.sc.userID
	editor := false
	if r.sc.can("edit") {
		if l, err := r.visibleLead(leadID, false); err == nil {
			editor = canEditLead(r.sc, l)
		}
	}
	if !author && !editor {
		return nil, reject("Only the note's author or someone who can edit the lead can change it")
	}
	if remove {
		if err = r.exec(`DELETE FROM notes WHERE id = $1`, id); err != nil {
			return nil, err
		}
		if err = r.record(change{entity: "note", kind: "note.deleted", id: id, leadID: leadID, before: before, deleted: true}); err != nil {
			return nil, err
		}
		return map[string]any{"id": id, "deleted": true}, nil
	}
	body := str(p, "body")
	if body == "" || len([]rune(body)) > 20000 {
		return nil, reject("A note needs some text (up to 20,000 characters)")
	}
	note, err := r.one(`UPDATE notes SET body = $2, edited_at = now() WHERE id = $1 RETURNING to_jsonb(notes.*)`, id, body)
	if err != nil {
		return nil, err
	}
	return note, r.record(change{entity: "note", kind: "note.edited", id: id, leadID: leadID, before: before, after: note})
}

func (r *run) noteAdd(p map[string]any) (any, error) {
	leadID, err := uuidField(p, "lead_id")
	if err != nil {
		return nil, err
	}
	body := str(p, "body")
	if body == "" {
		return nil, reject("A note needs some text")
	}
	if _, err = r.visibleLead(leadID, false); err != nil {
		return nil, err
	}
	if !r.sc.can("edit") && !r.sc.can("publicComment") {
		return nil, reject("Your role cannot add notes")
	}
	// External comments are always shared; internal people choose.
	visibility := "internal"
	if r.sc.external() || p["visibility"] == "shared" {
		visibility = "shared"
	}
	id, err := optUUID(p, "id")
	if err != nil {
		return nil, err
	}
	note, err := r.one(`INSERT INTO notes (id, org_id, lead_id, author_id, author_label, body, visibility, mentions, occurred_at, operation_id)
		VALUES (coalesce($1::uuid, gen_random_uuid()), cw_org(), $2, $3, $4, $5, $6, $7::uuid[], coalesce($8, now()), $9) RETURNING to_jsonb(notes.*)`,
		id, leadID, r.sc.userID, r.sc.label, body, visibility, uuidList(p, "mentions"), r.op.ClaimedAt, r.op.ID)
	if err != nil {
		return nil, err
	}
	return note, r.record(change{entity: "note", kind: "note.added", id: asString(note["id"]), leadID: leadID, after: note})
}

func (r *run) callRecord(p map[string]any) (any, error) {
	if err := r.need("call"); err != nil {
		return nil, err
	}
	leadID, err := uuidField(p, "lead_id")
	if err != nil {
		return nil, err
	}
	label := str(p, "outcome")
	out := findOutcome(label)
	if out == nil {
		return nil, reject("%s is not a call outcome", label)
	}
	before, err := r.visibleLead(leadID, true)
	if err != nil {
		return nil, err
	}
	if !canEditLead(r.sc, before) {
		return nil, reject("You can only log calls on leads assigned to you")
	}
	if before["do_not_call"] == true {
		return nil, reject("This lead is do-not-call; calls cannot be logged")
	}
	occurred := time.Now()
	if t, err := optTime(p, "occurred_at"); err != nil {
		return nil, err
	} else if t != nil {
		occurred = *t
	} else if r.op.ClaimedAt != nil {
		occurred = *r.op.ClaimedAt
	}
	callback, err := optTime(p, "callback_at")
	if err != nil {
		return nil, err
	}
	var scheduled *time.Time
	switch {
	case out.label == "Callback":
		if callback == nil {
			return nil, reject("A callback needs a time")
		}
		scheduled = callback
	case out.recallDays > 0:
		t := occurred.AddDate(0, 0, out.recallDays)
		scheduled = &t
	}
	phone := str(p, "phone")
	if phone == "" {
		phone = asString(before["phone"])
	}
	// The carrier's facts about a call (record id, durations, recording) come only from the dialer service.
	recordID, notes, details := "", "", map[string]any{}
	var recStart, recEnd *time.Time
	if r.op.internal {
		recordID, notes = str(p, "source_record_id"), str(p, "notes")
		if d, ok := p["details"].(map[string]any); ok {
			details = d
		}
		if recStart, err = optTime(p, "recording_started_at"); err != nil {
			return nil, err
		}
		if recEnd, err = optTime(p, "recording_ended_at"); err != nil {
			return nil, err
		}
	}
	event, err := r.one(`INSERT INTO call_events (org_id, lead_id, agent_id, agent_label, phone, outcome, code, meaning, scheduled_at, source, occurred_at, operation_id,
			source_record_id, notes, details, recording_started_at, recording_ended_at)
		VALUES (cw_org(), $1, $2, $3, $4, $5, $6, $7, $8, coalesce(nullif($9, ''), 'manual'), $10, $11, $12, $13, $14, $15, $16) RETURNING to_jsonb(call_events.*)`,
		leadID, r.sc.userID, r.sc.label, phone, out.label, out.code, out.meaning, scheduled, str(p, "source"), occurred, r.op.ID,
		recordID, notes, details, recStart, recEnd)
	if err != nil {
		return nil, err
	}
	stage := asString(before["stage"])
	switch {
	case out.label == "Transfer":
		stage = "Qualified"
	case out.label == "Do not call":
		stage = "Closed"
	case out.meaning == "reached" && stage == "New":
		stage = "Contacted"
	}
	verdict := asString(before["verdict"])
	switch out.meaning {
	case "wrong_number":
		verdict = "Wrong number"
	case "wrong_person":
		verdict = "Wrong person"
	case "disconnected":
		verdict = "Disconnected"
	case "do_not_call":
		verdict = "Do not call"
	}
	nextAction := "Try again"
	if out.label == "Callback" {
		nextAction = "Callback"
	}
	err = r.exec(`UPDATE leads SET stage = $2, verdict = $3, do_not_call = do_not_call OR $4, next_action_at = $5,
			next_action = CASE WHEN $5::timestamptz IS NULL THEN '' ELSE $6 END, sent_to = CASE WHEN $7 THEN 'Appointments' ELSE sent_to END,
			version = version + 1, updated_at = now() WHERE id = $1`,
		leadID, stage, verdict, out.meaning == "do_not_call", scheduled, nextAction, out.label == "Transfer")
	if err != nil {
		return nil, err
	}
	// One open callback task per lead: a new try replaces it, a final outcome closes it.
	closed, err := queryJSON(r.ctx, r.tx, `UPDATE tasks SET done_at = now(), version = version + 1 WHERE lead_id = $1 AND type = 'Callback' AND done_at IS NULL RETURNING jsonb_build_object('id', id)`, leadID)
	if err != nil {
		return nil, err
	}
	for _, t := range closed {
		var m map[string]string
		_ = json.Unmarshal(t, &m)
		if err = r.record(change{entity: "task", kind: "task.completed", id: m["id"], leadID: leadID}); err != nil {
			return nil, err
		}
	}
	assignee, _ := before["assignee_id"].(string)
	name := asString(before["name"])
	if scheduled != nil {
		title := "Try again: " + name
		if out.label == "Callback" {
			title = "Callback: " + name
		}
		var taskID string
		if err = r.tx.QueryRow(r.ctx, `INSERT INTO tasks (org_id, lead_id, assignee_id, title, type, due_at, timezone) VALUES (cw_org(), $1, nullif($2, '')::uuid, $3, 'Callback', $4, $5) RETURNING id::text`,
			leadID, assignee, title, scheduled, before["next_action_tz"]).Scan(&taskID); err != nil {
			return nil, err
		}
		if err = r.record(change{entity: "task", kind: "task.created", id: taskID, leadID: leadID}); err != nil {
			return nil, err
		}
	}
	if out.label == "Transfer" {
		var taskID string
		if err = r.tx.QueryRow(r.ctx, `INSERT INTO tasks (org_id, lead_id, assignee_id, title, type, priority, due_at) VALUES (cw_org(), $1, nullif($2, '')::uuid, $3, 'Appointment', 'High', now()) RETURNING id::text`,
			leadID, assignee, "Appointment for "+name+" (transferred)").Scan(&taskID); err != nil {
			return nil, err
		}
		if err = r.record(change{entity: "task", kind: "task.created", id: taskID, leadID: leadID}); err != nil {
			return nil, err
		}
	}
	after, err := r.visibleLead(leadID, false)
	if err != nil {
		return nil, err
	}
	if err = r.record(change{entity: "call", kind: "call.recorded", id: asString(event["id"]), leadID: leadID, after: event}); err != nil {
		return nil, err
	}
	kind := "lead.updated"
	if before["stage"] != after["stage"] {
		kind = "lead.stage_changed"
	}
	if err = r.record(change{entity: "lead", kind: kind, id: leadID, leadID: leadID, before: before, after: after}); err != nil {
		return nil, err
	}
	return map[string]any{"call": event, "lead": redactLead(after, r.sc)}, nil
}

// ------------------------------------------------------------------------------------------------------ tasks

var taskEditable = []string{"title", "type", "priority", "due_at", "timezone", "recurrence", "assignee_id", "shared_external"}

func (r *run) task(id string, lock bool) (map[string]any, error) {
	sql := `SELECT to_jsonb(t) FROM tasks t WHERE t.id = $1
		AND ((t.lead_id IS NULL AND (t.assignee_id = nullif(current_setting('cw.user_id', true), '')::uuid
			OR 'organization' = ANY(string_to_array(current_setting('cw.scopes', true), ',')))) OR cw_visible_lead(t.lead_id))
		AND (NOT cw_external() OR t.shared_external)`
	if lock {
		sql += ` FOR UPDATE`
	}
	t, err := r.one(sql, id)
	if err == nil && t == nil {
		err = reject("The task was not found or is outside your access")
	}
	return t, err
}

func (r *run) taskRights() error {
	if !r.sc.can("edit") && !r.sc.can("review") {
		return reject("Your role cannot change tasks")
	}
	return nil
}

func (r *run) taskDelete(p map[string]any) (any, error) {
	if err := r.taskRights(); err != nil {
		return nil, err
	}
	id, err := uuidField(p, "id")
	if err != nil {
		return nil, err
	}
	before, err := r.task(id, true)
	if err != nil {
		return nil, err
	}
	if err = r.exec(`DELETE FROM tasks WHERE id = $1`, id); err != nil {
		return nil, err
	}
	if err = r.record(change{entity: "task", kind: "task.deleted", id: id, leadID: asString(before["lead_id"]), before: before, deleted: true}); err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "deleted": true}, nil
}

// nextOccurrence is the next due time for a simple repeat rule: FREQ=DAILY|WEEKLY|MONTHLY with an optional INTERVAL.
func nextOccurrence(rule string, from time.Time) (time.Time, bool) {
	freq, interval := "", 1
	for _, part := range strings.Split(rule, ";") {
		k, v, ok := strings.Cut(part, "=")
		if !ok {
			return time.Time{}, false
		}
		switch k {
		case "FREQ":
			freq = v
		case "INTERVAL":
			n, err := strconv.Atoi(v)
			if err != nil || n < 1 || n > 365 {
				return time.Time{}, false
			}
			interval = n
		}
	}
	switch freq {
	case "DAILY":
		return from.AddDate(0, 0, interval), true
	case "WEEKLY":
		return from.AddDate(0, 0, 7*interval), true
	case "MONTHLY":
		return from.AddDate(0, interval, 0), true
	}
	return time.Time{}, false
}

func validRecurrence(rule string) bool {
	_, ok := nextOccurrence(rule, time.Now())
	return rule == "" || ok
}

func (r *run) taskCreate(p map[string]any) (any, error) {
	if err := r.taskRights(); err != nil {
		return nil, err
	}
	title := str(p, "title")
	if title == "" {
		return nil, reject("A task needs a title")
	}
	leadID, err := optUUID(p, "lead_id")
	if err != nil {
		return nil, err
	}
	if leadID != nil {
		if _, err = r.visibleLead(*leadID, false); err != nil {
			return nil, err
		}
	}
	recurrence := str(p, "recurrence")
	if !validRecurrence(recurrence) {
		return nil, reject("Repeat must be FREQ=DAILY, WEEKLY or MONTHLY, with an optional INTERVAL")
	}
	assignee, err := optUUID(p, "assignee_id")
	if err != nil {
		return nil, err
	}
	if assignee == nil {
		assignee = &r.sc.userID
	}
	if _, err = r.handTo(*assignee); err != nil {
		return nil, err
	}
	id, err := optUUID(p, "id")
	if err != nil {
		return nil, err
	}
	due, err := optTime(p, "due_at")
	if err != nil {
		return nil, err
	}
	shared, _ := p["shared_external"].(bool)
	task, err := r.one(`INSERT INTO tasks (id, org_id, lead_id, assignee_id, title, type, priority, due_at, timezone, recurrence, shared_external)
		VALUES (coalesce($1::uuid, gen_random_uuid()), cw_org(), $2, $3, $4, coalesce(nullif($5, ''), 'Task'), coalesce(nullif($6, ''), 'Normal'), $7, nullif($8, ''), nullif($9, ''), $10)
		RETURNING to_jsonb(tasks.*)`, id, leadID, assignee, title, str(p, "type"), str(p, "priority"), due, str(p, "timezone"), recurrence, shared)
	if err != nil {
		return nil, err
	}
	lead := ""
	if leadID != nil {
		lead = *leadID
	}
	return task, r.record(change{entity: "task", kind: "task.created", id: asString(task["id"]), leadID: lead, after: task})
}

func (r *run) taskUpdate(p map[string]any) (any, error) {
	if err := r.taskRights(); err != nil {
		return nil, err
	}
	id, err := uuidField(p, "id")
	if err != nil {
		return nil, err
	}
	changes, base := objectField(p, "changes"), objectField(p, "base")
	for field := range changes {
		if !slices.Contains(taskEditable, field) {
			return nil, reject("%s cannot be changed this way", field)
		}
	}
	if rule, ok := changes["recurrence"].(string); ok && !validRecurrence(rule) {
		return nil, reject("Repeat must be FREQ=DAILY, WEEKLY or MONTHLY")
	}
	before, err := r.task(id, true)
	if err != nil {
		return nil, err
	}
	if err = checkBase(before, changes, base); err != nil {
		return nil, err
	}
	if to, ok := changes["assignee_id"]; ok && asString(to) != asString(before["assignee_id"]) {
		if !validID(asString(to)) {
			return nil, reject("Choose who the task is for")
		}
		if _, err = r.handTo(asString(to)); err != nil {
			return nil, err
		}
	}
	task, err := r.one(`UPDATE tasks t SET (title, type, priority, due_at, timezone, recurrence, assignee_id, shared_external) =
			(SELECT x.title, x.type, x.priority, x.due_at, x.timezone, nullif(x.recurrence, ''), x.assignee_id, x.shared_external FROM jsonb_populate_record(NULL::tasks, $2::jsonb) x),
			version = t.version + 1 WHERE t.id = $1 RETURNING to_jsonb(t.*)`, id, merge(before, changes))
	if err != nil {
		return nil, err
	}
	return task, r.record(change{entity: "task", kind: "task.updated", id: id, leadID: asString(task["lead_id"]), before: before, after: task})
}

func (r *run) taskComplete(p map[string]any) (any, error) {
	if err := r.taskRights(); err != nil {
		return nil, err
	}
	id, err := uuidField(p, "id")
	if err != nil {
		return nil, err
	}
	done := p["done"] != false
	before, err := r.task(id, true)
	if err != nil {
		return nil, err
	}
	task, err := r.one(`UPDATE tasks t SET done_at = CASE WHEN $2 THEN coalesce(t.done_at, now()) ELSE NULL END, version = t.version + 1 WHERE t.id = $1 RETURNING to_jsonb(t.*)`, id, done)
	if err != nil {
		return nil, err
	}
	leadID := asString(task["lead_id"])
	kind := "task.reopened"
	if done {
		kind = "task.completed"
	}
	if err = r.record(change{entity: "task", kind: kind, id: id, leadID: leadID, before: before, after: task}); err != nil {
		return nil, err
	}
	// Completing a repeating task creates its next instance, once.
	rule := asString(task["recurrence"])
	if done && isNull(before["done_at"]) && rule != "" {
		due := time.Now()
		if t, err := time.Parse(time.RFC3339, asString(task["due_at"])); err == nil {
			due = t
		}
		if next, ok := nextOccurrence(rule, due); ok {
			var nextID string
			err = r.tx.QueryRow(r.ctx, `INSERT INTO tasks (org_id, lead_id, deal_id, assignee_id, title, type, priority, due_at, timezone, recurrence, shared_external)
				SELECT org_id, lead_id, deal_id, assignee_id, title, type, priority, $2, timezone, recurrence, shared_external FROM tasks WHERE id = $1 RETURNING id::text`, id, next).Scan(&nextID)
			if err != nil {
				return nil, err
			}
			if err = r.record(change{entity: "task", kind: "task.created", id: nextID, leadID: leadID}); err != nil {
				return nil, err
			}
		}
	}
	return task, nil
}

// --------------------------------------------------------------------------------------------------- handoffs

func (r *run) handoffRequest(p map[string]any) (any, error) {
	if err := r.need("handoff"); err != nil {
		return nil, err
	}
	leadID, err := uuidField(p, "lead_id")
	if err != nil {
		return nil, err
	}
	to, err := uuidField(p, "to_user")
	if err != nil {
		return nil, err
	}
	note := str(p, "note")
	if note == "" {
		return nil, reject("Say what the recipient needs to know")
	}
	lead, err := r.visibleLead(leadID, true)
	if err != nil {
		return nil, err
	}
	if !canEditLead(r.sc, lead) {
		return nil, reject("You can only hand off leads assigned to you")
	}
	if to == r.sc.userID {
		return nil, reject("Choose someone else to hand off to")
	}
	g, err := r.s.rules.grant(r.ctx, to, r.sc.orgID, true)
	if err != nil {
		return nil, err
	}
	if !g.Allowed || !slices.Contains(g.Capabilities, "accept") {
		return nil, reject("That person cannot accept handoffs")
	}
	// A handoff stays inside the lead's team; another team's closer is a team move by a team lead (D109).
	if team := asString(lead["team_id"]); team != "" && !slices.Contains(g.TeamIDs, team) && !slices.Contains(g.Scopes, "organization") {
		return nil, reject("Hand off to someone in this lead's team. Sending it to another team is a move a team lead makes")
	}
	if project, ok := lead["project_id"].(string); ok {
		var required []string
		rows, err := r.tx.Query(r.ctx, `SELECT unnest(qualification_fields) FROM projects WHERE id = $1`, project)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var f string
			if err = rows.Scan(&f); err != nil {
				rows.Close()
				return nil, err
			}
			required = append(required, f)
		}
		rows.Close()
		q, _ := lead["qualification"].(map[string]any)
		var missing []string
		for _, f := range required {
			if strings.TrimSpace(asString(q[f])) == "" {
				missing = append(missing, f)
			}
		}
		if len(missing) > 0 {
			return nil, reject("Fill in the qualification details first: %s", strings.Join(missing, ", "))
		}
	}
	handoff, err := r.one(`INSERT INTO handoffs (org_id, lead_id, from_user, to_user, note, due_at) VALUES (cw_org(), $1, $2, $3, $4, now() + interval '2 days')
		ON CONFLICT (lead_id) WHERE status = 'Requested' DO NOTHING RETURNING to_jsonb(handoffs.*)`, leadID, r.sc.userID, to, note)
	if err != nil {
		return nil, err
	}
	if handoff == nil {
		return nil, reject("This lead already has an open handoff")
	}
	return handoff, r.record(change{entity: "handoff", kind: "handoff.requested", id: asString(handoff["id"]), leadID: leadID, after: handoff})
}

func (r *run) handoffDecide(p map[string]any) (any, error) {
	id, err := uuidField(p, "id")
	if err != nil {
		return nil, err
	}
	decision := str(p, "decision")
	h, err := r.one(`SELECT to_jsonb(h) FROM handoffs h WHERE h.id = $1 AND cw_visible_lead(h.lead_id) FOR UPDATE`, id)
	if err != nil {
		return nil, err
	}
	if h == nil {
		return nil, reject("The handoff was not found or is outside your access")
	}
	if h["status"] != "Requested" {
		already := map[string]string{"accept": "Accepted", "decline": "Declined", "cancel": "Cancelled"}[decision]
		if already != "" && h["status"] == already {
			return h, nil // the same decision twice is not an error
		}
		return nil, reject("This handoff is already %s", strings.ToLower(asString(h["status"])))
	}
	recipient, requester, manager := asString(h["to_user"]) == r.sc.userID, asString(h["from_user"]) == r.sc.userID, r.sc.can("assign")
	status := ""
	switch {
	case decision == "accept" && ((recipient && r.sc.can("accept")) || manager):
		status = "Accepted"
	case decision == "decline" && (recipient || manager):
		status = "Declined"
	case decision == "cancel" && (requester || manager):
		status = "Cancelled"
	case decision == "accept" || decision == "decline" || decision == "cancel":
		return nil, reject("You cannot make this decision on the handoff")
	default:
		return nil, reject("decision must be accept, decline or cancel")
	}
	leadID, to := asString(h["lead_id"]), asString(h["to_user"])
	updated, err := r.one(`UPDATE handoffs SET status = $2, decided_at = now(), version = version + 1 WHERE id = $1 RETURNING to_jsonb(handoffs.*)`, id, status)
	if err != nil {
		return nil, err
	}
	if status == "Accepted" {
		// Ownership, history, tasks and the deal change together.
		before, err := r.one(`SELECT to_jsonb(l) FROM leads l WHERE id = $1 FOR UPDATE`, leadID)
		if err != nil {
			return nil, err
		}
		from, _ := before["assignee_id"].(string)
		if err = r.exec(`UPDATE leads SET assignee_id = $2, stage = 'Qualified', version = version + 1, updated_at = now() WHERE id = $1`, leadID, to); err != nil {
			return nil, err
		}
		if err = r.exec(`INSERT INTO assignments (org_id, lead_id, from_user, to_user, reason, actor_id) VALUES (cw_org(), $1, nullif($2, '')::uuid, $3, 'Handoff accepted', $4)`, leadID, from, to, r.sc.userID); err != nil {
			return nil, err
		}
		if err = r.exec(`UPDATE tasks SET assignee_id = $2, version = version + 1 WHERE lead_id = $1 AND done_at IS NULL`, leadID, to); err != nil {
			return nil, err
		}
		var dealID *string
		err = r.tx.QueryRow(r.ctx, `INSERT INTO deals (org_id, lead_id, property_id, stage, currency)
			SELECT org_id, id, property_id, 'Qualified', coalesce(value_currency, 'USD') FROM leads WHERE id = $1 ON CONFLICT (lead_id) DO NOTHING RETURNING id::text`, leadID).Scan(&dealID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if dealID != nil {
			if err = r.record(change{entity: "deal", kind: "deal.created", id: *dealID, leadID: leadID}); err != nil {
				return nil, err
			}
		}
		after, err := r.one(`SELECT to_jsonb(l) FROM leads l WHERE id = $1`, leadID)
		if err != nil {
			return nil, err
		}
		if err = r.record(change{entity: "lead", kind: "lead.assigned", id: leadID, leadID: leadID, before: before, after: after}); err != nil {
			return nil, err
		}
	}
	kind := map[string]string{"Accepted": "handoff.accepted", "Declined": "handoff.declined", "Cancelled": "handoff.cancelled"}[status]
	return updated, r.record(change{entity: "handoff", kind: kind, id: id, leadID: leadID, before: h, after: updated})
}

// ------------------------------------------------------------------------------------------------------- deals

var dealEditable = []string{"stage", "amount", "fee", "currency", "close_date", "outcome_reason"}

func money(p map[string]any, name string) (*float64, error) {
	if p[name] == nil {
		return nil, nil
	}
	n := asNumber(p[name])
	if n == nil || *n < 0 || *n >= 1e12 {
		return nil, reject("%s must be an amount of zero or more", name)
	}
	return n, nil
}

func (r *run) dealCreate(p map[string]any) (any, error) {
	if err := r.need("finance"); err != nil {
		return nil, err
	}
	leadID, err := uuidField(p, "lead_id")
	if err != nil {
		return nil, err
	}
	if _, err = r.visibleLead(leadID, false); err != nil {
		return nil, err
	}
	id, err := optUUID(p, "id")
	if err != nil {
		return nil, err
	}
	stage := str(p, "stage")
	if stage == "" {
		stage = "Qualified"
	}
	if !slices.Contains(dealStages, stage) {
		return nil, reject("%s is not a deal stage", stage)
	}
	if strings.HasPrefix(stage, "Closed") {
		return nil, reject("A new deal starts in an open stage")
	}
	var closeDate *string
	if day := str(p, "close_date"); day != "" {
		if _, err = time.Parse("2006-01-02", day); err != nil {
			return nil, reject("close_date must be a date (YYYY-MM-DD)")
		}
		closeDate = &day
	}
	amount, err := money(p, "amount")
	if err != nil {
		return nil, err
	}
	fee, err := money(p, "fee")
	if err != nil {
		return nil, err
	}
	deal, err := r.one(`INSERT INTO deals (id, org_id, lead_id, property_id, stage, amount, fee, close_date)
		SELECT coalesce($2::uuid, gen_random_uuid()), l.org_id, l.id, l.property_id, $3, $4, $5, $6::date FROM leads l WHERE l.id = $1
		ON CONFLICT (lead_id) DO NOTHING RETURNING to_jsonb(deals.*)`, leadID, id, stage, amount, fee, closeDate)
	if err != nil {
		return nil, err
	}
	if deal == nil {
		return nil, reject("This lead already has a deal")
	}
	return deal, r.record(change{entity: "deal", kind: "deal.created", id: asString(deal["id"]), leadID: leadID, after: deal})
}

func (r *run) deal(id string) (map[string]any, error) {
	d, err := r.one(`SELECT to_jsonb(d) FROM deals d WHERE d.id = $1 AND cw_visible_lead(d.lead_id) FOR UPDATE`, id)
	if err == nil && d == nil {
		err = reject("The deal was not found or is outside your access")
	}
	return d, err
}

func (r *run) dealUpdate(p map[string]any) (any, error) {
	if err := r.need("finance"); err != nil {
		return nil, err
	}
	id, err := uuidField(p, "id")
	if err != nil {
		return nil, err
	}
	changes, base := objectField(p, "changes"), objectField(p, "base")
	for field := range changes {
		if !slices.Contains(dealEditable, field) {
			return nil, reject("%s cannot be changed this way", field)
		}
	}
	before, err := r.deal(id)
	if err != nil {
		return nil, err
	}
	if err = checkBase(before, changes, base); err != nil {
		return nil, err
	}
	if stage, ok := changes["stage"].(string); ok {
		if !slices.Contains(dealStages, stage) {
			return nil, reject("%s is not a deal stage", stage)
		}
		reason := asString(before["outcome_reason"])
		if v, ok := changes["outcome_reason"].(string); ok {
			reason = v
		}
		if stage == "Closed lost" && strings.TrimSpace(reason) == "" {
			return nil, reject("Say why the deal was lost")
		}
	}
	deal, err := r.one(`UPDATE deals d SET (stage, amount, fee, currency, close_date, outcome_reason) =
			(SELECT x.stage, x.amount, x.fee, x.currency, x.close_date, x.outcome_reason FROM jsonb_populate_record(NULL::deals, $2::jsonb) x),
			version = d.version + 1 WHERE d.id = $1 RETURNING to_jsonb(d.*)`, id, merge(before, changes))
	if err != nil {
		return nil, err
	}
	kind := "deal.updated"
	if before["stage"] != deal["stage"] {
		kind = "deal.stage_changed"
	}
	return deal, r.record(change{entity: "deal", kind: kind, id: id, leadID: asString(deal["lead_id"]), before: before, after: deal})
}

// dealDelete removes a deal; its follow-up tasks go with it and each removal is recorded so every device drops them too.
func (r *run) dealDelete(p map[string]any) (any, error) {
	if err := r.need("finance"); err != nil {
		return nil, err
	}
	id, err := uuidField(p, "id")
	if err != nil {
		return nil, err
	}
	before, err := r.deal(id)
	if err != nil {
		return nil, err
	}
	leadID := asString(before["lead_id"])
	attached, err := queryJSON(r.ctx, r.tx, `SELECT to_jsonb(t) FROM tasks t WHERE t.deal_id = $1`, id)
	if err != nil {
		return nil, err
	}
	if err = r.exec(`DELETE FROM deals WHERE id = $1`, id); err != nil {
		return nil, err
	}
	for _, raw := range attached {
		var t map[string]any
		_ = json.Unmarshal(raw, &t)
		if err = r.record(change{entity: "task", kind: "task.deleted", id: asString(t["id"]), leadID: leadID, before: t, deleted: true}); err != nil {
			return nil, err
		}
	}
	if err = r.record(change{entity: "deal", kind: "deal.deleted", id: id, leadID: leadID, before: before, deleted: true}); err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "deleted": true}, nil
}
