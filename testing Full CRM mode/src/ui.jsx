import { ArrowUpRight, CaretDown, CaretRight, Check, MagnifyingGlass, Plus, X, WarningCircle } from "@phosphor-icons/react";
import { Children, Fragment, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCrm } from "./context.jsx";
import { avatarSource } from "./avatars.js";

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
export function Avatar({ name, avatar, small = false, large = false }) {
  const crm = useCrm();
  const choice = avatar ?? crm?.state.personal?.[name]?.avatar;
  return (
    <span className={"initials " + (small ? "small " : "") + (large ? "large" : "")} role="img" aria-label={name}>
      <img src={avatarSource(choice, name)} alt="" draggable="false" />
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
/** The one notification count used everywhere (sidebar rail, top tabs, bell): capped, never zero. */
export function CountBadge({ count, label = "notifications", className = "" }) {
  if (!(count > 0)) return null;
  return (
    <span className={"count-badge " + className} role="status" aria-label={count + " " + label}>
      {count > 99 ? "99+" : count}
    </span>
  );
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

/** Flattens <option> children (including fragments and mapped arrays) into plain option records. */
function readOptions(children) {
  const options = [];
  const visit = nodes =>
    Children.forEach(nodes, child => {
      if (!isValidElement(child)) return;
      if (child.type === Fragment) return visit(child.props.children);
      if (child.type !== "option") return;
      const label = Children.toArray(child.props.children).join("");
      options.push({ value: String(child.props.value ?? label), label, disabled: Boolean(child.props.disabled) });
    });
  visit(children);
  return options;
}

/**
 * Themed replacement for the native <select>: same props (value / defaultValue / onChange / name / disabled and <option> children),
 * but the menu is drawn by the app. onChange receives an event-like { target: { value, name } }.
 */
export function Select({ children, value, defaultValue, onChange, name, id, disabled, className = "", "aria-label": ariaLabel }) {
  const options = readOptions(children);
  const controlled = value !== undefined;
  const [inner, setInner] = useState(() => String(defaultValue ?? options[0]?.value ?? ""));
  const current = controlled ? String(value) : inner;
  const selected = options.find(option => option.value === current);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  const typed = useRef({ text: "", at: 0 });
  const listId = useId();
  const host = open ? trigger.current?.closest("dialog, .turf-menu, .personal-menu") || document.body : null;

  function choose(option) {
    if (!option || option.disabled) return;
    if (!controlled) setInner(option.value);
    onChange?.({ target: { value: option.value, name }, currentTarget: { value: option.value, name } });
    setOpen(false);
  }
  function show() {
    if (disabled) return;
    setActive(
      Math.max(
        0,
        options.findIndex(option => option.value === current),
      ),
    );
    setPlace(null);
    setOpen(true);
  }
  function step(from, direction) {
    for (let index = from + direction; index >= 0 && index < options.length; index += direction) if (!options[index].disabled) return index;
    return from;
  }

  useLayoutEffect(() => {
    if (!open || !menu.current || !trigger.current) return;
    const box = trigger.current.getBoundingClientRect();
    const height = Math.min(menu.current.scrollHeight, 280);
    const below = window.innerHeight - box.bottom - 12;
    const up = below < height && box.top > below;
    const width = Math.max(box.width, 170);
    setPlace({
      left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)),
      top: up ? Math.max(8, box.top - height - 6) : box.bottom + 6,
      width,
      maxHeight: Math.max(120, Math.min(280, up ? box.top - 14 : below)),
    });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = event => {
      if (!trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) setOpen(false);
    };
    const scrolled = event => {
      if (!menu.current?.contains(event.target)) setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  useEffect(() => {
    if (open) menu.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, active, place]);

  function onKeyDown(event) {
    const last = options.length - 1;
    if (event.key === "Tab") return setOpen(false);
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        show();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      return setOpen(false);
    }
    const moves = { ArrowDown: step(active, 1), ArrowUp: step(active, -1), Home: step(-1, 1), End: step(last + 1, -1) };
    if (event.key in moves) {
      event.preventDefault();
      return setActive(moves[event.key]);
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      return choose(options[active]);
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + event.key.toLowerCase(), at: now };
      const match = options.findIndex(option => !option.disabled && option.label.toLowerCase().startsWith(typed.current.text));
      if (match >= 0) setActive(match);
    }
  }

  return (
    <span className={"select " + className}>
      <button
        type="button"
        ref={trigger}
        id={id}
        className="select-trigger"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? listId + "-" + active : undefined}
        disabled={disabled}
        onClick={event => {
          event.preventDefault();
          open ? setOpen(false) : show();
        }}
        onKeyDown={onKeyDown}
      >
        <span className="select-value">{selected?.label ?? " "}</span>
        <CaretDown size={13} weight="bold" className="select-caret" />
      </button>
      {name && <input type="hidden" name={name} value={current} />}
      {host &&
        createPortal(
          <div
            ref={menu}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            className="select-menu"
            style={place ? { left: place.left, top: place.top, minWidth: place.width, maxHeight: place.maxHeight } : { visibility: "hidden", left: 0, top: 0 }}
            onPointerDown={event => event.preventDefault()}
          >
            {options.map((option, index) => (
              <div
                key={option.value + index}
                id={listId + "-" + index}
                role="option"
                aria-selected={option.value === current}
                aria-disabled={option.disabled || undefined}
                data-active={index === active}
                className="select-option"
                onPointerMove={() => !option.disabled && setActive(index)}
                onClick={() => choose(option)}
              >
                <span>{option.label}</span>
                {option.value === current && <Check size={14} weight="bold" />}
              </div>
            ))}
          </div>,
          host,
        )}
    </span>
  );
}
