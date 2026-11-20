-- Build step 4: the #tag after each person's name, as their sign-in says it, so the directory can tell two people of the same name apart.
ALTER TABLE people ADD COLUMN tag text NOT NULL DEFAULT '';
