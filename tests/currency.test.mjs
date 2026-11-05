import assert from "node:assert/strict";
import test from "node:test";
import { convertMinor, currencyCodes, currencyDigits, currencyForCountry, currencyForLocale, currencyName, filterCurrencies, formatMinor, showAmount } from "../src/currency.ts";

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

test("a country says which currency to start with, and an unknown one says nothing", () => {
  assert.equal(currencyForCountry("EG"), "EGP");
  assert.equal(currencyForCountry("gb"), "GBP");
  assert.equal(currencyForCountry("DE"), "EUR");
  assert.equal(currencyForCountry("ZZ"), "");
  assert.equal(currencyForCountry(""), "");
});

test("a cost in one currency is read in another by each one's own decimals", () => {
  const rates = { base: "USD", as_of: "2026-11-05", rates: { USD: 1, EUR: 0.9, EGP: 50, JPY: 150, KWD: 0.3 } };
  assert.equal(convertMinor(10000, "USD", "EUR", rates), 9000);
  assert.equal(convertMinor(9000, "EUR", "USD", rates), 10000);
  assert.equal(convertMinor(10000, "USD", "JPY", rates), 15000);
  assert.equal(convertMinor(10000, "USD", "KWD", rates), 30000);
  assert.equal(convertMinor(500, "EGP", "EGP", rates), 500);
  assert.equal(convertMinor(500, "ZAR", "USD", rates), null);
  assert.equal(convertMinor(500, "USD", "EUR", null), null);
  assert.equal(formatMinor(500000, "EGP", "en").replace(/\s/g, " "), "EGP 5,000.00");
  assert.equal(formatMinor(15000, "JPY", "en").replace(/\s/g, " ").includes("15,000"), true);
});
