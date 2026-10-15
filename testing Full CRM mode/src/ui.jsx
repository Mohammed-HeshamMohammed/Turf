import { ArrowUpRight, CaretRight, Check, MagnifyingGlass, Plus, X, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { useCrm } from "./context.jsx";

export const money = value => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
/** Bedrooms, bathrooms and area, leaving out what the source did not supply. */
export function propertyFacts(record) {
  return [
    record.beds != null && record.beds + " beds",
    record.baths != null && record.baths + " baths",
    record.area != null && Number(record.area).toLocaleString() + " sq ft",
  ].filter(Boolean);
}
export function Badge({ children, tone = "" }) {
  return <span className={"badge " + tone}>{children}</span>;
}
export function Button({ children, variant = "", icon: Icon, ...props }) {
  return (
    <button type="button" className={"button " + variant} {...props}>
      {Icon && <Icon size={17} />}
      <span>{children}</span>
    </button>
  );
}
export function RoundButton({ label, onClick, icon: Icon = ArrowUpRight, ...props }) {
  return (
    <button type="button" className="round-button" aria-label={label} title={label} onClick={onClick} {...props}>
      <Icon size={20} />
    </button>
  );
}
export function PageHeader({ eyebrow, title, description, children }) {
  return (
    <header className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow || "Oak & Palm Partners"}</div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      <div className="page-actions">{children}</div>
    </header>
  );
}
export function Card({ title, subtitle, children, action, className = "" }) {
  return (
    <section className={"card " + className}>
      {title && (
        <header>
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}
export function Empty({ title = "Nothing here yet", children, action }) {
  return (
    <div className="empty">
      <WarningCircle size={28} weight="light" />
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Field({ label, children, help }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {help && <small>{help}</small>}
    </label>
  );
}
export function Search({ value, onChange, placeholder = "Search leads", label = placeholder }) {
  return (
    <label className="search">
      <MagnifyingGlass size={18} />
      <input aria-label={label} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} />
      {value && (
        <button type="button" aria-label="Clear search" onClick={() => onChange("")}>
          <X size={15} />
        </button>
      )}
    </label>
  );
}
export function Segmented({ value, options, onChange, label }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(option => {
        const item = typeof option === "string" ? { id: option, label: option } : option;
        return (
          <button key={item.id} type="button" aria-pressed={value === item.id} onClick={() => onChange(item.id)}>
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
export function Avatar({ name, small = false }) {
  return (
    <span className={"initials " + (small ? "small" : "")} aria-label={name}>
      {name
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map(word => word[0])
        .join("")}
    </span>
  );
}
export function Person({ name }) {
  return (
    <span className="person">
      <Avatar name={name} small />
      {name}
    </span>
  );
}
export function LeadLink({ lead, detail = true }) {
  const { navigate } = useCrm();
  return (
    <button className="lead-link" onClick={() => navigate("work/leads/" + lead.id)}>
      <strong>{lead.name}</strong>
      {detail && (
        <small>
          {lead.address}, {lead.city}
        </small>
      )}
    </button>
  );
}
export function Status({ value }) {
  const tone = /Ready|Qualified|Checked|Accepted|Closed won|Connected|Done|Reviewed/.test(value)
    ? "good"
    : /Interested|Requested|Pending|High|Under contract|Draft/.test(value)
      ? "peach"
      : /Closed|Wrong|Conflict|Do not call|Declined|Failed/.test(value)
        ? "danger"
        : "";
  return <Badge tone={tone}>{value}</Badge>;
}
export function Checkbox({ checked, onChange, label }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}
export function Breadcrumb({ items }) {
  const { navigate } = useCrm();
  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      {items.map((item, index) => (
        <span key={index}>
          {index > 0 && <CaretRight size={13} />}
          {item.path ? <button onClick={() => navigate(item.path)}>{item.label}</button> : item.label}
        </span>
      ))}
    </nav>
  );
}
export function Modal({ title, children, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <dialog className="modal" ref={ref} onCancel={onClose}>
      <header>
        <h2>{title}</h2>
        <RoundButton icon={X} label="Close dialog" onClick={onClose} />
      </header>
      {children}
    </dialog>
  );
}
export function downloadCsv(filename, rows) {
  const escape = value => '"' + String(value ?? "").replaceAll('"', '""') + '"';
  const csv = rows.map(row => row.map(escape).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function AddButton({ children, ...props }) {
  return (
    <Button icon={Plus} variant="primary" {...props}>
      {children}
    </Button>
  );
}
export function Saved({ children = "Saved" }) {
  return (
    <span className="saved">
      <Check size={14} />
      {children}
    </span>
  );
}
