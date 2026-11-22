-- Build step 26, part C: the assistant's summary of a call, a draft for its agent until they put it in the wrap-up's notes (D320, D322).
ALTER TABLE calls ADD COLUMN ai_summary text NOT NULL DEFAULT '';
