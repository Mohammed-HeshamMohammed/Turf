import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { CurrencySelect } from "../CurrencySelect.tsx";
import { currencyForLocale, showAmount, type Rates } from "../currency.ts";

const authBase = import.meta.env.VITE_CALLERWHALE_AUTH_URL || "http://localhost:8101";
const STORED = "cw-currency";

type Display = { currency: string; setCurrency: (code: string) => void; rates: Rates | null; format: (usd: number) => string };

const DisplayCurrency = createContext<Display>({ currency: "USD", setCurrency: () => {}, rates: null, format: usd => `$${usd.toLocaleString("en-US")}` });

/** What a price reads as: dollars until the visitor's currency (their remembered choice, else their language's) and its rate are known. */
export const useMoney = () => useContext(DisplayCurrency).format;

export function DisplayCurrencyProvider({ children }: { children: ReactNode }) {
  // Dollars on the server and for the first paint, so the page built ahead of time and the page in the browser match.
  const [currency, setCurrencyState] = useState("USD");
  const [rates, setRates] = useState<Rates | null>(null);
  useEffect(() => {
    let saved = "";
    try { saved = localStorage.getItem(STORED) || ""; } catch { /* a private window can refuse storage */ }
    setCurrencyState(saved || currencyForLocale(navigator.language));
  }, []);
  // Rates are fetched only for a visitor who is not paying in dollars, and once.
  useEffect(() => {
    if (currency === "USD" || rates) return;
    let live = true;
    fetch(`${authBase}/v1/fx`).then(res => (res.ok ? res.json() : null)).then(body => { if (live && body?.rates) setRates(body as Rates); }, () => {});
    return () => { live = false; };
  }, [currency, rates]);
  const setCurrency = (code: string) => {
    setCurrencyState(code);
    try { localStorage.setItem(STORED, code); } catch { /* the choice just is not remembered */ }
  };
  const value = useMemo<Display>(() => ({ currency, setCurrency, rates, format: usd => showAmount(usd, currency, rates, navigator.language) }), [currency, rates]);
  return <DisplayCurrency.Provider value={value}>{children}</DisplayCurrency.Provider>;
}

/** The chooser and what it means, for the top of the pricing page. */
export function CurrencyBar() {
  const { currency, setCurrency, rates } = useContext(DisplayCurrency);
  const converted = currency !== "USD" && Boolean(rates?.rates[currency]);
  return <div className="currency-bar">
    <CurrencySelect label="Show prices in" value={currency} onChange={setCurrency} />
    <p className="fine" role="status">
      {currency === "USD" ? "Prices are in US dollars. Choose your currency to see roughly what that is for you. Any sales tax or VAT is added at checkout, where it applies."
        : converted ? `Converted from US dollars at the rate of ${rates?.as_of}, so treat it as a guide. The exact amount in your currency, with any sales tax or VAT, is shown at checkout before you pay.`
        : "Looking up today's rate… until then prices show in US dollars. The exact amount in your currency, with any tax, is shown at checkout."}
    </p>
  </div>;
}
