-- Firebase as the account store (src/firebase.rs). Only used when AUTH_FIREBASE_API_KEY is set; otherwise these stay empty.
-- Same portable SQL as the others: text, Unix seconds, no vendor syntax.

-- The session's Firebase refresh token, kept on the server so it can ask Firebase for a fresh ID token when the person
-- changes their password, sets up an authenticator or asks for another confirmation email. Never sent to a browser.
ALTER TABLE sessions ADD COLUMN fb_refresh TEXT;
-- A Google sign-in waiting for its authenticator code: JSON with Firebase's pending credential and enrollment id.
ALTER TABLE sessions ADD COLUMN fb_pending TEXT;

-- The same two, carried from the finished provider sign-in to the session that collects it.
ALTER TABLE oauth_handoffs ADD COLUMN fb_refresh TEXT;
ALTER TABLE oauth_handoffs ADD COLUMN fb_pending TEXT;
