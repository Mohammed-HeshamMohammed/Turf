// Caller Whale's calendar and date field, shared by the CRM, the website and the desktop app. Plain React and CSS
// (calendar.css): no animation, icon or class-name libraries. This app's own copy of packages/calendar, no longer synced (step 49).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

/* ─── Dates ─────────────────────────────────────────────────── */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS_SUN = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const WEEKDAYS_MON = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

const pad = number => String(number).padStart(2, "0");
/** "YYYY-MM-DD" for a day, in local time. */
export const isoOf = date => date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
/** The day a "YYYY-MM-DD" text names (local midnight), or null when it is not a real day. */
export function parseIso(text) {
  const found = /^(\d{4})-(\d{2})-(\d{2})/.exec(text || "");
  if (!found) return null;
  const date = new Date(Number(found[1]), Number(found[2]) - 1, Number(found[3]));
  return date.getMonth() === Number(found[2]) - 1 ? date : null;
}
const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const firstOfMonth = date => new Date(date.getFullYear(), date.getMonth(), 1);
const addMonths = (date, count) => new Date(date.getFullYear(), date.getMonth() + count, 1);
const addDays = (date, count) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
const sameDay = (a, b) => Boolean(a && b) && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const sameMonth = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
const before = (a, b) => startOfDay(a) < startOfDay(b);
const clampDay = (date, min, max) => (min && before(date, min) ? min : max && before(max, date) ? max : date);
const inRange = (date, range) => {
  if (!range?.from || !range?.to) return false;
  const t = startOfDay(date).getTime();
  const [a, b] = [startOfDay(range.from).getTime(), startOfDay(range.to).getTime()];
  return t > Math.min(a, b) && t < Math.max(a, b);
};
const asDay = value => (value instanceof Date ? value : typeof value === "string" ? parseIso(value) : null);

