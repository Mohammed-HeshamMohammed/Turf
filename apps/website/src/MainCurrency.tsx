import { useEffect, useState } from "react";
import type { Auth } from "@callerwhale/auth-client";
import { CurrencySelect } from "./CurrencySelect.tsx";
import { applyLiveCurrencyData, currencyForCountry, currencyForLocale, currencyName, type Rates } from "./currency.ts";

type Fx = Rates & { country?: string; currency?: string; digits?: Record<string, number>; regions?: Record<string, string> };

/**
 * A person's main currency: the one amounts are shown in. Until they choose, it is worked out for them: where they are (the country
 * the server saw the request come from), then their language, then US dollars. `saved` is what they chose, if anything.
 */
export function useMainCurrency(load: () => Promise<Fx | null>, saved: string | undefined) {
  const [fx, setFx] = useState<Fx | null>(null);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    let live = true;
    load().then(answer => {
      if (!live) return;
      applyLiveCurrencyData(answer); // the server's live currency tables replace the ones shipped with the page
      setFx(answer);
      setAsked(true);
    }, () => { if (live) setAsked(true); });
    return () => { live = false; };
  }, []);
  const detected = fx?.currency || (fx?.country && currencyForCountry(fx.country)) || currencyForLocale(typeof navigator === "undefined" ? undefined : navigator.language);
  const rates = fx && fx.rates ? fx : null;
  // `ratesUnavailable`: the question was asked and no rates came back, so amounts fall back to US dollars, the main price.
  return { currency: saved || detected, detected, automatic: !saved, rates, country: fx?.country, ratesUnavailable: asked && !rates };
}

/** The Profile page's "Main currency" setting, beside the connected accounts. */
export function MainCurrency({ auth, authBase, saved, onSaved }: { auth: Auth; authBase: string; saved: string; onSaved: () => void }) {
  const main = useMainCurrency(() => fetch(`${authBase}/v1/fx`).then(res => (res.ok ? res.json() : null)), saved);
  const [choice, setChoice] = useState(saved || "");
  const [state, setState] = useState({ busy: false, message: "", error: "" });
  useEffect(() => setChoice(saved || ""), [saved]);
  const shown = choice || main.detected;
  const save = async (value: string) => {
    setState({ busy: true, message: "", error: "" });
    try {
      const token = await auth.accessToken();
      if (!token) throw new Error("Sign in again to continue.");
      const response = await fetch(`${authBase}/v1/me/currency`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ currency: value }) });
      const answer = await response.json().catch(() => null);
      if (!response.ok) throw new Error(answer?.error || "Could not save your currency.");
      setChoice(value);
      setState({ busy: false, message: value ? `Amounts will show in ${value}.` : "Back to automatic.", error: "" });
      onSaved();
    } catch (error) {
      setState({ busy: false, message: "", error: error instanceof Error ? error.message : "Could not save your currency." });
    }
  };
  return <section className="card profile-card" aria-labelledby="main-currency-title">
    <h2 id="main-currency-title">Main currency</h2>
    <p className="muted">{main.automatic && !choice ? `Automatic: ${main.detected} (${currencyName(main.detected)}).` : "Your choice, until you change it."}</p>
    <CurrencySelect label="Currency" value={shown} onChange={code => setChoice(code)} />
    <div className="profile-actions">
      <button type="button" className="button primary" disabled={state.busy || !choice || choice === saved} onClick={() => void save(choice)}>{state.busy ? "Saving…" : "Save currency"}</button>
      {saved && <button type="button" className="button raised" disabled={state.busy} onClick={() => void save("")}>Use automatic</button>}
    </div>
    {main.ratesUnavailable && <p role="status" className="notice">Exchange rates are not available right now, so amounts show in US dollars, the main price, until they are.</p>}
    {state.message && <p role="status" className="notice good">{state.message}</p>}
    {state.error && <p role="alert" className="notice bad">{state.error}</p>}
  </section>;
}
