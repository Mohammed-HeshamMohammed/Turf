-- A lead has one name and one phone, the best to call. Everyone and every way to reach them sits beside: the owners (a list may name
-- two for one property), every phone with its line type where the list said it, every email.
-- {"owners": ["John Smith", "Mary Smith"], "phones": [{"number": "5125550100", "type": "mobile"}], "emails": ["j@example.com"]}
ALTER TABLE crm.leads ADD COLUMN IF NOT EXISTS contacts jsonb NOT NULL DEFAULT '{}';
ALTER TABLE importing.rows ADD COLUMN IF NOT EXISTS contacts jsonb;

-- The address key of a holding row, worked out once when the row is stored instead of in every statement that compares addresses.
ALTER TABLE importing.rows ADD COLUMN IF NOT EXISTS addr_key text;

-- "123 Main Street" and "123 Main St" are one address, and so are "North" and "N": the usual street words and directions are brought
-- to their short forms (the USPS ones) before the address is compared. Only the key changes; the address as written is kept.
-- The words are looked up one by one in a small table rather than replaced by one regular expression each: PostgreSQL keeps only 32
-- compiled expressions per connection, and two dozen more in every row made it compile them again and again.
CREATE OR REPLACE FUNCTION importing.addr_words(a text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(string_agg(coalesce('{"street":"st","avenue":"ave","boulevard":"blvd","drive":"dr","road":"rd","lane":"ln","court":"ct","place":"pl",
      "circle":"cir","highway":"hwy","parkway":"pkwy","terrace":"ter","trail":"trl","square":"sq","northeast":"ne","northwest":"nw",
      "southeast":"se","southwest":"sw","north":"n","south":"s","east":"e","west":"w","apartment":"apt","suite":"ste"}'::jsonb ->> w, w), '' ORDER BY i), '')
  FROM unnest(string_to_array(translate(lower(coalesce(a, '')), '.,#/-', '     '), ' ')) WITH ORDINALITY AS t(w, i)
$$;

CREATE OR REPLACE FUNCTION importing.addr_key(address text, zip text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN a ~ '[0-9]' AND a <> '' THEN a || '|' || left(regexp_replace(coalesce(zip, ''), '[^0-9a-zA-Z]', '', 'g'), 5) END
  FROM (SELECT regexp_replace(importing.addr_words(address), '[^0-9a-z]', '', 'g') AS a) x
$$;
