package main

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// postgres keeps authorization data in the service's own PostgreSQL database.
type postgres struct{ db *pgxpool.Pool }

func newPostgres(ctx context.Context, url string) (*postgres, error) {
	db, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, err
	}
	p := &postgres{db: db}
	if err = db.Ping(ctx); err == nil {
		err = p.setup(ctx)
	}
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("authorization database: %w", err)
	}
	return p, nil
}

func (p *postgres) close()                         { p.db.Close() }
func (p *postgres) ping(ctx context.Context) error { return p.db.Ping(ctx) }

func (p *postgres) setup(ctx context.Context) error {
	tx, err := p.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// The lock makes concurrent replicas safe on their first deployment.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(8104)`); err != nil {
		return err
	}
	for _, ddl := range []string{
		`CREATE TABLE IF NOT EXISTS authz_workspaces (org_id text PRIMARY KEY, owner_id text NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS authz_standing (org_id text PRIMARY KEY, suspended boolean NOT NULL DEFAULT false, payment_required boolean NOT NULL DEFAULT false)`,
		`CREATE TABLE IF NOT EXISTS authz_roles (org_id text NOT NULL, role_key text NOT NULL, capabilities text[] NOT NULL DEFAULT '{}', scope text NOT NULL DEFAULT 'none', second_step boolean NOT NULL DEFAULT false, PRIMARY KEY (org_id, role_key))`,
		`CREATE TABLE IF NOT EXISTS authz_members (org_id text NOT NULL, user_id text NOT NULL, roles text[] NOT NULL DEFAULT '{}', restrictions text[] NOT NULL DEFAULT '{}', team_ids text[] NOT NULL DEFAULT '{}', project_ids text[] NOT NULL DEFAULT '{}', PRIMARY KEY (org_id, user_id))`,
		`CREATE INDEX IF NOT EXISTS authz_members_user_idx ON authz_members (user_id)`,
		`CREATE TABLE IF NOT EXISTS authz_staff (user_id text PRIMARY KEY, role text NOT NULL CHECK (role IN ('owner', 'admin')))`,
		`ALTER TABLE authz_staff DROP CONSTRAINT IF EXISTS authz_staff_role_check`,
		`UPDATE authz_staff SET role='system_admin' WHERE role='admin'`,
		`ALTER TABLE authz_staff ADD CONSTRAINT authz_staff_role_check CHECK (role IN ('owner', 'cofounder', 'system_admin', 'tester'))`,
		`CREATE UNIQUE INDEX IF NOT EXISTS authz_one_owner_idx ON authz_staff (role) WHERE role = 'owner'`,
		`CREATE UNIQUE INDEX IF NOT EXISTS authz_one_cofounder_idx ON authz_staff (role) WHERE role = 'cofounder'`,
		`CREATE OR REPLACE FUNCTION authz_protect_owner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.role IN ('owner', 'cofounder') THEN RAISE EXCEPTION 'the platform owner and cofounder cannot be changed or deleted'; END IF; IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$`,
		`DROP TRIGGER IF EXISTS authz_owner_immutable ON authz_staff`,
		`CREATE TRIGGER authz_owner_immutable BEFORE UPDATE OR DELETE ON authz_staff FOR EACH ROW EXECUTE FUNCTION authz_protect_owner()`,
		// The team tree: one manager per team; members can be suspended; the plan's seats and client places.
		`CREATE TABLE IF NOT EXISTS authz_teams (org_id text NOT NULL, team_id text NOT NULL, name text NOT NULL, manager_id text, PRIMARY KEY (org_id, team_id))`,
		`CREATE UNIQUE INDEX IF NOT EXISTS authz_teams_name_idx ON authz_teams (org_id, lower(name))`,
		`CREATE INDEX IF NOT EXISTS authz_teams_manager_idx ON authz_teams (org_id, manager_id)`,
		`ALTER TABLE authz_members ADD COLUMN IF NOT EXISTS suspended_at bigint`,
		`ALTER TABLE authz_members ADD COLUMN IF NOT EXISTS suspended_by text NOT NULL DEFAULT ''`,
		`ALTER TABLE authz_members ADD COLUMN IF NOT EXISTS suspended_reason text NOT NULL DEFAULT ''`,
		`ALTER TABLE authz_standing ADD COLUMN IF NOT EXISTS seats integer`,
		`ALTER TABLE authz_standing ADD COLUMN IF NOT EXISTS clients integer`,
		// Presets are copied into each workspace when it opens: team managers now upload lists in every workspace.
		`UPDATE authz_roles SET capabilities = array_append(capabilities, 'import') WHERE role_key = 'manager' AND NOT ('import' = ANY(capabilities))`,
		// The second step (an authenticator) is for the platform owner and cofounder only, not for anyone in a workspace.
		`UPDATE authz_roles SET second_step = false WHERE role_key IN ('owner', 'solo') AND second_step`,
	} {
		if _, err = tx.Exec(ctx, ddl); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (p *postgres) membership(ctx context.Context, org, user string) (membership, bool, error) {
	var m membership
	err := p.db.QueryRow(ctx, `SELECT user_id, roles, restrictions, team_ids, project_ids, suspended_at, suspended_by, suspended_reason FROM authz_members WHERE org_id=$1 AND user_id=$2`, org, user).Scan(&m.UserID, &m.Roles, &m.Restrictions, &m.TeamIDs, &m.ProjectIDs, &m.SuspendedAt, &m.SuspendedBy, &m.SuspendedReason)
	if errors.Is(err, pgx.ErrNoRows) {
		return membership{}, false, nil
	}
	return m, err == nil && len(m.Roles) > 0, err
}

func (p *postgres) members(ctx context.Context, org string) ([]membership, error) {
	rows, err := p.db.Query(ctx, `SELECT user_id, roles, restrictions, team_ids, project_ids, suspended_at, suspended_by, suspended_reason FROM authz_members WHERE org_id=$1 ORDER BY user_id`, org)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []membership{}
	for rows.Next() {
		var m membership
		if err := rows.Scan(&m.UserID, &m.Roles, &m.Restrictions, &m.TeamIDs, &m.ProjectIDs, &m.SuspendedAt, &m.SuspendedBy, &m.SuspendedReason); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (p *postgres) setMembership(ctx context.Context, org string, m membership) error {
	_, err := p.db.Exec(ctx, `INSERT INTO authz_members (org_id,user_id,roles,restrictions,team_ids,project_ids) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (org_id,user_id) DO UPDATE SET roles=EXCLUDED.roles,restrictions=EXCLUDED.restrictions,team_ids=EXCLUDED.team_ids,project_ids=EXCLUDED.project_ids`, org, m.UserID, nonNil(m.Roles), nonNil(m.Restrictions), nonNil(m.TeamIDs), nonNil(m.ProjectIDs))
	return err
}

func nonNil(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

func (p *postgres) removeMember(ctx context.Context, org, user string) error {
	_, err := p.db.Exec(ctx, `DELETE FROM authz_members WHERE org_id=$1 AND user_id=$2`, org, user)
	return err
}

func (p *postgres) roles(ctx context.Context, org string) ([]role, error) {
	rows, err := p.db.Query(ctx, `SELECT role_key,capabilities,scope,second_step FROM authz_roles WHERE org_id=$1 ORDER BY role_key`, org)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []role
	for rows.Next() {
		var r role
		if err := rows.Scan(&r.Key, &r.Capabilities, &r.Scope, &r.SecondStep); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (p *postgres) setRole(ctx context.Context, org string, r role) error {
	_, err := p.db.Exec(ctx, `INSERT INTO authz_roles (org_id,role_key,capabilities,scope,second_step) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id,role_key) DO UPDATE SET capabilities=EXCLUDED.capabilities,scope=EXCLUDED.scope,second_step=EXCLUDED.second_step`, org, r.Key, nonNil(r.Capabilities), r.Scope, r.SecondStep)
	return err
}

func (p *postgres) openWorkspace(ctx context.Context, org, owner, ownerRole string) error {
	tx, err := p.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// An insert first serializes concurrent attempts to claim the same workspace.
	if _, err = tx.Exec(ctx, `INSERT INTO authz_workspaces (org_id,owner_id) VALUES ($1,$2) ON CONFLICT (org_id) DO NOTHING`, org, owner); err != nil {
		return err
	}
	var existing string
	if err = tx.QueryRow(ctx, `SELECT owner_id FROM authz_workspaces WHERE org_id=$1 FOR UPDATE`, org).Scan(&existing); err != nil {
		return err
	}
	if existing != owner {
		return errAlreadyOpen
	}
	for _, r := range presets {
		if _, err = tx.Exec(ctx, `INSERT INTO authz_roles (org_id,role_key,capabilities,scope,second_step) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id,role_key) DO UPDATE SET capabilities=EXCLUDED.capabilities,scope=EXCLUDED.scope,second_step=EXCLUDED.second_step`, org, r.key, nonNil(r.capabilities), r.scope, r.secondStep); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO authz_members (org_id,user_id,roles) VALUES ($1,$2,$3) ON CONFLICT (org_id,user_id) DO UPDATE SET roles=EXCLUDED.roles`, org, owner, []string{ownerRole}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// setStanding changes only the fields the change carries.
func (p *postgres) setStanding(ctx context.Context, org string, c standingChange) error {
	_, err := p.db.Exec(ctx, `INSERT INTO authz_standing (org_id, suspended, payment_required, seats, clients)
		VALUES ($1, coalesce($2, false), coalesce($3, false), $5, $7)
		ON CONFLICT (org_id) DO UPDATE SET
			suspended = coalesce($2, authz_standing.suspended),
			payment_required = coalesce($3, authz_standing.payment_required),
			seats = CASE WHEN $4 THEN $5 ELSE authz_standing.seats END,
			clients = CASE WHEN $6 THEN $7 ELSE authz_standing.clients END`,
		org, c.Suspended, c.PaymentRequired, c.SeatsSet, c.Seats, c.ClientsSet, c.Clients)
	return err
}

func (p *postgres) seatLimits(ctx context.Context, org string) (*int, *int, error) {
	var seats, clients *int
	err := p.db.QueryRow(ctx, `SELECT seats, clients FROM authz_standing WHERE org_id=$1`, org).Scan(&seats, &clients)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, nil
	}
	return seats, clients, err
}

func (p *postgres) teams(ctx context.Context, org string) ([]team, error) {
	rows, err := p.db.Query(ctx, `SELECT team_id, name, coalesce(manager_id, '') FROM authz_teams WHERE org_id=$1 ORDER BY lower(name)`, org)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []team{}
	for rows.Next() {
		var t team
		if err := rows.Scan(&t.TeamID, &t.Name, &t.ManagerID); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (p *postgres) setTeam(ctx context.Context, org string, t team) error {
	_, err := p.db.Exec(ctx, `INSERT INTO authz_teams (org_id, team_id, name, manager_id) VALUES ($1, $2, $3, nullif($4, ''))
		ON CONFLICT (org_id, team_id) DO UPDATE SET name = EXCLUDED.name, manager_id = EXCLUDED.manager_id`, org, t.TeamID, t.Name, t.ManagerID)
	return err
}

func (p *postgres) removeTeam(ctx context.Context, org, teamID string) error {
	_, err := p.db.Exec(ctx, `DELETE FROM authz_teams WHERE org_id=$1 AND team_id=$2`, org, teamID)
	return err
}

func (p *postgres) setSuspension(ctx context.Context, org, user string, at *int64, by, reason string) error {
	_, err := p.db.Exec(ctx, `UPDATE authz_members SET suspended_at=$3, suspended_by=$4, suspended_reason=$5 WHERE org_id=$1 AND user_id=$2`, org, user, at, by, reason)
	return err
}

func (p *postgres) staffRole(ctx context.Context, user string) (string, error) {
	var r string
	err := p.db.QueryRow(ctx, `SELECT role FROM authz_staff WHERE user_id=$1`, user).Scan(&r)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return r, err
}

func (p *postgres) staffMembers(ctx context.Context) ([]staffMember, error) {
	rows, err := p.db.Query(ctx, `SELECT user_id, role FROM authz_staff ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'cofounder' THEN 1 WHEN 'system_admin' THEN 2 ELSE 3 END, user_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	members := []staffMember{}
	for rows.Next() {
		var member staffMember
		if err := rows.Scan(&member.UserID, &member.Role); err != nil {
			return nil, err
		}
		members = append(members, member)
	}
	return members, rows.Err()
}

func (p *postgres) setStaff(ctx context.Context, user, staffRole string) error {
	if staffRole == "" {
		_, err := p.db.Exec(ctx, `DELETE FROM authz_staff WHERE user_id=$1 AND role IN ('system_admin','tester')`, user)
		return err
	}
	if !slices.Contains([]string{"system_admin", "tester"}, staffRole) {
		return errors.New("unknown platform role")
	}
	_, err := p.db.Exec(ctx, `INSERT INTO authz_staff (user_id,role) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET role=EXCLUDED.role WHERE authz_staff.role IN ('system_admin','tester')`, user, staffRole)
	return err
}

func (p *postgres) setPlatformOwner(ctx context.Context, user string) error {
	tx, err := p.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(8105)`); err != nil {
		return err
	}
	var current string
	err = tx.QueryRow(ctx, `SELECT user_id FROM authz_staff WHERE role='owner'`).Scan(&current)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if current != "" && current != user {
		return errOwnerTaken
	}
	if current == user {
		return tx.Commit(ctx)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO authz_staff (user_id,role) VALUES ($1,'owner') ON CONFLICT (user_id) DO UPDATE SET role='owner'`, user); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (p *postgres) setCofounder(ctx context.Context, user string) error {
	tx, err := p.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(8106)`); err != nil {
		return err
	}
	var current string
	err = tx.QueryRow(ctx, `SELECT user_id FROM authz_staff WHERE role='cofounder'`).Scan(&current)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if current != "" && current != user {
		return errCofounderTaken
	}
	if current == user {
		return tx.Commit(ctx)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO authz_staff (user_id,role) VALUES ($1,'cofounder') ON CONFLICT (user_id) DO UPDATE SET role='cofounder'`, user); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (p *postgres) workspaces(ctx context.Context, user string) ([]string, error) {
	rows, err := p.db.Query(ctx, `SELECT org_id FROM authz_members WHERE user_id=$1 AND cardinality(roles)>0 ORDER BY org_id`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var org string
		if err := rows.Scan(&org); err != nil {
			return nil, err
		}
		out = append(out, org)
	}
	return out, rows.Err()
}

func (p *postgres) facts(ctx context.Context, user, org string) (facts, error) {
	tx, err := p.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return facts{}, err
	}
	defer tx.Rollback(ctx)
	f := facts{capabilities: map[string]bool{}}
	err = tx.QueryRow(ctx, `SELECT suspended,payment_required FROM authz_standing WHERE org_id=$1`, org).Scan(&f.suspended, &f.paymentRequired)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return facts{}, err
	}
	var m membership
	err = tx.QueryRow(ctx, `SELECT roles,restrictions,team_ids,project_ids,suspended_at FROM authz_members WHERE org_id=$1 AND user_id=$2`, org, user).Scan(&m.Roles, &m.Restrictions, &m.TeamIDs, &m.ProjectIDs, &m.SuspendedAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return facts{}, err
	}
	if len(m.Roles) == 0 {
		return f, tx.Commit(ctx)
	}
	f.member = true
	f.memberSuspended = m.SuspendedAt != nil
	f.roles = activeRoles(m.Roles)
	managed, err := tx.Query(ctx, `SELECT team_id FROM authz_teams WHERE org_id=$1 AND manager_id=$2 ORDER BY team_id`, org, user)
	if err != nil {
		return facts{}, err
	}
	for managed.Next() {
		var id string
		if err = managed.Scan(&id); err != nil {
			managed.Close()
			return facts{}, err
		}
		f.managed = append(f.managed, id)
	}
	err = managed.Err()
	managed.Close()
	if err != nil {
		return facts{}, err
	}
	rows, err := tx.Query(ctx, `SELECT capabilities,scope,second_step FROM authz_roles WHERE org_id=$1 AND role_key=ANY($2)`, org, f.roles)
	if err != nil {
		return facts{}, err
	}
	scopeSet := map[string]bool{}
	for rows.Next() {
		var caps []string
		var scope string
		var second bool
		if err = rows.Scan(&caps, &scope, &second); err != nil {
			rows.Close()
			return facts{}, err
		}
		for _, c := range caps {
			f.capabilities[c] = true
		}
		if scope != "" && scope != "none" {
			scopeSet[scope] = true
		}
		f.secondStep = f.secondStep || second
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return facts{}, err
	}
	for _, restriction := range m.Restrictions {
		if sc, ok := strings.CutPrefix(restriction, "scope:"); ok {
			delete(scopeSet, sc)
		} else {
			delete(f.capabilities, restriction)
		}
	}
	for _, sc := range scopes {
		if scopeSet[sc] {
			f.scopes = append(f.scopes, sc)
		}
	}
	f.teams, f.projects = teamsSeen(m.TeamIDs, f.managed), m.ProjectIDs
	return f, tx.Commit(ctx)
}

func (p *postgres) check(ctx context.Context, user, org, permission string) (bool, error) {
	if permission == "staff" || permission == "manage_staff" || permission == "tester" {
		r, err := p.staffRole(ctx, user)
		if err != nil {
			return false, err
		}
		if permission == "staff" {
			return r == "owner" || r == "cofounder", nil // system_admin is switched off for now
		}
		if permission == "tester" {
			return r == "tester", nil
		}
		return r == "owner" || r == "cofounder", nil
	}
	f, err := p.facts(ctx, user, org)
	if err != nil {
		return false, err
	}
	switch permission {
	case "member":
		return f.member, nil
	case "manage_access":
		r, err := p.staffRole(ctx, user)
		if err != nil {
			return false, err
		}
		if r == "owner" || r == "cofounder" {
			return true, nil
		}
		m, ok, err := p.membership(ctx, org, user)
		if err != nil {
			return false, err
		}
		if !ok {
			return false, nil
		}
		return slices.ContainsFunc(m.Roles, func(role string) bool { return slices.Contains(heldRoles, role) }), nil
	default:
		return f.capabilities[permission], nil
	}
}
