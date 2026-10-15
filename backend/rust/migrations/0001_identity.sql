-- Identity, organizations, roles and grants. Rust owns these migrations (plan 2.2).
-- Run as the owning role; the API connects as turf_app, which never bypasses row security (plan 2.4).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'turf_app') THEN
    CREATE ROLE turf_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- The organization the current request acts in. Empty outside a request, which matches no row.
CREATE OR REPLACE FUNCTION turf_org() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('turf.org_id', true), '')::uuid $$;

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  timezone text NOT NULL DEFAULT 'UTC',
  -- Bumped on every role, grant, team or sharing change: invalidates caches and offline copies (plan 2.4).
  access_revision bigint NOT NULL DEFAULT 1,
  data_revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  totp_secret text,             -- base32, set once MFA is confirmed
  totp_pending text,            -- base32 awaiting first code
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recovery_codes (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  PRIMARY KEY (user_id, code_hash)
);

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  UNIQUE (org_id, name)
);

-- Role presets (plan 3.1). capabilities and scope may be overridden per organization.
CREATE TABLE roles (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  capabilities text[] NOT NULL,
  scope text NOT NULL CHECK (scope IN ('own', 'team', 'project', 'organization', 'shared', 'none')),
  PRIMARY KEY (org_id, key)
);

CREATE TABLE memberships (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  roles text[] NOT NULL,
  -- Explicit restrictions override combined grants (plan 3.1).
  restrictions text[] NOT NULL DEFAULT '{}',
  team_ids uuid[] NOT NULL DEFAULT '{}',
  project_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE invitations (
  token_hash text PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email citext NOT NULL,
  roles text[] NOT NULL,
  team_ids uuid[] NOT NULL DEFAULT '{}',
  invited_by uuid REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('browser', 'desktop')),
  mfa_passed boolean NOT NULL DEFAULT false,
  access_revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;

-- Identity tables are read only by authentication code, before an organization is chosen; they carry no org rows to
-- isolate. Every business table below carries org_id and row security.
GRANT SELECT, INSERT, UPDATE, DELETE ON organizations, users, recovery_codes, teams, roles, memberships, invitations, sessions TO turf_app;
