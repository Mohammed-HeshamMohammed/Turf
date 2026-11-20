-- What the platform owner and cofounders enter about running costs, so the dashboard can work out profit and return.
-- Same portable SQL as 0001: text ids, Unix-second times. Amounts are in the currency's smallest unit (cents).
CREATE TABLE IF NOT EXISTS platform_costs (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  category TEXT NOT NULL,        -- hosting, tools, marketing, staff_pay or other
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,        -- three capital letters, like USD
  repeats TEXT NOT NULL,         -- monthly, yearly or once
  note TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
