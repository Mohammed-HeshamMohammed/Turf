-- Emails waiting to go out (D-notifications queue, 2026-11-22). A request saves the finished message here and answers at once; the
-- sender delivers it, retrying with a growing wait when the mail server is slow, down or refuses for now. A row is deleted the
-- moment its email is accepted, or when it can never be sent, or when it is too old to matter (a sign-in code after 10 minutes),
-- so the table holds only what is still on its way. It holds the message itself, sign-in codes included, for that short time only.
CREATE TABLE mail_queue (
  id          bigserial PRIMARY KEY,
  caller      text NOT NULL,                       -- the service that asked (its name in NOTIFY_TOKENS), or "contact" for the website form
  template    text NOT NULL,
  message     jsonb NOT NULL,                      -- the rendered Message: to, reply_to, subject, text, html
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,                -- not sent by then: dropped (and logged)
  next_try_at timestamptz NOT NULL DEFAULT now(),  -- also the lease: a sender that takes a row pushes this two minutes ahead
  tries       int NOT NULL DEFAULT 0,
  last_error  text
);

CREATE INDEX mail_queue_due ON mail_queue (next_try_at);
