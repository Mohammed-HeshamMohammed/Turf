import {
  ArrowUpRight,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  CaretUpDown,
  Check,
  Columns,
  DotsThree,
  MagnifyingGlass,
  Plus,
  X,
  WarningCircle,
} from "@phosphor-icons/react";
import { Children, Fragment, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCrm } from "./context.jsx";
import { avatarSources } from "./avatars.ts";
import { today } from "./data.ts";
import { DatePicker as SharedDatePicker } from "@callerwhale/calendar";
import "@callerwhale/calendar/calendar.css";

/** Source lists often arrive in capitals ("AADINA SHAREEF", "7014 SANTA RITA DR"). Shown in ordinary case; text that already has lower case is left as it is. */
export const tidyCase = text => {
  const value = String(text ?? "");
  return /[A-Z]/.test(value) && value === value.toUpperCase() ? value.toLowerCase().replace(/(^|[\s\-'/(])([a-z])/g, (_, edge, letter) => edge + letter.toUpperCase()) : value;
};
/** A bare ten-digit (or +1 eleven-digit) number is shown as (832) 260-6117; anything already formatted is left alone. */
export const formatPhone = value => {
  const text = String(value ?? "").trim();
  const digits = text.replace(/^\+/, "");
  if (!/^\d+$/.test(digits)) return text;
  const national = digits.length === 11 && digits[0] === "1" ? digits.slice(1) : digits;
  return national.length === 10 ? `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}` : text;
};
/** A count that stays short as it grows: 9,870 stays as it is, 427,877 becomes 427.9K, 1,250,000 becomes 1.3M. */
export const count = value => (Math.abs(value) < 10000 ? Number(value).toLocaleString("en-US") : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value));
export const money = value => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
/** Bedrooms, bathrooms, area, units and year built, leaving out what the source did not supply. */
export function propertyFacts(record) {
  return [
    record.beds != null && record.beds + " beds",
    record.baths != null && record.baths + " baths",
    record.area != null && Number(record.area).toLocaleString() + " sq ft",
    record.units > 1 && record.units + " units",
    record.yearBuilt != null && "Built " + record.yearBuilt,
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
export function PageHeader({ title, titleAside, description, children, shared }) {
  return (
    <header className="page-heading">
      <div className={titleAside ? "page-title-controls" : undefined}>
        <h1 style={shared ? { viewTransitionName: shared } : undefined}>{title}</h1>
        {titleAside}
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
    const saved = JSON.parse(window.localStorage.getItem("callerwhale.columns." + id));
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
      window.localStorage.setItem("callerwhale.columns." + tableId, JSON.stringify(next));
    } catch {
      // The order still holds for this session.
    }
  }
  // Columns the person has switched off, remembered per table like the order.
  const [hidden, setHiddenState] = useState(() => readHidden(tableId));
  function setHidden(next) {
    setHiddenState(next);
    try {
      window.localStorage.setItem("callerwhale.hidden-columns." + tableId, JSON.stringify(next));
    } catch {
      // The choice still holds for this session.
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
  return { rows: shown, sort, setSort, arrange, setOrder, hidden, setHidden };
}
const readHidden = id => {
  try {
    const saved = JSON.parse(window.localStorage.getItem("callerwhale.hidden-columns." + id));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
};
/** "Columns": which of a table's columns are shown. At least one stays; "Show all" brings the rest back. */
function ColumnMenu({ view, columns }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(null);
  const button = useRef(null);
  const panel = useRef(null);
  const presence = usePresence(open);
  const hidden = view.hidden || [];
  const visible = columns.filter(column => !hidden.includes(column.id)).length;
  useEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const box = button.current?.getBoundingClientRect();
      if (box) setAt({ top: box.bottom + 6, right: Math.max(8, window.innerWidth - box.right) });
    };
    place();
    const outside = event => !panel.current?.contains(event.target) && !button.current?.contains(event.target) && setOpen(false);
    const escape = event => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  const toggle = id => view.setHidden(hidden.includes(id) ? hidden.filter(item => item !== id) : [...hidden, id]);
  return (
    <>
      <button ref={button} type="button" className="column-menu-button" aria-haspopup="true" aria-expanded={open} title="Choose columns" aria-label="Choose columns" onClick={() => setOpen(!open)}>
        <Columns size={17} />
      </button>
      {presence.mounted &&
        createPortal(
          <div
            ref={panel}
            className={"column-menu-panel" + (presence.leaving ? " leaving" : "")}
            role="dialog"
            aria-label="Columns"
            style={at ? { top: at.top, right: at.right } : { visibility: "hidden", top: 0, right: 0 }}
          >
            <header>
              <strong>Columns</strong>
              <button type="button" className="column-menu-reset" disabled={!hidden.length} onClick={() => view.setHidden([])}>
                Show all
              </button>
            </header>
            {columns.map(column => {
              const shown = !hidden.includes(column.id);
              return (
                <label key={column.id}>
                  <input type="checkbox" checked={shown} disabled={shown && visible <= 1} onChange={() => toggle(column.id)} />
                  <span>{typeof column.label === "string" ? column.label : column.id}</span>
                </label>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
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
/**
 * Long lists draw a page at a time, so a list of tens of thousands of rows stays quick. Answers the rows to draw and
 * the "Show more" bar (null when everything is shown).
 */
export function useShowMore(items, step = 100) {
  const [count, setCount] = useState(step);
  if (items.length <= count) return [items, null];
  const next = Math.min(step, items.length - count);
  return [
    items.slice(0, count),
    <div className="show-more" key="show-more">
      <span>
        Showing {count.toLocaleString()} of {items.length.toLocaleString()}
      </span>
      <Button onClick={() => setCount(count + step)}>Show {next.toLocaleString()} more</Button>
    </div>,
  ];
}

/**
 * `paged`: the table shows as many rows as fit the window (never fewer than 5) and pages through the rest with Previous and
 * Next, instead of growing with "Show more". A taller or wider window shows more rows at once.
 */
export function DataTable({ view, columns, rowKey, leading, trailing, paged = false, remote = null, onRowClick = null, filler = null }) {
  const arranged = view.arrange(columns);
  const ordered = arranged.filter(column => !(view.hidden || []).includes(column.id));
  const [shown, more] = useShowMore(view.rows);
  const [page, setPage] = useState(0);
  const [fit, setFit] = useState(10);
  const rowHeight = useRef(58);
  const hasRows = view.rows.length > 0;
  const size = paged ? fit : 0;
  // `remote` { total, page, onPage, onSize }: the rows given are already the one page the server sent; the pager only steps through it.
  const total = remote ? remote.total : view.rows.length;
  const pages = paged ? Math.max(1, Math.ceil(total / size)) : 1;
  const at = Math.min(remote ? remote.page : page, pages - 1);
  const setAt = remote ? remote.onPage : setPage;
  const rows = remote ? view.rows : paged ? view.rows.slice(at * size, (at + 1) * size) : shown;
  useEffect(() => {
    if (remote && paged) remote.onSize(fit);
  }, [fit, paged, Boolean(remote)]); // eslint-disable-line react-hooks/exhaustive-deps
  const [drag, setDrag] = useState(null);
  const justDragged = useRef(false);
  const ids = ordered.map(column => column.id);
  const layout = ids.join("|");
  const tableRef = useRef(null);
  const before = useRef(null);
  // Where each column's header sits. Every cell of a column shares its header's left edge, so the header is all that is measured.
  const columnLefts = () => new Map([...(tableRef.current?.querySelectorAll("th[data-col]") || [])].map(cell => [cell.dataset.col, cell.getBoundingClientRect().left]));
  const lefts = useRef(new Map());
  const knownIds = useRef(ids);
  // Columns slide to their new place (FLIP): measured before the change, then each cell starts at its old position and eases to the new one.
  // A column that was not there (shown again by "Hide empty fields", or by a wider window) fades in where it lands. One that has gone is simply
  // gone, and the others close the gap.
  useLayoutEffect(() => {
    const from = before.current || (knownIds.current.join("|") !== layout ? lefts.current : null);
    const added = ids.filter(id => !knownIds.current.includes(id));
    before.current = null;
    knownIds.current = ids;
    if (!from || reducedMotion() || !tableRef.current) return;
    const now = columnLefts();
    tableRef.current.querySelectorAll("[data-col], [data-cell]").forEach(cell => {
      const id = cell.dataset.col || cell.dataset.cell.slice(cell.dataset.cell.lastIndexOf(":") + 1);
      if (added.includes(id)) {
        cell.animate([{ opacity: 0, transform: "translateX(-10px)" }, { opacity: 1, transform: "none" }], { duration: 300, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
        return;
      }
      const shift = (from.get(id) ?? now.get(id)) - now.get(id);
      if (Math.abs(shift) > 1)
        cell.animate([{ transform: `translateX(${shift}px)` }, { transform: "none" }], { duration: 300, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- animate when the layout changes; ids follow from it
  }, [layout]);
  // Remembered after every change, so the next one knows where the columns were.
  useLayoutEffect(() => {
    lefts.current = columnLefts();
  });
  // How many rows fit between the table's top and the bottom of the window, leaving room for the pager.
  useLayoutEffect(() => {
    if (!paged) return;
    const measure = () => {
      const table = tableRef.current;
      if (!table) return;
      const pane = table.closest(".main-content");
      const height = pane?.clientHeight || window.innerHeight;
      const top = table.getBoundingClientRect().top - (pane ? pane.getBoundingClientRect().top - pane.scrollTop : 0);
      const head = table.tHead?.offsetHeight || 40;
      // The height of a real row, remembered: an empty page (a search with few matches) must not change how many rows fit.
      const real = table.tBodies[0]?.querySelector("tr:not(.filler-row)")?.offsetHeight;
      if (real) rowHeight.current = real;
      const row = rowHeight.current;
      // Below the rows sit the pager and the pane's own bottom padding; everything else is for rows.
      const below = 54 + (pane ? parseFloat(getComputedStyle(pane).paddingBottom) || 0 : 0);
      setFit(Math.max(5, Math.min(100, Math.floor((height - top - head - below) / row))));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [paged, hasRows]);
  function moveColumn(id, over) {
    if (!over || over === id) return;
    before.current = columnLefts();
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
    <div className={"table-scroll" + (arranged.length > 1 ? " has-column-menu" : "")}>
      {arranged.length > 1 && <ColumnMenu view={view} columns={arranged} />}
      <table ref={tableRef}>
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
          {rows.map(row => (
            <tr
              key={rowKey(row)}
              className={onRowClick ? "is-clickable" : undefined}
              onClick={onRowClick ? event => !event.target.closest("a, button, input, select, textarea, label, summary, [role=link]") && onRowClick(row) : undefined}
            >
              {leading && <td className={leading.className}>{leading.cell(row)}</td>}
              {ordered.map(column => (
                <td key={column.id} className={column.className} data-cell={rowKey(row) + ":" + column.id}>
                  {column.cell(row)}
                </td>
              ))}
              {trailing && <td className={trailing.className}>{trailing.cell(row)}</td>}
            </tr>
          ))}
          {/* `filler` keeps a paged table the same size whatever a page holds: empty rows fill it (with a message or loading
              bars), so searching and paging never make the page jump. */}
          {filler && paged &&
            Array.from({ length: Math.max(0, size - rows.length) }, (_, i) => (
              <tr key={"filler-" + i} className={"filler-row" + (filler.loading ? " is-loading" : "")} aria-hidden={i > 0 || rows.length > 0 ? "true" : undefined}>
                <td colSpan={ordered.length + (leading ? 1 : 0) + (trailing ? 1 : 0)} style={{ height: rowHeight.current }}>
                  {filler.loading ? <span className="filler-bar" /> : i === 0 && rows.length === 0 ? filler.empty : null}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      {paged ? (
        total > size && (
          <div className="show-more pager">
            <span className="pager-buttons">
              <RoundButton icon={CaretLeft} label="Previous page" disabled={at === 0} onClick={() => setAt(at - 1)} />
              <RoundButton icon={CaretRight} label="Next page" disabled={at >= pages - 1} onClick={() => setAt(at + 1)} />
            </span>
            <span className="pager-range" title={`${(at * size + 1).toLocaleString()}–${Math.min((at + 1) * size, total).toLocaleString()} of ${total.toLocaleString()}`}>
              {count(at * size + 1)}–{count(Math.min((at + 1) * size, total))} of {count(total)}
            </span>
          </div>
        )
      ) : (
        more
      )}
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
  // Connected: my own picture from my account, everyone else's from the team list (crm-core keeps each person's account picture).
  const remote = crm?.state.remote;
  const fromTeam = remote ? (remote.user?.name === name && remote.user?.avatar) || (remote.people || []).find(person => person.name === name)?.avatar || undefined : undefined;
  const choice = avatar ?? fromTeam ?? crm?.state.personal?.[name]?.avatar;
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
export function Person({ name, link = false, compact = false }) {
  const crm = useCrm();
  // When everyone in a column is the same person, the name says nothing new on each row: the face stays, the name is in the tooltip.
  if (compact)
    return (
      <span className="person is-compact" title={name}>
        <Avatar name={name} small />
        <span className="sr-only">{name}</span>
      </span>
    );
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
      <strong>{tidyCase(lead.name)}</strong>
      {detail && (
        <small>
          {tidyCase(lead.address)}, {tidyCase(lead.city)}
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
      : /Closed|Wrong|Conflict|Do not call|Declined|Failed|Useless/.test(value)
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
const reducedMotion = () => typeof window !== "undefined" &&
  (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || Boolean(document.querySelector(".crm-window.reduce-motion")));
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
/**
 * Saves rows as a CSV file. In a browser it downloads; the desktop window has no download bar, so the file goes to
 * the Downloads folder and is shown in the file manager. Either way a "callerwhale-saved" event says where it went.
 */
export function downloadCsv(filename, rows) {
  const escape = value => '"' + String(value ?? "").replaceAll('"', '""') + '"';
  const csv = rows.map(row => row.map(escape).join(",")).join("\r\n");
  const saved = detail => window.dispatchEvent(new CustomEvent("callerwhale-saved", { detail }));
  if (window.__TAURI_INTERNALS__) {
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("save_download", { filename, contents: "﻿" + csv }))
      .then(
        path => saved({ path }),
        reason => saved({ error: String(reason) }),
      );
    return;
  }
  saved({ path: filename, browser: true });
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
  if (open) hostRef.current = trigger.current?.closest("dialog, .callerwhale-menu, .personal-menu") || document.body;
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

const pad = number => String(number).padStart(2, "0");
/**
 * Themed replacement for <input type="date">: Caller Whale's calendar (@callerwhale/calendar), drawn by the app, not the browser.
 * Same props as Select (value / defaultValue / onChange / name / disabled), values are "YYYY-MM-DD", plus min and max.
 * onChange receives an event-like { target: { value, name } }.
 */
export function DatePicker(props) {
  return (
    <SharedDatePicker
      today={today()}
      className="select"
      triggerClassName="select-trigger"
      portalHost="dialog, .callerwhale-menu, .personal-menu"
      {...props}
    />
  );
}

/** Themed replacement for <input type="time">: a list of times every 15 minutes (24-hour, like the rest of the app). Values are "HH:MM". */
export function TimePicker({ value, defaultValue, onChange, name, disabled, required, id, "aria-label": ariaLabel }) {
  const current = value ?? defaultValue ?? "";
  const times = Array.from({ length: 96 }, (_, index) => pad(Math.floor(index / 4)) + ":" + pad((index % 4) * 15));
  if (current && !times.includes(current)) (times.push(current), times.sort());
  return (
    <Select id={id} name={name} aria-label={ariaLabel} disabled={disabled} {...(value !== undefined ? { value } : { defaultValue })} onChange={onChange}>
      {!required && <option value="">No time</option>}
      {times.map(time => (
        <option key={time}>{time}</option>
      ))}
    </Select>
  );
}

/** Themed replacement for <input type="datetime-local">: a date picker and a time picker side by side. Values are "YYYY-MM-DDTHH:MM". */
export function DateTimePicker({ value, onChange, min, disabled, "aria-label": ariaLabel }) {
  const [date = "", time = ""] = (value || "").split("T");
  const emit = next => onChange?.({ target: { value: next }, currentTarget: { value: next } });
  return (
    <div className="datetime">
      <DatePicker
        aria-label={ariaLabel + ", date"}
        value={date}
        min={min?.split("T")[0]}
        disabled={disabled}
        onChange={event => emit(event.target.value ? event.target.value + "T" + (time || "10:00") : "")}
      />
      <TimePicker
        aria-label={ariaLabel + ", time"}
        value={time}
        required
        disabled={disabled}
        onChange={event => emit((date || today()) + "T" + event.target.value)}
      />
    </div>
  );
}

/**
 * Board columns share the board's width by priority. An empty stage starts as a slim rail; every stage with cards gets
 * a full column while they fit. When they do not, the lowest-priority full columns fold into rails: a column the
 * person opened most recently comes first, then the one with more cards, then the earlier stage. Opening a rail makes
 * it the highest priority, so the column that matters least folds to make room.
 */
export function useBoardColumns(ids, counts, { min = 230, rail = 52, gap = 13 } = {}) {
  // A callback ref, so the width is measured whenever the board appears (it is absent while a list view shows).
  const [el, setEl] = useState(null);
  const [width, setWidth] = useState(0);
  const [opened, setOpened] = useState([]);
  const [closed, setClosed] = useState([]);
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  const wanted = ids.filter(id => !closed.includes(id) && (counts[id] > 0 || opened.includes(id)));
  const rank = id => {
    const recent = opened.indexOf(id);
    return [recent === -1 ? Infinity : recent, -(counts[id] || 0), ids.indexOf(id)];
  };
  const byPriority = [...wanted].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  // Full columns that fit beside the rails: e·min + (e−1)·gap + (n−e)·(rail+gap) ≤ width.
  const fit = width ? Math.max(1, Math.floor((width + gap - ids.length * (rail + gap)) / (min - rail))) : ids.length;
  const expanded = new Set(byPriority.slice(0, fit));
  return {
    ref: setEl,
    isOpen: id => expanded.has(id),
    /** Stage order on screen: folded stages gather at the nearer edge (first half left, second half right), keeping their order, so open columns sit together. */
    arrange: list => {
      const half = list.length / 2;
      const folded = (id, i) => !expanded.has(id) && (i < half ? "start" : "end");
      return [...list.filter((id, i) => folded(id, i) === "start"), ...list.filter(id => expanded.has(id)), ...list.filter((id, i) => folded(id, i) === "end")];
    },
    toggle: id => {
      if (expanded.has(id)) {
        setClosed(list => [...list.filter(item => item !== id), id]);
        setOpened(list => list.filter(item => item !== id));
      } else {
        setOpened(list => [id, ...list.filter(item => item !== id)]);
        setClosed(list => list.filter(item => item !== id));
      }
    },
  };
}

/** One stage of a board: a full column, or a slim rail with its name and count that opens the column. */
export function BoardColumn({ board, id, count, unit, over, children }) {
  const open = board.isOpen(id);
  const className = "kanban-column" + (open ? "" : " collapsed") + (over ? " drop-target" : "");
  if (!open) {
    return (
      <section className={className} data-stage={id}>
        <button type="button" className="column-rail" aria-expanded="false" aria-label={`Show ${id}, ${count} ${unit}`} title={`Show ${id}`} onClick={() => board.toggle(id)}>
          <Badge>{count.toLocaleString()}</Badge>
          <span>{id}</span>
        </button>
      </section>
    );
  }
  return (
    <section className={className} data-stage={id}>
      <header>
        <span>{id}</span>
        <span className="column-tools">
          <Badge>{count.toLocaleString()}</Badge>
          <button type="button" className="column-fold" aria-expanded="true" aria-label={`Fold ${id}`} title={`Fold ${id}`} onClick={() => board.toggle(id)}>
            <CaretLeft size={13} />
          </button>
        </span>
      </header>
      {children}
    </section>
  );
}
