// Currencies for the screens: the list to choose from, a guess at a visitor's own, and showing an amount in another currency.
// The rates are indicative (a free daily source, via the auth service). What a customer is actually charged, and the tax on it, are
// worked out by the payment provider at checkout.

import { CURRENCY_DIGITS, REGION_CURRENCY } from "./currency-data.ts";

export type Rates = { base: string; as_of: string; rates: Record<string, number> };

/** The currencies a person can choose from: every current ISO 4217 currency (generated from the standard), sorted. */
export function currencyCodes(): string[] {
  return Object.keys(CURRENCY_DIGITS).sort();
}

/** "Egyptian Pound" for EGP, in the visitor's language; the code itself when the browser has no name for it. */
export function currencyName(code: string, locale?: string): string {
  try {
    return new Intl.DisplayNames(locale ? [locale] : undefined, { type: "currency" }).of(code) || code;
  } catch {
    return code;
  }
}

/** Codes whose code or name contains what was typed, best matches first: the code itself, then codes starting with it, then names. */
export function filterCurrencies(codes: string[], query: string, name: (code: string) => string = currencyName): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return codes;
  const rank = (code: string) => {
    const c = code.toLowerCase(), n = name(code).toLowerCase();
    if (c === q) return 0;
    if (c.startsWith(q)) return 1;
    if (n.startsWith(q)) return 2;
    if (n.split(/[\s-]+/).some(word => word.startsWith(q))) return 3;
    if (n.includes(q)) return 4;
    return -1;
  };
  return codes.map(code => ({ code, r: rank(code) })).filter(entry => entry.r >= 0).sort((a, b) => a.r - b.r || a.code.localeCompare(b.code)).map(entry => entry.code);
}

/** The currency used in a country (two letters, like "EG"), or "" when it is not one this list knows. */
export const currencyForCountry = (country: string) => REGION_CURRENCY[country.toUpperCase()] || "";

/** An amount in one currency's minor unit (cents) as the same amount in another's, or null when there is no rate for either. */
export function convertMinor(minor: number, from: string, to: string, rates: Rates | null): number | null {
  if (from === to) return minor;
  const a = rates?.rates[from], b = rates?.rates[to];
  if (!a || !b) return null;
  return Math.round(minor / 10 ** currencyDigits(from) / a * b * 10 ** currencyDigits(to));
}

/** An amount in a currency's minor unit, written for people ("EGP 5,000.00"). */
export function formatMinor(minor: number, currency: string, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 10 ** currencyDigits(currency));
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

/** The currency most likely used where a language tag says the person is (en-GB: GBP). US dollars when it cannot tell. */
export function currencyForLocale(tag: string | undefined): string {
  try {
    const region = new Intl.Locale(tag || "en-US").maximize().region;
    return (region && REGION_CURRENCY[region]) || "USD";
  } catch {
    return "USD";
  }
}

/** The minor-unit digits a currency has (2 for dollars, 0 for yen, 3 for dinars), from ISO 4217. */
export const currencyDigits = (code: string) => CURRENCY_DIGITS[code] ?? 2;

/** An amount of US dollars as it reads in another currency: "≈ €92", or plain dollars when there is no rate. */
export function showAmount(usd: number, currency: string, rates: Rates | null, locale?: string): string {
  const plain = `$${usd.toLocaleString("en-US")}`;
  const rate = rates?.rates[currency];
  if (currency === "USD" || !rate) return plain;
  const value = usd * rate;
  const whole = value >= 100 || currencyDigits(currency) === 0;
  try {
    return `≈ ${new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: whole ? 0 : currencyDigits(currency), minimumFractionDigits: whole ? 0 : currencyDigits(currency) }).format(value)}`;
  } catch {
    return plain;
  }
}
