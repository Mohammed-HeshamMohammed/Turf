import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";

export type Option = { value: string; label: string; description?: string };

/** A dropdown drawn by the app, so its list scrolls and looks like everything else. Arrow keys, Enter and Escape work. */
export function Select({
  value,
  onChange,
  options,
  label,
  icon,
  variant = "field",
  searchable = false,
  placeholder = "Choose",
  portal = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  label: string;
  icon?: IconName;
  variant?: "pill" | "field";
  searchable?: boolean;
  placeholder?: string;
  portal?: boolean;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({});
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? options.filter(option => option.label.toLowerCase().includes(needle)) : options;
  }, [options, query]);
  const selected = options.find(option => option.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !portal) return;
    const box = root.current!.getBoundingClientRect();
    const below = window.innerHeight - box.bottom - 12;
    const above = box.top - 12;
    const upward = below < 280 && above > below;
    const height = Math.max(80, Math.min(320, upward ? above : below));
    const width = Math.min(Math.max(box.width, 240), window.innerWidth - 24);
    setPosition({
      position: "fixed",
      left: Math.max(12, Math.min(box.left, window.innerWidth - width - 12)),
      width,
      minWidth: 0,
      top: upward ? undefined : box.bottom + 6,
      bottom: upward ? window.innerHeight - box.top + 6 : undefined,
      maxHeight: height,
      zIndex: 100,
    });
    const closeOnScroll = (event: Event) => {
      if (menu.current?.contains(event.target as Node)) return;
      const current = root.current?.getBoundingClientRect();
      if (!current || Math.abs(current.top - box.top) > 0.5 || Math.abs(current.left - box.left) > 0.5) setOpen(false);
    };
    const closeOnResize = () => setOpen(false);
    window.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("resize", closeOnResize);
    return () => {
      window.removeEventListener("scroll", closeOnScroll, true);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [open, portal]);

  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const show = () => {
    if (root.current?.closest("fieldset[disabled]")) return;
    setQuery("");
    setActive(
      Math.max(
        0,
        options.findIndex(option => option.value === value),
      ),
    );
    setOpen(true);
  };
  const choose = (option: Option | undefined) => {
    if (!option || root.current?.closest("fieldset[disabled]")) return;
    onChange(option.value);
    setOpen(false);
    root.current?.querySelector("button")?.focus();
  };

  function onKeyDown(event: React.KeyboardEvent) {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        show();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      root.current?.querySelector("button")?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(Math.min(shown.length - 1, active + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(0, active - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(shown.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(shown[active]);
    } else if (event.key === "Tab") setOpen(false);
  }

  const dropdown = open && (
    <div className={`select-menu${portal ? " select-menu-portal" : ""}`} ref={menu} style={portal ? position : undefined}>
      {searchable && (
        <input
          autoFocus
          className="select-search"
          value={query}
          placeholder="Search"
          aria-label={`Search ${label}`}
          onChange={event => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
      )}
      <ul id={id} role="listbox" aria-label={label} ref={list}>
        {shown.map((option, index) => (
          <li
            key={option.value}
            role="option"
            aria-selected={option.value === value}
            className={index === active ? "active" : undefined}
            onPointerEnter={() => setActive(index)}
            onClick={() => choose(option)}
          >
            <span>{option.label}</span>
            {option.description && <small>{option.description}</small>}
          </li>
        ))}
        {!shown.length && <li className="none">Nothing matches</li>}
      </ul>
    </div>
  );

  return (
    <div className={`select select-${variant}`} ref={root} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="select-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${selected?.label ?? placeholder}`}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? setOpen(false) : show())}
      >
        {icon && <Icon name={icon} />}
        <span className={selected ? undefined : "muted"}>{selected?.label ?? placeholder}</span>
        <Icon name="chevron" size={16} />
      </button>
      {portal && dropdown ? createPortal(dropdown, document.body) : dropdown}
    </div>
  );
}
