-- Sign-in moves to Firebase Authentication (docs/plans/firebase-auth.md). Its uid is a string Firebase picks, so each
-- person keeps their id here and the uid is stored beside it. An account moved from the auth service is imported into
-- Firebase with its id as its uid and linked the first time it arrives.
ALTER TABLE users ADD COLUMN firebase_uid text UNIQUE CHECK (length(firebase_uid) BETWEEN 1 AND 128);