function monthGrid(month, weekStartsOn) {
  const first = firstOfMonth(month);
  const lead = weekStartsOn === 1 ? (first.getDay() + 6) % 7 : first.getDay();
  return Array.from({ length: 42 }, (_, index) => new Date(first.getFullYear(), first.getMonth(), 1 - lead + index));
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function Chevron({ left }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={left ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="cal-field-icon">
      <rect x="4" y="5" width="16" height="15" rx="3" />
      <path d="M8 3v4M16 3v4M4 10h16" />
    </svg>
  );
}

/* ─── <Calendar> ────────────────────────────────────────────── */

/**
 * A month calendar: single day, range or several days. Its header jumps straight to a month or a year (press the month
 * or the year). Days move with the arrow keys, Home/End (week), PageUp/PageDown (month).
 */
export function Calendar(props) {
  const {
    mode = "single",
    month: controlledMonth,
    defaultMonth,
    onMonthChange,
    weekStartsOn = 0,
    disabled,
    min,
    max,
    bookedDates,
    events,
    quickNav = true,
    today: todayProp,
    initialView = "days",
    autoFocus = false,
    className = "",
    selected,
    defaultSelected,
    onSelect,
    "aria-label": ariaLabel,
  } = props;

  const today = useMemo(() => startOfDay(asDay(todayProp) || new Date()), [todayProp]);
  const minDay = asDay(min);
  const maxDay = asDay(max);

  const [innerSingle, setInnerSingle] = useState(mode === "single" ? defaultSelected : undefined);
  const [innerMultiple, setInnerMultiple] = useState(mode === "multiple" ? defaultSelected || [] : []);
  const [innerRange, setInnerRange] = useState(mode === "range" ? defaultSelected : undefined);
  const controlled = selected !== undefined;
  const single = mode === "single" ? (controlled ? selected : innerSingle) || undefined : undefined;
  const multiple = mode === "multiple" ? (controlled ? selected : innerMultiple) || [] : [];
  const range = mode === "range" ? (controlled ? selected : innerRange) || undefined : undefined;

  const [innerMonth, setInnerMonth] = useState(() =>
    firstOfMonth(defaultMonth || controlledMonth || single || range?.from || multiple[0] || clampDay(today, minDay, maxDay)),
  );
  const month = controlledMonth ? firstOfMonth(controlledMonth) : innerMonth;
  const [view, setView] = useState(quickNav ? initialView : "days");
  const [direction, setDirection] = useState(0);
  const [yearAnchor, setYearAnchor] = useState(() => month.getFullYear());
  const [focused, setFocused] = useState(null);
  const grid = useRef(null);
  const wantFocus = useRef(autoFocus);

  function setMonth(next, dir) {
    setDirection(dir);
    if (!controlledMonth) setInnerMonth(firstOfMonth(next));
    onMonthChange?.(firstOfMonth(next));
  }

  const booked = date => bookedDates?.some(day => sameDay(asDay(day), date)) ?? false;
  const blocked = date => booked(date) || (minDay && before(date, minDay)) || (maxDay && before(maxDay, date)) || Boolean(disabled?.(date));
  const eventOn = date => events?.find(event => sameDay(asDay(event.date), date));

  // The day that takes Tab: the one last moved to, else the selected day, today, or the first of the month, when in view.
  const tabDay = useMemo(() => {
    const options = [focused, single, range?.from, today].filter(day => day && sameMonth(day, month));
    return options[0] || firstOfMonth(month);
  }, [focused, single, range, today, month]);

  const body = useRef(null);
  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    const target =
      view === "days"
        ? grid.current?.querySelector('[data-day="' + isoOf(tabDay) + '"]')
        : body.current?.querySelector(".cal-pick.is-selected:not(:disabled)") || body.current?.querySelector(".cal-pick:not(:disabled)");
    target?.focus({ preventScroll: true });
  });

  function moveFocus(date) {
    setFocused(date);
    wantFocus.current = true;
    if (!sameMonth(date, month)) setMonth(date, before(date, month) ? -1 : 1);
  }

  function choose(date) {
    if (blocked(date)) return;
    setFocused(date);
    if (mode === "single") {
      const next = sameDay(single, date) ? undefined : date;
      if (!controlled) setInnerSingle(next);
      onSelect?.(next, date);
    } else if (mode === "multiple") {
      const next = multiple.some(day => sameDay(day, date)) ? multiple.filter(day => !sameDay(day, date)) : [...multiple, date];
      if (!controlled) setInnerMultiple(next);
      onSelect?.(next, date);
    } else {
      const { from, to } = range || {};
      const next = !from || to ? { from: date, to: undefined } : before(date, from) ? { from: date, to: from } : { from, to: date };
      if (!controlled) setInnerRange(next);
      onSelect?.(next, date);
    }
    if (!sameMonth(date, month)) setMonth(date, before(date, month) ? -1 : 1);
  }

  function onGridKey(event) {
    const from = asDay(event.target.dataset?.day);
    if (!from) return;
    const weekday = weekStartsOn === 1 ? (from.getDay() + 6) % 7 : from.getDay();
    const moves = {
      ArrowLeft: () => addDays(from, -1),
      ArrowRight: () => addDays(from, 1),
      ArrowUp: () => addDays(from, -7),
      ArrowDown: () => addDays(from, 7),
      Home: () => addDays(from, -weekday),
      End: () => addDays(from, 6 - weekday),
      PageUp: () => shiftMonth(from, event.shiftKey ? -12 : -1),
      PageDown: () => shiftMonth(from, event.shiftKey ? 12 : 1),
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    moveFocus(moves[event.key]());
  }
  const shiftMonth = (date, count) => {
    const target = addMonths(date, count);
    const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), last));
  };

  const monthBlocked = (year, index) =>
    (minDay && new Date(year, index + 1, 0) < startOfDay(minDay)) || (maxDay && new Date(year, index, 1) > startOfDay(maxDay));
  const yearBlocked = year => (minDay && year < minDay.getFullYear()) || (maxDay && year > maxDay.getFullYear());
  const canGo = offset => {
    const target = addMonths(month, offset);
    return !monthBlocked(target.getFullYear(), target.getMonth());
  };

  function openYears() {
    setYearAnchor(month.getFullYear());
    wantFocus.current = true; // the year button goes away with the change, so the keyboard moves to the chosen year
    setView("years");
  }

  const label = MONTHS[month.getMonth()] + " " + month.getFullYear();
  const cells = useMemo(() => monthGrid(month, weekStartsOn), [month, weekStartsOn]);
  const weeks = Array.from({ length: 6 }, (_, row) => cells.slice(row * 7, row * 7 + 7));
  const firstYear = yearAnchor - 5;
  const years = Array.from({ length: 12 }, (_, index) => firstYear + index);
  const slide = direction > 0 ? " cal-from-right" : direction < 0 ? " cal-from-left" : "";

  return (
    <div className={"cal " + className} data-mode={mode} role="group" aria-label={ariaLabel || "Calendar"}>
      <div className="cal-sr" aria-live="polite" aria-atomic="true">
        {view === "days" ? label : view === "months" ? "Choose a month, " + month.getFullYear() : "Choose a year"}
      </div>

      <div className="cal-head">
        <button
          type="button"
          className="cal-nav"
          aria-label={view === "years" ? "Previous years" : view === "months" ? "Previous year" : "Previous month"}
          disabled={view === "days" ? !canGo(-1) : view === "months" ? yearBlocked(month.getFullYear() - 1) : yearBlocked(firstYear - 1)}
          onClick={() =>
            view === "years" ? setYearAnchor(year => year - 12) : view === "months" ? setMonth(addMonths(month, -12), -1) : setMonth(addMonths(month, -1), -1)
          }
        >
          <Chevron left />
        </button>

        <div className="cal-title">
          <button
            type="button"
            className="cal-jump"
            disabled={!quickNav}
            aria-pressed={quickNav ? view === "months" : undefined}
            aria-label={quickNav ? "Choose a month, " + MONTHS[month.getMonth()] : undefined}
            title={quickNav ? "Jump to month" : undefined}
            onClick={() => setView(view === "months" ? "days" : "months")}
          >
            {view === "years" ? years[0] + "–" + years[11] : MONTHS[month.getMonth()]}
          </button>
          {view !== "years" && (
            <>
              <span className="cal-bar" aria-hidden="true">
                |
              </span>
              <button
                type="button"
                className="cal-jump"
                disabled={!quickNav}
                aria-pressed={quickNav ? false : undefined}
                aria-label={quickNav ? "Choose a year, " + month.getFullYear() : undefined}
                title={quickNav ? "Jump to year" : undefined}
                onClick={openYears}
              >
                {month.getFullYear()}
              </button>
            </>
          )}
        </div>

        <button
          type="button"
          className="cal-nav"
          aria-label={view === "years" ? "Next years" : view === "months" ? "Next year" : "Next month"}
          disabled={view === "days" ? !canGo(1) : view === "months" ? yearBlocked(month.getFullYear() + 1) : yearBlocked(firstYear + 12)}
          onClick={() =>
            view === "years" ? setYearAnchor(year => year + 12) : view === "months" ? setMonth(addMonths(month, 12), 1) : setMonth(addMonths(month, 1), 1)
          }
        >
          <Chevron />
        </button>
      </div>

      <div ref={body} className="cal-body">
        {view === "days" && (
          <div key={label} className={"cal-days" + slide}>
            <div className="cal-weekdays" aria-hidden="true">
              {(weekStartsOn === 1 ? WEEKDAYS_MON : WEEKDAYS_SUN).map(day => (
                <span key={day}>{day}</span>
              ))}
            </div>
            <div ref={grid} role="grid" aria-label={label} className="cal-grid" onKeyDown={onGridKey}>
              {weeks.map((week, row) => (
                <div key={row} role="row" className="cal-row">
                  {week.map(date => {
                    const day = isoOf(date);
                    const isBooked = booked(date);
                    const off = blocked(date);
                    const start = mode === "range" && sameDay(range?.from, date);
                    const end = mode === "range" && sameDay(range?.to, date);
                    const between = mode === "range" && inRange(date, range);
                    const chosen =
                      mode === "single" ? sameDay(single, date) : mode === "multiple" ? multiple.some(item => sameDay(item, date)) : start || end;
                    const band = mode === "range" && range?.from && range?.to && !sameDay(range.from, range.to) && (between || start || end);
                    const event = eventOn(date);
                    const forward = range?.from && range?.to && before(range.from, range.to);
                    return (
                      <div
                        key={day}
                        role="gridcell"
                        aria-selected={chosen || between || undefined}
                        className={
                          "cal-cell" +
                          (band ? (between ? " cal-band" : (start && forward) || (end && !forward) ? " cal-band-start" : " cal-band-end") : "")
                        }
                      >
                        <button
                          type="button"
                          data-day={day}
                          tabIndex={sameDay(date, tabDay) ? 0 : -1}
                          aria-label={
                            date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) +
                            (isBooked ? ", unavailable" : "") +
                            (event ? ", " + (event.label || "has an event") : "")
                          }
                          aria-current={sameDay(date, today) ? "date" : undefined}
                          aria-pressed={chosen}
                          aria-disabled={off || undefined}
                          className={
                            "cal-day" +
                            (sameMonth(date, month) ? "" : " is-outside") +
                            (chosen ? " is-selected" : "") +
                            (sameDay(date, today) ? " is-today" : "") +
                            (isBooked ? " is-booked" : off ? " is-disabled" : "")
                          }
                          onClick={() => choose(date)}
                          onFocus={() => !sameDay(focused, date) && sameMonth(date, month) && setFocused(date)}
                        >
                          {date.getDate()}
                          {event && !chosen && <span className="cal-dot" aria-hidden="true" />}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}

        {view === "months" && (
          <div className="cal-picks cal-fade">
            {MONTHS.map((name, index) => (
              <button
                key={name}
                type="button"
                className={"cal-pick" + (index === month.getMonth() ? " is-selected" : "")}
                aria-pressed={index === month.getMonth()}
                disabled={monthBlocked(month.getFullYear(), index)}
                onClick={() => {
                  setMonth(new Date(month.getFullYear(), index, 1), index >= month.getMonth() ? 1 : -1);
                  wantFocus.current = true;
                  setView("days");
                }}
              >
                {name.slice(0, 3)}
              </button>
            ))}
          </div>
        )}

        {view === "years" && (
          <div className="cal-picks cal-fade">
            {years.map(year => (
              <button
                key={year}
                type="button"
                className={"cal-pick" + (year === month.getFullYear() ? " is-selected" : "") + (year === today.getFullYear() ? " is-today" : "")}
                aria-pressed={year === month.getFullYear()}
                disabled={yearBlocked(year)}
                onClick={() => {
                  // Keep the month when that year has it in reach, else the nearest month that is.
                  let next = new Date(year, month.getMonth(), 1);
                  if (minDay && next < firstOfMonth(minDay)) next = firstOfMonth(minDay);
                  if (maxDay && next > firstOfMonth(maxDay)) next = firstOfMonth(maxDay);
                  setMonth(next, year >= month.getFullYear() ? 1 : -1);
                  wantFocus.current = true;
                  setView("months");
                }}
              >
                {year}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── <DatePicker> ──────────────────────────────────────────── */

// Below this width the calendar opens as a sheet from the bottom of the screen instead of under the field.
const SHEET_BELOW = 560;
const EXIT_MS = 140;

/**
 * A date field: a button that shows the chosen day and opens the calendar under it (or, on a phone, as a sheet from the
 * bottom). Drop-in for <input type="date">: values are "YYYY-MM-DD", with min and max; onChange receives an event-like
 * { target: { value, name } }. With `required`, the browser's own "fill this in" check applies when the form is sent.
 */
export function DatePicker({
  value,
  defaultValue,
  onChange,
  name,
  min,
  max,
  disabled,
  required,
  id,
  placeholder = "Pick a date",
  today,
  weekStartsOn,
  initialView,
  className = "",
  triggerClassName = "",
  portalHost = "dialog",
  format = text => parseIso(text)?.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) ?? "",
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
}) {
  const controlled = value !== undefined;
  const [inner, setInner] = useState(defaultValue ?? "");
  const current = (controlled ? value : inner) || "";
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [place, setPlace] = useState(null);
  const trigger = useRef(null);
  const panel = useRef(null);
  const host = useRef(null);
  const todayIso = typeof today === "string" ? today : isoOf(asDay(today) || new Date());
  const blockedIso = day => Boolean((min && day < min) || (max && day > max));

  useEffect(() => {
    if (open) return setMounted(true);
    const timer = setTimeout(() => setMounted(false), reducedMotion() ? 0 : EXIT_MS);
    return () => clearTimeout(timer);
  }, [open]);

  function emit(day) {
    if (!controlled) setInner(day);
    onChange?.({ target: { value: day, name }, currentTarget: { value: day, name } });
  }
  function close(refocus = true) {
    setOpen(false);
    if (refocus) trigger.current?.focus({ preventScroll: true });
  }
  function choose(day) {
    if (blockedIso(day)) return;
    emit(day);
    close();
  }
  function show() {
    if (disabled) return;
    host.current = (portalHost && trigger.current?.closest(portalHost)) || document.body;
    setSheet(window.innerWidth < SHEET_BELOW);
    setPlace(null);
    setOpen(true);
  }

  useLayoutEffect(() => {
    if (!open || sheet || !panel.current || !trigger.current) return;
    const box = trigger.current.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = panel.current;
    const below = window.innerHeight - box.bottom - 12;
    const up = below < height && box.top > below;
    setPlace({
      left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)),
      top: up ? Math.max(8, box.top - height - 6) : Math.min(box.bottom + 6, Math.max(8, window.innerHeight - height - 8)),
    });
  }, [open, sheet]);

  useEffect(() => {
    if (!open) return undefined;
    const outside = event => {
      if (!trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) close(false);
    };
    // A layout change (a phone turned sideways, the window resized) closes it rather than leaving it out of place. Only the
    // width counts: a phone's address bar showing or hiding changes the height alone.
    const width = window.innerWidth;
    const resize = () => window.innerWidth !== width && close(false);
    const scroll = event => !sheet && !panel.current?.contains(event.target) && close(false);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", resize);
    window.addEventListener("scroll", scroll, true);
    // A sheet covers the page, so the page under it does not scroll.
    const before = document.documentElement.style.overflow;
    if (sheet) document.documentElement.style.overflow = "hidden";
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", scroll, true);
      if (sheet) document.documentElement.style.overflow = before;
    };
  }, [open, sheet]);

  // Once it is in place (it is measured hidden first), the keyboard goes to the chosen day, or what the calendar shows.
  useEffect(() => {
    if (!open || (!sheet && !place) || panel.current?.contains(document.activeElement)) return;
    const target =
      panel.current?.querySelector('.cal-day[tabindex="0"]') ||
      panel.current?.querySelector(".cal-pick.is-selected:not(:disabled)") ||
      panel.current?.querySelector(".cal-pick:not(:disabled)");
    target?.focus({ preventScroll: true });
  }, [open, sheet, place]);

  function onPanelKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      const stops = [...panel.current.querySelectorAll("button:not(:disabled)")].filter(item => item.tabIndex >= 0);
      const [first, last] = [stops[0], stops[stops.length - 1]];
      const edge = event.shiftKey ? document.activeElement === first : document.activeElement === last;
      if (!edge) return;
      event.preventDefault();
      // A sheet keeps Tab inside it; under a field, Tab past the end leaves the calendar like a menu.
      if (sheet) (event.shiftKey ? last : first)?.focus();
      else if (!event.shiftKey) close();
    }
  }

  const shown = format(current);
  const visible = mounted || open;
  const leaving = mounted && !open;
  const day = parseIso(current);

  return (
    <span className={"cal-field " + className}>
      <button
        type="button"
        ref={trigger}
        id={id}
        className={"cal-trigger " + triggerClassName}
        aria-label={ariaLabel ? ariaLabel + (shown ? ", " + shown : "") : undefined}
        aria-describedby={describedBy}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={event => {
          if (!open && ["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            show();
          }
        }}
      >
        <span className={"cal-value" + (shown ? "" : " is-empty")}>{shown || placeholder}</span>
        <CalendarIcon />
      </button>
      {/* The value for the form, and the browser's own "fill this in" check when it is required. */}
      <input
        className="cal-native"
        tabIndex={-1}
        aria-hidden="true"
        name={name}
        value={current}
        required={required}
        disabled={disabled}
        onChange={() => {}}
        onInvalid={() => trigger.current?.focus()}
      />
      {visible &&
        host.current &&
        createPortal(
          <>
            {sheet && <div className={"cal-backdrop" + (leaving ? " is-leaving" : "")} aria-hidden="true" />}
            <div
              ref={panel}
              role="dialog"
              aria-modal={sheet || undefined}
              aria-label={ariaLabel ? "Choose " + ariaLabel.toLowerCase() : "Choose a date"}
              className={"cal-pop" + (sheet ? " is-sheet" : "") + (leaving ? " is-leaving" : "")}
              style={sheet ? undefined : place ? { left: place.left, top: place.top } : { visibility: "hidden", left: 0, top: 0 }}
              onKeyDown={onPanelKey}
            >
              {sheet && (
                <div className="cal-sheet-head">
                  <strong>{ariaLabel || "Choose a date"}</strong>
                  <button type="button" className="cal-done" onClick={() => close()}>
                    Done
                  </button>
                </div>
              )}
              <Calendar
                selected={day || null}
                today={todayIso}
                min={min}
                max={max}
                weekStartsOn={weekStartsOn}
                initialView={day ? "days" : initialView}
                onSelect={(_next, picked) => choose(isoOf(picked))}
              />
              <div className="cal-foot">
                {!required && current && (
                  <button type="button" onClick={() => (emit(""), close())}>
                    Clear
                  </button>
                )}
                {!blockedIso(todayIso) && (
                  <button type="button" onClick={() => choose(todayIso)}>
                    Today
                  </button>
                )}
              </div>
            </div>
          </>,
          host.current,
        )}
    </span>
  );
}
