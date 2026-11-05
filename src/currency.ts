// Currencies for the screens: the list to choose from, a guess at a visitor's own, and showing an amount in another currency.
// The rates are indicative (a free daily source, via the auth service). What a customer is actually charged, and the tax on it, are
// worked out by the payment provider at checkout.

export type Rates = { base: string; as_of: string; rates: Record<string, number> };

/** The currencies a person can choose from: every one the browser knows, or the common ones when it cannot say. */
export function currencyCodes(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  const known = supported ? supported("currency") : [];
  const codes = known.length ? known : ["USD", "EUR", "GBP", "EGP", "AED", "SAR", "CAD", "AUD", "JPY", "INR", "CHF", "CNY", "BRL", "MXN", "ZAR"];
  return [...new Set(codes.map(code => code.toUpperCase()))].sort();
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

const BY_REGION: Record<string, string> = {
  US: "USD", GB: "GBP", CA: "CAD", AU: "AUD", NZ: "NZD", CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON", IS: "ISK",
  TR: "TRY", RU: "RUB", UA: "UAH", IL: "ILS", AE: "AED", SA: "SAR", QA: "QAR", KW: "KWD", BH: "BHD", OM: "OMR", JO: "JOD", EG: "EGP", MA: "MAD", TN: "TND",
  DZ: "DZD", NG: "NGN", GH: "GHS", KE: "KES", ZA: "ZAR", IN: "INR", PK: "PKR", BD: "BDT", LK: "LKR", NP: "NPR", CN: "CNY", HK: "HKD", TW: "TWD", JP: "JPY",
  KR: "KRW", SG: "SGD", MY: "MYR", TH: "THB", VN: "VND", ID: "IDR", PH: "PHP", MX: "MXN", BR: "BRL", AR: "ARS", CL: "CLP", CO: "COP", PE: "PEN", UY: "UYU",
  // The euro area.
  AT: "EUR", BE: "EUR", BG: "EUR", CY: "EUR", DE: "EUR", EE: "EUR", ES: "EUR", FI: "EUR", FR: "EUR", GR: "EUR", HR: "EUR", IE: "EUR", IT: "EUR", LT: "EUR",
  LU: "EUR", LV: "EUR", MT: "EUR", NL: "EUR", PT: "EUR", SI: "EUR", SK: "EUR",
};

/** The currency used in a country (two letters, like "EG"), or "" when it is not one this list knows. */
export const currencyForCountry = (country: string) => BY_REGION[country.toUpperCase()] || "";

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
    return (region && BY_REGION[region]) || "USD";
  } catch {
    return "USD";
  }
}

/** The minor-unit digits a currency has (2 for dollars, 0 for yen, 3 for dinars). */
export function currencyDigits(code: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

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
