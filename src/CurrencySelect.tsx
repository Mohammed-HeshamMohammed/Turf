import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { currencyCodes, currencyName, filterCurrencies } from "./currency.ts";

/**
 * A currency chooser you can type into: "egy" finds the Egyptian pound, "eur" the euro. Arrow keys move, Enter chooses, Escape closes.
 * It is a standard combobox (an input that owns a list), so screen readers and keyboards work as they do for a native select.
 */
export function CurrencySelect({ value, onChange, label, required = false, codes }: { value: string; onChange: (code: string) => void; label: string; required?: boolean; codes?: string[] }) {
  const id = useId();
  const all = useMemo(() => codes || currencyCodes(), [codes]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => filterCurrencies(all, query), [all, query]);
  const choose = (code: string) => { onChange(code); setOpen(false); setQuery(""); };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActive(index => Math.min(index + 1, shown.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); }
    else if (event.key === "Enter" && open) { event.preventDefault(); if (shown[active]) choose(shown[active]); }
    else if (event.key === "Escape") { setOpen(false); setQuery(""); }
  };
  return <label className="currency-select">{label}
    <input ref={input} role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={open && shown[active] ? `${id}-${shown[active]}` : undefined}
      autoComplete="off" spellCheck={false} required={required}
      value={open ? query : value ? `${value} — ${currencyName(value)}` : ""} placeholder="Search currencies"
      onFocus={event => { setOpen(true); setActive(Math.max(0, all.indexOf(value))); event.currentTarget.select(); }}
      onChange={event => { setQuery(event.target.value); setActive(0); setOpen(true); }}
      onBlur={() => { setOpen(false); setQuery(""); }} onKeyDown={onKey} />
    {open && <ul id={`${id}-list`} role="listbox" aria-label={`${label}: matching currencies`}>
      {shown.length === 0 ? <li className="none" role="presentation">No currency matches “{query}”.</li> : shown.slice(0, 80).map((code, index) =>
        <li key={code} id={`${id}-${code}`} role="option" aria-selected={code === value} className={index === active ? "active" : undefined}
          onMouseDown={event => { event.preventDefault(); choose(code); }} onMouseEnter={() => setActive(index)}>
          <strong>{code}</strong><span>{currencyName(code)}</span>
        </li>)}
    </ul>}
  </label>;
}
