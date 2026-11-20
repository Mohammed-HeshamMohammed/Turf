-- Build step 28, part B: Google Calendar per person (D158-D160). A person connects their own Google account; Caller Whale asks only to
-- see when they are busy (calendar.freebusy) and to keep a calendar of its own in their account (calendar.app.created), never to read or
-- change their other events. Busy times are not offered as slots; an appointment becomes an event in the "Caller Whale" calendar holding
-- the time and a link that opens the lead inside the right agency, never the lead's name or number (D159). When a person's work is
-- handed on, their appointments and events move to whoever takes it (D160).
-- These tables belong to the person, not to an agency, so they have no agency row security; only this service reads them, by person.

CREATE TABLE google_accounts (
  user_id uuid PRIMARY KEY,
  refresh_token bytea NOT NULL,          -- encrypted with GOOGLE_TOKEN_KEY (AES-GCM)
  calendar_id text NOT NULL,             -- the "Caller Whale" calendar made in their account
  connected_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE google_states (
  state text PRIMARY KEY,
  user_id uuid NOT NULL,
  expires_at timestamptz NOT NULL
);

-- The event each appointment has on someone's Caller Whale calendar, kept by person so it can be removed whichever agency it is for.
CREATE TABLE google_events (
  appointment_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  event_id text NOT NULL
);
CREATE INDEX google_events_person ON google_events (user_id, org_id);
