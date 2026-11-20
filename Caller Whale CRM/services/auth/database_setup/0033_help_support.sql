-- Build step 40: help and feedback (D292-D295, D309).

-- "What's new" notes, written by staff. A note for some roles shows only to them; a note tied to a switch shows only where that
-- switch is on. Owners see every note (the fuller list). Each person sees each note once.
CREATE TABLE whats_new (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  body text NOT NULL CHECK (length(body) BETWEEN 3 AND 4000),
  roles text[] NOT NULL DEFAULT '{}',          -- empty: everyone
  feature text NOT NULL DEFAULT '',            -- a switch name; empty: everywhere
  kind text NOT NULL DEFAULT 'feature' CHECK (kind IN ('feature', 'terms', 'fix')),
  published_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL
);
CREATE INDEX whats_new_published ON whats_new (published_at DESC);

CREATE TABLE whats_new_seen (
  user_id uuid NOT NULL,
  note_id uuid NOT NULL REFERENCES whats_new(id) ON DELETE CASCADE,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, note_id)
);

-- Support conversations between an agency's owner or admins and Caller Whale's staff (D292).
CREATE TABLE support_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  opened_by uuid NOT NULL,
  subject text NOT NULL CHECK (length(subject) BETWEEN 3 AND 150),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  waiting_on text NOT NULL DEFAULT 'staff' CHECK (waiting_on IN ('staff', 'agency')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_threads_org ON support_threads (org_id, updated_at DESC);
CREATE INDEX support_threads_waiting ON support_threads (status, waiting_on, updated_at);

CREATE TABLE support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  author_id uuid NOT NULL,
  from_staff boolean NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_messages_thread ON support_messages (thread_id, created_at);

-- "Send feedback": the note, the page (its path only, with ids taken out) and the app version. No lead data (D295).
CREATE TABLE feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  org_id uuid,
  page text NOT NULL DEFAULT '' CHECK (length(page) <= 300),
  version text NOT NULL DEFAULT '' CHECK (length(version) <= 60),
  note text NOT NULL CHECK (length(note) BETWEEN 3 AND 3000),
  created_at timestamptz NOT NULL DEFAULT now(),
  handled_at timestamptz,
  handled_by uuid
);
CREATE INDEX feedback_open ON feedback (handled_at, created_at DESC);
