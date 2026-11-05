import assert from "node:assert/strict";
import test from "node:test";
import { currencyCodes, currencyDigits, currencyForLocale, currencyName, filterCurrencies, showAmount } from "../src/currency.ts";

test("the list has real currencies, once each, in order", () => {
  const codes = currencyCodes();
  for (const code of ["USD", "EUR", "EGP", "AED", "SAR", "JPY"]) assert.ok(codes.includes(code), `${code} is missing`);
  assert.equal(new Set(codes).size, codes.length);
  assert.deepEqual(codes, [...codes].sort());
});

test("typing finds a currency by its code or its name, best match first", () => {
  const codes = ["AUD", "CAD", "EGP", "EUR", "GBP", "USD"];
  const name = code => ({ AUD: "Australian Dollar", CAD: "Canadian Dollar", EGP: "Egyptian Pound", EUR: "Euro", GBP: "British Pound", USD: "US Dollar" })[code];
  assert.deepEqual(filterCurrencies(codes, "", name), codes);
  assert.deepEqual(filterCurrencies(codes, "eur", name), ["EUR"]);
  assert.deepEqual(filterCurrencies(codes, "egy", name), ["EGP"]);
  assert.deepEqual(filterCurrencies(codes, "dollar", name), ["AUD", "CAD", "USD"]);
  assert.deepEqual(filterCurrencies(codes, "pound", name), ["EGP", "GBP"]);
  assert.deepEqual(filterCurrencies(codes, "e", name)[0], "EGP"); // codes starting with the letter come before names that only contain it
  assert.deepEqual(filterCurrencies(codes, "zzz", name), []);
  assert.equal(currencyName("EGP", "en").toLowerCase().includes("egypt"), true);
});

test("a visitor's language says which currency to start with", () => {
  assert.equal(currencyForLocale("en-GB"), "GBP");
  assert.equal(currencyForLocale("de-DE"), "EUR");
  assert.equal(currencyForLocale("ar-EG"), "EGP");
  assert.equal(currencyForLocale("ar-SA"), "SAR");
  assert.equal(currencyForLocale("ja-JP"), "JPY");
  assert.equal(currencyForLocale("en-US"), "USD");
  assert.equal(currencyForLocale("nonsense-tag-!!"), "USD");
  assert.equal(currencyForLocale(undefined), "USD");
});

test("an amount in dollars reads in another currency, or stays in dollars when there is no rate", () => {
  const rates = { base: "USD", as_of: "2026-11-05", rates: { USD: 1, EUR: 0.9, EGP: 50, JPY: 150 } };
  assert.equal(showAmount(100, "USD", rates, "en"), "$100");
  assert.match(showAmount(100, "EUR", rates, "en"), /^≈ €90.00$/);
  assert.match(showAmount(3, "EUR", rates, "en"), /^≈ €2\.70$/);
  assert.match(showAmount(100, "EGP", rates, "en"), /5,000/);
  assert.match(showAmount(10, "JPY", rates, "en"), /1,500/);
  assert.equal(showAmount(100, "ZAR", rates, "en"), "$100");
  assert.equal(showAmount(100, "EUR", null, "en"), "$100");
  assert.equal(currencyDigits("JPY"), 0);
  assert.equal(currencyDigits("USD"), 2);
  assert.equal(currencyDigits("KWD"), 3);
});
