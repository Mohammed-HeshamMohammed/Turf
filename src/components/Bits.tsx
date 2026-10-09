import type { ReactNode } from "react";
import { VERDICT_LABELS } from "../lib/marks";
import type { Verdict } from "../lib/types";
import { Icon } from "./Icon";
import { Select, type Option } from "./Select";

export function VerdictPill({ verdict }: { verdict: Verdict | null }) {
  if (!verdict) return <span className="pill pill-none">Not checked</span>;
  return <span className={`pill pill-${verdict}`}>{VERDICT_LABELS[verdict]}</span>;
}

/** A labelled dropdown for forms. `None` is offered first when the choice is optional. */
export function Field({ label, value, onChange, options, optional, searchable }: {
  label: string; value: string | null; onChange: (value: string | null) => void; options: Option[]; optional?: string; searchable?: boolean;
}) {
  return (
    <div className="field">
      <span>{label}</span>
      <Select label={label} value={value ?? ""} onChange={next => onChange(next || null)} searchable={searchable} placeholder={optional ?? "Choose"}
        options={optional ? [{ value: "", label: optional }, ...options] : options} />
    </div>
  );
}

export function Check({ checked, onChange, children, disabled, label }: {
  checked: boolean; onChange: (checked: boolean) => void; children?: ReactNode; disabled?: boolean; label?: string;
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={event => onChange(event.target.checked)} />
      <i aria-hidden="true"><Icon name="check" size={13} /></i>
      {children}
    </label>
  );
}

export function SearchBox({ value, onChange, placeholder = "Search" }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="search-box">
      <Icon name="search" />
      <input type="search" value={value} placeholder={placeholder} aria-label={placeholder} onChange={event => onChange(event.target.value)} />
    </label>
  );
}

export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: { value: T; label: string; disabled?: boolean }[]; value: T; onChange: (value: T) => void; label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(option => (
        <button key={option.value} type="button" disabled={option.disabled} aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** The thin bar strip from the mockup's stat cards: one bar per value, the largest drawn solid. */
export function MiniBars({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <div className="mini-bars" aria-hidden="true">
      {values.map((value, index) => (
        <i key={index} className={value / max > 0.6 ? "tall" : ""} style={{ height: `${Math.max(14, (value / max) * 100)}%` }} />
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}
