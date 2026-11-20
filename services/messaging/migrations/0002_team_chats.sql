-- Build step 16, part B: every team has its own chat that follows the team (D52, D185), the agency has one announcements
-- channel with everyone in it (D74, D350), and messages can mention a team, everyone or the leads (D86).

ALTER TABLE conversations DROP CONSTRAINT conversations_kind_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_kind_check CHECK (kind IN ('direct', 'group', 'lead', 'team', 'announcements'));
ALTER TABLE conversations ADD COLUMN team_id uuid;     -- kind 'team': the authz team it follows
ALTER TABLE conversations ADD CONSTRAINT one_chat_per_team UNIQUE (org_id, team_id);
CREATE UNIQUE INDEX one_announcements_channel ON conversations (org_id) WHERE kind = 'announcements';

ALTER TABLE messages ADD COLUMN important boolean NOT NULL DEFAULT false;      -- an announcement marked important (D350)
ALTER TABLE messages ADD COLUMN mention_groups text[] NOT NULL DEFAULT '{}';   -- 'everyone', 'managers', 'team', 'team:<id>'

-- That a team chat or the announcements channel exists, and its name, is not private: anyone in the workspace may see the row, so
-- the service can keep them in step with the teams whoever is asking. What is said in them stays with their members.
DROP POLICY members_only ON conversations;
CREATE POLICY members_only ON conversations
  USING (org_id = cw_org() AND (created_by = cw_user() OR cw_member(id) OR kind IN ('team', 'announcements')))
  WITH CHECK (org_id = cw_org());

CREATE OR REPLACE FUNCTION message_json(m messages) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', m.id, 'conversation_id', m.conversation_id, 'seq', m.seq, 'sender_id', m.sender_id, 'kind', m.kind, 'transport', m.transport,
    'body', CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END,
    'reply_to', m.reply_to, 'mentions', to_jsonb(m.mentions), 'mention_groups', to_jsonb(m.mention_groups), 'important', m.important,
    'created_at', m.created_at, 'edited_at', m.edited_at, 'deleted', m.deleted_at IS NOT NULL,
    'reactions', coalesce((SELECT jsonb_agg(jsonb_build_object('emoji', r.emoji, 'user_id', r.user_id) ORDER BY r.created_at) FROM reactions r WHERE r.message_id = m.id), '[]'::jsonb),
    'poll', (SELECT jsonb_build_object('question', p.question, 'options', p.options,
      'votes', coalesce((SELECT jsonb_agg(jsonb_build_object('user_id', v.user_id, 'option', v.option)) FROM poll_votes v WHERE v.message_id = m.id), '[]'::jsonb))
      FROM polls p WHERE p.message_id = m.id AND m.deleted_at IS NULL))
$$;

CREATE OR REPLACE FUNCTION conversation_json(c conversations) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', c.id, 'kind', c.kind, 'title', c.title, 'team_id', c.team_id, 'created_by', c.created_by, 'created_at', c.created_at,
    'last_seq', c.last_seq, 'last_message_at', c.last_message_at,
    'last_read_seq', me.last_read_seq, 'unread', greatest(c.last_seq - me.last_read_seq, 0), 'muted', me.muted, 'archived', me.archived,
    'members', (SELECT jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role, 'last_read_seq', m.last_read_seq) ORDER BY m.joined_at, m.user_id)
      FROM members m WHERE m.conversation_id = c.id AND m.left_at IS NULL),
    'last_message', (SELECT message_json(x) FROM messages x WHERE x.conversation_id = c.id AND x.seq = c.last_seq))
  FROM members me WHERE me.conversation_id = c.id AND me.user_id = cw_user() AND me.left_at IS NULL
$$;
