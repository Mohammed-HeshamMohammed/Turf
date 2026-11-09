-- A username for every person: the address of their own page (callerwhale.com/their-username). Made from the display name (or the start
-- of the email), lower case letters, digits and hyphens; where two people would get the same one, the later gets -2, -3 and so on.
-- Words the website uses for its own pages are never given out (the same list is in username.go).
ALTER TABLE users ADD COLUMN username TEXT;

WITH base AS (
  SELECT id, created_at,
         left(btrim(regexp_replace(lower(coalesce(nullif(btrim(display_name), ''), split_part(email, '@', 1))), '[^a-z0-9]+', '-', 'g'), '-'), 24) AS slug
  FROM users
), fixed AS (
  SELECT id, created_at,
         CASE WHEN length(slug) < 3 OR slug IN ('account', 'admin', 'api', 'assets', 'auth', 'billing', 'connect', 'contact', 'dashboard', 'features', 'forgot', 'gate', 'help', 'home', 'login', 'logout', 'mcp', 'notifications', 'pricing', 'privacy', 'profile', 'security', 'settings', 'signin', 'signout', 'signup', 'support', 'terms', 'why-caller-whale')
              THEN slug || '-user' ELSE slug END AS slug
  FROM base
), numbered AS (
  SELECT id, slug, row_number() OVER (PARTITION BY slug ORDER BY created_at, id) AS n FROM fixed
)
UPDATE users u SET username = CASE WHEN numbered.n > 1 THEN numbered.slug || '-' || numbered.n ELSE numbered.slug END
FROM numbered WHERE u.id = numbered.id;

CREATE UNIQUE INDEX users_username ON users (username);
