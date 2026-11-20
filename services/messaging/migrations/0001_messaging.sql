-- Conversations between people in a workspace, and later with leads by text. Every table carries org_id and is under row
-- security: a request sees only the workspace named in its transaction settings (cw.org_id) and only the conversations the
-- person (cw.user_id) is in, whatever a query forgets to say. Plan: docs/plans/messaging-sms-voice.md.

CREATE FUNCTION cw_org() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('cw.org_id', true), '')::uuid $$;
CREATE FUNCTION cw_user() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('cw.user_id', true), '')::uuid $$;

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('direct', 'group', 'lead')),
  title text NOT NULL DEFAULT '',
  direct_key text,                              -- the two people of a direct chat, smaller id first: one chat per pair
  lead_id uuid,                                 -- kind 'lead': the CRM lead this thread is with
  external_number text,                         -- kind 'lead': the number texts go to and come from
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seq bigint NOT NULL DEFAULT 0,           -- the number of the newest message; each message takes the next one
  last_message_at timestamptz,
  UNIQUE (org_id, direct_key)
);

CREATE TABLE members (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  org_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  last_read_seq bigint NOT NULL DEFAULT 0,      -- unread = the conversation's last_seq minus this
  muted boolean NOT NULL DEFAULT false,
  archived boolean NOT NULL DEFAULT false,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX members_by_person ON members (org_id, user_id) WHERE left_at IS NULL;

CREATE TABLE messages (
  id uuid PRIMARY KEY,                          -- made by the app before sending, so a retry is the same message
  org_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  sender_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'note', 'system', 'poll')),
  transport text NOT NULL DEFAULT 'internal' CHECK (transport IN ('internal', 'sms')),
  body text NOT NULL DEFAULT '',
  reply_to uuid,
  mentions uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (conversation_id, seq),
  -- A team note never leaves by text: the database refuses it whatever the service is asked.
  CHECK (NOT (kind = 'note' AND transport <> 'internal'))
);

CREATE TABLE reactions (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  emoji text NOT NULL,
  org_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE polls (
  message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  question text NOT NULL,
  options jsonb NOT NULL                        -- ["Monday", "Tuesday"]
);

CREATE TABLE poll_votes (
  message_id uuid NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  org_id uuid NOT NULL,
  option int NOT NULL,                          -- one vote per person; voting again moves it
  PRIMARY KEY (message_id, user_id)
);

-- What still has to be told to the live server (Centrifugo). Written in the same transaction as the change it announces, so a
-- crash between the two cannot lose a live update; a sender reads it in order and deletes what was delivered.
CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  method text NOT NULL,                         -- Centrifugo API method: broadcast
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION cw_member(p_conversation uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = p_conversation AND m.user_id = cw_user() AND m.left_at IS NULL)
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversations', 'members', 'messages', 'reactions', 'polls', 'poll_votes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Membership rows are visible across the workspace (they say who is in a conversation, never what was said); everything that
-- carries content is visible only to the conversation's members.
CREATE POLICY org_isolation ON members USING (org_id = cw_org()) WITH CHECK (org_id = cw_org());
CREATE POLICY members_only ON conversations USING (org_id = cw_org() AND (created_by = cw_user() OR cw_member(id))) WITH CHECK (org_id = cw_org());
CREATE POLICY members_only ON messages USING (org_id = cw_org() AND cw_member(conversation_id)) WITH CHECK (org_id = cw_org() AND cw_member(conversation_id));
CREATE POLICY members_only ON reactions USING (org_id = cw_org() AND EXISTS (SELECT 1 FROM messages m WHERE m.id = message_id)) WITH CHECK (org_id = cw_org());
CREATE POLICY members_only ON polls USING (org_id = cw_org() AND EXISTS (SELECT 1 FROM messages m WHERE m.id = message_id)) WITH CHECK (org_id = cw_org());
CREATE POLICY members_only ON poll_votes USING (org_id = cw_org() AND EXISTS (SELECT 1 FROM messages m WHERE m.id = message_id)) WITH CHECK (org_id = cw_org());

-- One message as the apps receive it. A deleted message keeps its place and loses its words.
CREATE FUNCTION message_json(m messages) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', m.id, 'conversation_id', m.conversation_id, 'seq', m.seq, 'sender_id', m.sender_id, 'kind', m.kind, 'transport', m.transport,
    'body', CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END,
    'reply_to', m.reply_to, 'mentions', to_jsonb(m.mentions), 'created_at', m.created_at, 'edited_at', m.edited_at, 'deleted', m.deleted_at IS NOT NULL,
    'reactions', coalesce((SELECT jsonb_agg(jsonb_build_object('emoji', r.emoji, 'user_id', r.user_id) ORDER BY r.created_at) FROM reactions r WHERE r.message_id = m.id), '[]'::jsonb),
    'poll', (SELECT jsonb_build_object('question', p.question, 'options', p.options,
      'votes', coalesce((SELECT jsonb_agg(jsonb_build_object('user_id', v.user_id, 'option', v.option)) FROM poll_votes v WHERE v.message_id = m.id), '[]'::jsonb))
      FROM polls p WHERE p.message_id = m.id AND m.deleted_at IS NULL))
$$;

-- One conversation as the person asking sees it: their own unread count and settings, everyone in it, and its newest message.
CREATE FUNCTION conversation_json(c conversations) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', c.id, 'kind', c.kind, 'title', c.title, 'created_by', c.created_by, 'created_at', c.created_at,
    'last_seq', c.last_seq, 'last_message_at', c.last_message_at,
    'last_read_seq', me.last_read_seq, 'unread', greatest(c.last_seq - me.last_read_seq, 0), 'muted', me.muted, 'archived', me.archived,
    'members', (SELECT jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role, 'last_read_seq', m.last_read_seq) ORDER BY m.joined_at, m.user_id)
      FROM members m WHERE m.conversation_id = c.id AND m.left_at IS NULL),
    'last_message', (SELECT message_json(x) FROM messages x WHERE x.conversation_id = c.id AND x.seq = c.last_seq))
  FROM members me WHERE me.conversation_id = c.id AND me.user_id = cw_user()
$$;
