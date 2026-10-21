import { ArrowUpRight, CaretDown, CaretRight, CaretUp, CaretUpDown, Check, DotsThree, MagnifyingGlass, Plus, X, WarningCircle } from "@phosphor-icons/react";
import { Children, Fragment, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCrm } from "./context.jsx";
import { avatarSources } from "./avatars.js";

export const money = value => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
/** Bedrooms, bathrooms and area, leaving out what the source did not supply. */
export function propertyFacts(record) {
  return [
    record.beds != null && record.beds + " beds",
    record.baths != null && record.baths + " baths",
    record.area != null && Number(record.area).toLocaleString() + " sq ft",
  ].filter(Boolean);
}
export function Badge({ children, tone = "", className = "" }) {
  return <span className={"badge " + tone + (className ? " " + className : "")}>{children}</span>;
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
export function PageHeader({ title, description, children }) {
  return (
    <header className="page-heading">
      <div>
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
  const ref = useRef(null);
  const [pill, setPill] = useState(null);
  // The white pill slides to the chosen option instead of jumping.
  useLayoutEffect(() => {
    const group = ref.current;
    const measure = () => {
      const button = group.querySelector('[aria-pressed="true"]');
      setPill(button ? { left: button.offsetLeft, width: button.offsetWidth, height: button.offsetHeight, top: button.offsetTop } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    return () => observer.disconnect();
  }, [value, options]);
  return (
    <div className="segmented" role="group" aria-label={label} ref={ref}>
      {pill && <span className="segmented-pill" aria-hidden="true" style={pill} />}
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
const readOrder = id => {
  try {
    const saved = JSON.parse(window.localStorage.getItem("turf.columns." + id));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
};
/**
 * Sorting and column order for a table. `columns` maps an id to { value(row) }: numbers sort as numbers, text alphabetically.
 * The column order is remembered per `tableId`.
 */
export function useTableView(rows, columns, tableId) {
  const [sort, setSort] = useState(null);
  const [order, setOrderState] = useState(() => readOrder(tableId));
  function setOrder(next) {
    setOrderState(next);
    try {
      window.localStorage.setItem("turf.columns." + tableId, JSON.stringify(next));
    } catch {
      // The order still holds for this session.
    }
  }
  let shown = rows;
  if (sort && columns[sort.id]) {
    const get = columns[sort.id].value;
    const direction = sort.dir === "asc" ? 1 : -1;
    shown = [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (typeof x === "number" && typeof y === "number") return direction * (x - y);
      return direction * String(x ?? "").localeCompare(String(y ?? ""), undefined, { numeric: true, sensitivity: "base" });
    });
  }
  // Saved order first; a column the user has never placed goes after them in its natural order.
  const arrange = list => {
    const known = order.map(id => list.find(column => column.id === id)).filter(Boolean);
    return [...known, ...list.filter(column => !order.includes(column.id))];
  };
  return { rows: shown, sort, setSort, arrange, setOrder };
}
/** A column title that sorts when pressed: ascending, then descending, then back to the original order. */
export function SortHeader({ view, id, children, label = typeof children === "string" ? children : id, ...props }) {
  const dir = view.sort?.id === id ? view.sort.dir : null;
  const Caret = dir === "asc" ? CaretUp : dir === "desc" ? CaretDown : CaretUpDown;
  return (
    <th aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined} {...props} className={"sort-th " + (props.className || "")}>
      <button
        type="button"
        className={"sort-button" + (dir ? " is-sorted" : "")}
        title={"Sort by " + label.toLowerCase() + ". Drag the title, or press Alt and an arrow key, to move the column."}
        onClick={() => view.setSort(dir === "asc" ? { id, dir: "desc" } : dir === "desc" ? null : { id, dir: "asc" })}
      >
        <span>{children}</span>
        <Caret size={13} weight={dir ? "bold" : "regular"} aria-hidden="true" />
      </button>
    </th>
  );
}
/**
 * A table whose column titles sort and can be dragged into a new order.
 * `columns`: [{ id, label, cell(row), className? }]. `leading` and `trailing` are fixed columns ({ head, cell(row), className? }).
 */
export function DataTable({ view, columns, rowKey, leading, trailing }) {
  const ordered = view.arrange(columns);
  const [drag, setDrag] = useState(null);
  const justDragged = useRef(false);
  const ids = ordered.map(column => column.id);
  function moveColumn(id, over) {
    if (!over || over === id) return;
    const next = ids.filter(item => item !== id);
    next.splice(next.indexOf(over) + (ids.indexOf(over) > ids.indexOf(id) ? 1 : 0), 0, id);
    view.setOrder(next);
  }
  // Pointer-based, like the board cards, so it behaves the same in browsers and the desktop webview.
  function startDrag(event, column) {
    if (event.button !== 0 || event.pointerType === "touch") return;
    const start = { x: event.clientX, y: event.clientY };
    let active = false;
    let over = null;
    const track = e => {
      if (!active && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) return;
      active = true;
      over = document.elementFromPoint(e.clientX, e.clientY)?.closest("th[data-col]")?.dataset.col ?? null;
      setDrag({ id: column.id, label: column.label, x: e.clientX, y: e.clientY, over });
    };
    const finish = e => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      setDrag(null);
      if (!active) return;
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
      if (e.type !== "pointercancel") moveColumn(column.id, over);
    };
    window.addEventListener("pointermove", track);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }
  function keyMove(event, column, index) {
    const step = event.altKey && { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!step || !ordered[index + step]) return;
    event.preventDefault();
    moveColumn(column.id, ordered[index + step].id);
    requestAnimationFrame(() => document.querySelector('th[data-col="' + column.id + '"] button')?.focus());
  }
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {leading && <th className={leading.className}>{leading.head}</th>}
            {ordered.map((column, index) => (
              <SortHeader
                key={column.id}
                view={view}
                id={column.id}
                data-col={column.id}
                className={
                  (column.className || "") +
                  (drag?.id === column.id ? " is-dragged" : "") +
                  (drag?.over === column.id && drag.id !== column.id ? (ids.indexOf(drag.id) > index ? " drop-before" : " drop-after") : "")
                }
                onPointerDown={event => startDrag(event, column)}
                onClickCapture={event => {
                  if (!justDragged.current) return;
                  event.stopPropagation();
                  event.preventDefault();
                }}
                onKeyDown={event => keyMove(event, column, index)}
              >
                {column.label}
              </SortHeader>
            ))}
            {trailing && <th className={trailing.className}>{trailing.head}</th>}
          </tr>
        </thead>
        <tbody>
          {view.rows.map(row => (
            <tr key={rowKey(row)}>
              {leading && <td className={leading.className}>{leading.cell(row)}</td>}
              {ordered.map(column => (
                <td key={column.id} className={column.className}>
                  {column.cell(row)}
                </td>
              ))}
              {trailing && <td className={trailing.className}>{trailing.cell(row)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {drag && (
        <div className="column-ghost" style={{ transform: `translate(${drag.x + 12}px, ${drag.y + 12}px)` }}>
          {drag.label}
        </div>
      )}
    </div>
  );
}
export function Avatar({ name, avatar, small = false, large = false }) {
  const crm = useCrm();
  const choice = avatar ?? crm?.state.personal?.[name]?.avatar;
  const sources = avatarSources(choice, name);
  const [tried, setTried] = useState({ key: "", index: 0 });
  const key = sources.join("|");
  const index = tried.key === key ? tried.index : 0;
  return (
    <span className={"initials " + (small ? "small " : "") + (large ? "large" : "")} role="img" aria-label={name}>
      <img src={sources[index]} alt="" draggable="false" onError={() => index < sources.length - 1 && setTried({ key, index: index + 1 })} />
    </span>
  );
}
export function Person({ name, link = false }) {
  const crm = useCrm();
  const open = link && crm && name && name !== "Unassigned" && crm.state.role !== "client" && crm.state.role !== "admin";
  if (!open)
    return (
      <span className="person">
        <Avatar name={name} small />
        {name}
      </span>
    );
  // Not a <button>: people sit inside cards that are buttons themselves, and buttons cannot nest.
  const go = event => {
    event.stopPropagation();
    crm.navigate("work/leads?assignee=" + encodeURIComponent(name));
  };
  return (
    <span
      className="person is-link"
      role="link"
      tabIndex={0}
      title={"See " + name + "'s leads"}
      onClick={go}
      onKeyDown={event => (event.key === "Enter" || event.key === " ") && (event.preventDefault(), go(event))}
    >
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
/** The one on/off control used everywhere: a switch, with its label to the right. (Selecting rows in a table keeps plain checkboxes.) */
export function Checkbox({ checked, onChange, label }) {
  return (
    <label className="switch-field">
      <input type="checkbox" role="switch" checked={checked} onChange={onChange} />
      <span className="switch-track" aria-hidden="true" />
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
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
export const EXIT_MS = 190;

/**
 * Keeps something mounted for a moment after it is hidden so it can animate out.
 * `mounted` says whether to render it; `leaving` says to play the exit animation.
 */
export function usePresence(show, ms = EXIT_MS) {
  const [mounted, setMounted] = useState(show);
  useEffect(() => {
    if (show) return setMounted(true);
    const timer = setTimeout(() => setMounted(false), reducedMotion() ? 0 : ms);
    return () => clearTimeout(timer);
  }, [show, ms]);
  return { mounted: show || mounted, leaving: !show && mounted };
}
/** The last truthy value, so content can keep showing what it was while it animates out. */
export function useHeld(value) {
  const held = useRef(value);
  if (value) held.current = value;
  return value || held.current;
}
/**
 * A removed element is gone from the page at once, so to let it animate out we leave a non-interactive copy behind
 * and take that away when the animation ends. Call it while the element is still attached, e.g. from a layout-effect cleanup.
 */
export function exitGhost(node, { className = "", parent, backdrop = false } = {}) {
  if (!node?.isConnected || reducedMotion()) return;
  const host = parent || node.offsetParent || document.body;
  const ghost = node.cloneNode(true);
  ghost.removeAttribute("open");
  ghost.removeAttribute("id");
  ghost.setAttribute("inert", "");
  ghost.setAttribute("aria-hidden", "true");
  ghost.classList.add("exit-ghost", className);
  if (!backdrop) {
    ghost.style.cssText += `left:${node.offsetLeft}px;top:${node.offsetTop}px;width:${node.offsetWidth}px;`;
  }
  const extras = [ghost];
  if (backdrop) {
    const veil = document.createElement("div");
    veil.className = "exit-veil";
    extras.unshift(veil);
  }
  extras.forEach(item => host.appendChild(item));
  setTimeout(() => extras.forEach(item => item.remove()), EXIT_MS + 60);
}
/** A page's content. It fades in briefly when it arrives; the page you leave is simply replaced, so nothing overlaps or waits. */
export function PageTransition({ children }) {
  return <div className="page-content">{children}</div>;
}
export function Modal({ title, children, onClose }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => exitGhost(dialog, { className: "modal-ghost", parent: document.body, backdrop: true });
  }, []);
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
/** A second look before anything is removed: says what will happen and takes a clear yes or no. */
export function ConfirmDialog({ title, children, confirmLabel, danger = false, onConfirm, onClose }) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="body-copy">{children}</div>
      <div className="row confirm-actions">
        <Button onClick={onClose}>Keep it</Button>
        <Button variant={danger ? "danger-button" : "primary"} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
/**
 * Keeps a page's header to one main action: everything secondary (and anything that removes something) sits in here.
 * `items` is a list of { label, icon, onClick, danger, hidden }.
 */
export function MoreMenu({ items, label = "More" }) {
  const [open, setOpen] = useState(false);
  const presence = usePresence(open);
  const root = useRef(null);
  const shown = items.filter(item => item && !item.hidden);
  useEffect(() => {
    if (!open) return undefined;
    root.current?.querySelector('[role="menuitem"]')?.focus();
    const outside = event => !root.current?.contains(event.target) && setOpen(false);
    const escape = event => {
      if (event.key !== "Escape") return;
      setOpen(false);
      root.current?.querySelector('[aria-haspopup="menu"]')?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  if (!shown.length) return null;
  return (
    <div className="more-menu" ref={root}>
      <button type="button" className="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <DotsThree size={18} weight="bold" />
        <span>{label}</span>
      </button>
      {presence.mounted && (
        <div
          className={"more-menu-panel" + (presence.leaving ? " leaving" : "")}
          role="menu"
          onKeyDown={event => {
            const entries = [...event.currentTarget.querySelectorAll('[role="menuitem"]')];
            const at = entries.indexOf(document.activeElement);
            const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
            if (step) {
              event.preventDefault();
              entries[(at + step + entries.length) % entries.length]?.focus();
            }
            if (event.key === "Tab") setOpen(false);
          }}
        >
          {shown.map(item => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={item.danger ? "danger" : ""}
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
              >
                {Icon && <Icon size={17} />}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
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
  const presence = usePresence(open);
  const hostRef = useRef(null);
  if (open) hostRef.current = trigger.current?.closest("dialog, .turf-menu, .personal-menu") || document.body;
  const host = presence.mounted ? hostRef.current : null;

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
            className={"select-menu" + (presence.leaving ? " leaving" : "")}
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
