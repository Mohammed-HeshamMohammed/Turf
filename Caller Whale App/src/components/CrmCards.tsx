import { useEffect, useRef, useState } from "react";
import type { CallerWhale } from "../App";
import { formatNumber } from "../lib/marks";
import {
  callStats,
  describeHistory,
  dueCallbacks,
  localDay,
  OUTCOME_WORDS,
  recentActivity,
  searchEverywhere,
  type CallStats,
  type Callback,
  type Found,
  type HistoryItem,
} from "../lib/service";
import { Icon } from "./Icon";

const ago = (at: string) => {
  const minutes = Math.round((Date.now() - new Date(at).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return new Date(at).toLocaleDateString();
};

/** On the Dashboard: what happened lately across the project's leads, newest first. */
export function ActivityCard({ callerwhale }: { callerwhale: CallerWhale }) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  useEffect(() => {
    let live = true;
    recentActivity(12).then(
      found => live && setItems(found),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [callerwhale.version, callerwhale.projectId, callerwhale.callTarget, callerwhale.manual]);
  if (!items?.length) return null;
  return (
    <article className="card activity-card">
      <header>
        <h2>Recent activity</h2>
        <span className="count">Calls, notes, stages and callbacks</span>
      </header>
      <ul>
        {items.map((item, index) => (
          <li key={`${item.at}-${index}`} className={`history-${item.kind}`}>
            <span className="activity-kind">
              {item.kind === "call" ? "Call" : item.kind === "note" ? "Note" : item.kind === "stage" ? "Stage" : "Callback"}
            </span>
            <div>
              <strong>{describeHistory(item)}</strong>
              <small className="muted">
                {[item.label, item.list, ago(item.at)].filter(Boolean).join(" · ")}
                {item.dataset_id && item.row_number !== undefined && (
                  <>
                    {" "}
                    ·{" "}
                    <button type="button" className="link" onClick={() => callerwhale.openCall(item.dataset_id!, item.row_number!)}>
                      Open
                    </button>
                  </>
                )}
              </small>
            </div>
          </li>
        ))}
      </ul>
    </article>
  );
}

const OUTCOME_ORDER = ["reached", "voicemail", "no_answer", "wrong_number", "disconnected", "wrong_person"];

/** On the Dashboard: how the calls have gone, a bar for each of the last two weeks and the outcomes. */
export function CallStatsCard({ callerwhale }: { callerwhale: CallerWhale }) {
  const [stats, setStats] = useState<CallStats | null>(null);
  useEffect(() => {
    let live = true;
    callStats(14).then(
      found => live && setStats(found),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [callerwhale.version, callerwhale.projectId, callerwhale.callTarget, callerwhale.manual]);
  if (!stats?.calls) return null;
  const most = Math.max(1, ...stats.days.map(day => day.calls));
  return (
    <article className="card call-stats">
      <header>
        <h2>Calls made</h2>
        <span className="count">Last 14 days</span>
      </header>
      <div className="calls-figures">
        <div>
          <strong>{formatNumber(stats.today)}</strong>
          <span>today</span>
        </div>
        <div>
          <strong>{formatNumber(stats.week)}</strong>
          <span>in 7 days</span>
        </div>
        <div>
          <strong>{stats.reached_share === null ? "–" : `${Math.round(stats.reached_share * 100)}%`}</strong>
          <span>reached a person</span>
        </div>
      </div>
      <div className="day-bars" role="img" aria-label={stats.days.map(day => `${day.day}: ${day.calls} calls`).join(", ")}>
        {stats.days.map(day => (
          <div key={day.day} className={day.day === localDay() ? "today" : undefined} title={`${day.day}: ${day.calls} calls`}>
            <i style={{ height: `${(day.calls / most) * 100}%` }} />
            <small>{Number(day.day.slice(8))}</small>
          </div>
        ))}
      </div>
      <ul className="outcome-chips">
        {OUTCOME_ORDER.filter(outcome => stats.outcomes[outcome]).map(outcome => (
          <li key={outcome}>
            {OUTCOME_WORDS[outcome]} <b>{formatNumber(stats.outcomes[outcome])}</b>
          </li>
        ))}
      </ul>
    </article>
  );
}

const SEEN = "callerwhale.reminded";

/**
 * A callback set for a time of day comes up in the corner of the window when its time comes, with a button to open
 * the lead in Calls. Asked every minute; each comes up once.
 */
export function CallbackReminders({ callerwhale }: { callerwhale: CallerWhale | null }) {
  const [showing, setShowing] = useState<Callback[]>([]);
  const ready = useRef(callerwhale);
  ready.current = callerwhale;
  useEffect(() => {
    if (!callerwhale?.projectId) return;
    let live = true;
    const look = () =>
      void dueCallbacks().then(
        found => {
          if (!live) return;
          const now = new Date();
          const clock = `${localDay(now)}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
          let seen: string[] = [];
          try {
            seen = JSON.parse(sessionStorage.getItem(SEEN) ?? "[]");
          } catch {
            seen = [];
          }
          const come = found.due.filter(
            item => item.time && item.on <= clock && item.on.slice(0, 10) === found.today && !seen.includes(item.lead_key + item.on),
          );
          if (!come.length) return;
          try {
            sessionStorage.setItem(SEEN, JSON.stringify([...seen, ...come.map(item => item.lead_key + item.on)]));
          } catch {
            // Shown again after a reload; nothing worse.
          }
          setShowing(current => [...current, ...come]);
        },
        () => undefined,
      );
    look();
    const timer = window.setInterval(look, 60_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [callerwhale?.projectId]);
  if (!showing.length) return null;
  return (
    <aside className="card reminders" aria-label="Callbacks due now" role="status">
      {showing.map(item => (
        <div key={item.lead_key + item.on} className="reminder">
          <Icon name="phone" />
          <div>
            <strong>Call back {item.label || `row ${item.row_number}`}</strong>
            <small className="muted">
              {item.time} · {item.list}
              {item.note ? ` · ${item.note}` : ""}
            </small>
          </div>
          <button
            type="button"
            className="button small"
            onClick={() => {
              ready.current?.openCall(item.dataset_id, item.row_number);
              setShowing(current => current.filter(other => other !== item));
            }}
          >
            Call now
          </button>
          <button type="button" className="button ghost small" onClick={() => setShowing(current => current.filter(other => other !== item))}>
            Later
          </button>
        </div>
      ))}
    </aside>
  );
}

/** In the title bar: a phone number, a name or a street, looked for in every list of the project. */
export function GlobalSearch({ onOpen }: { onOpen: (found: Found) => void }) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (query.trim().length < 3) {
      setFound(null);
      return;
    }
    let live = true;
    const timer = window.setTimeout(
      () =>
        void searchEverywhere(query).then(
          result => live && setFound(result),
          () => live && setFound([]),
        ),
      300,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query]);
  return (
    <div className="global-search" onBlur={event => !event.currentTarget.contains(event.relatedTarget as Node) && setOpen(false)}>
      <Icon name="search" size={16} />
      <input
        type="search"
        value={query}
        placeholder="Find a number, name or street"
        aria-label="Find in every list"
        onFocus={() => setOpen(true)}
        onChange={event => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={event => {
          if (event.key === "Escape") setOpen(false);
          if (event.key === "Enter" && found?.[0]) {
            onOpen(found[0]);
            setOpen(false);
          }
        }}
      />
      {open && found && (
        <ul className="global-results" role="listbox" aria-label="Found in the lists">
          {found.length ? (
            found.map(item => (
              <li key={`${item.dataset_id}-${item.row_number}`} role="option" aria-selected="false">
                <button
                  type="button"
                  onClick={() => {
                    onOpen(item);
                    setOpen(false);
                  }}
                >
                  <strong>{item.label}</strong>
                  <small className="muted">
                    {item.list} · row {item.row_number}
                  </small>
                </button>
              </li>
            ))
          ) : (
            <li className="muted">Nothing in the lists holds that.</li>
          )}
        </ul>
      )}
    </div>
  );
}
