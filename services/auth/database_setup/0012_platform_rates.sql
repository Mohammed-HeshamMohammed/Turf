-- Costs that follow the customers: the price of a call minute and of a gigabyte, and the payment provider's cut of each payment.
-- Rates are in millionths of the currency unit (0.0085 a minute is 8500) because per-minute prices are fractions of a cent.
CREATE TABLE IF NOT EXISTS platform_rates (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,            -- minute, gb or payment_fee
  rate_micros BIGINT NOT NULL DEFAULT 0,
  quantity BIGINT NOT NULL DEFAULT 0,       -- gb: gigabytes used each month
  percent_bp INTEGER NOT NULL DEFAULT 0,    -- payment_fee: hundredths of a percent (290 is 2.9%)
  fixed_micros BIGINT NOT NULL DEFAULT 0,   -- payment_fee: fixed amount per payment
  currency TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
