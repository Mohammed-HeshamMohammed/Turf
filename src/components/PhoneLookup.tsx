import { useEffect, useState } from "react";
import { call, cancelSkiptraceJob, runJob, watchJob } from "../lib/service";
import type { SkiptraceConfig } from "../lib/types";
import { Check } from "./Bits";

type Settings = { provider: string; configured: boolean; enabled: boolean; products: string[]; unit_cost: string | null; cache_days: number; currency: string };
type Quote = {
  provider: string;
  unique_numbers: number;
  cached: number;
  requests: number;
  remaining: number;
  estimated_cost: string | null;
  currency: string;
  products: string[];
  quote_token: string;
};
type LookupResult = { requested: number; succeeded: number; failed: number };
type LookupHistory = {
  id: string;
  number: string;
  checked_at: string;
  provider: string;
  products: string[];
  success: boolean;
  estimated_cost: string | null;
  error: string | null;
  result: { carrier?: string; type?: string; line_status?: string };
};

export function PhoneLookup({
  datasetId,
  config,
  projectId,
  onUpdated,
}: {
  datasetId: string;
  config: SkiptraceConfig;
  projectId: string;
  onUpdated: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="card step" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>Optional live phone lookup</summary>
      {open && <LookupPanel datasetId={datasetId} config={config} projectId={projectId} onUpdated={onUpdated} />}
    </details>
  );
}

function LookupPanel({
  datasetId,
  config,
  projectId,
  onUpdated,
}: {
  datasetId: string;
  config: SkiptraceConfig;
  projectId: string;
  onUpdated: () => Promise<void>;
}) {
  const key = `turf.phone.lookup.${projectId}.${datasetId}`;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [sid, setSid] = useState("");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [lineStatus, setLineStatus] = useState(false);
  const [cost, setCost] = useState("");
  const [cacheDays, setCacheDays] = useState(30);
  const [maximum, setMaximum] = useState(100);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [history, setHistory] = useState<LookupHistory[]>([]);
  const [page, setPage] = useState(0);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let current = true;
    call<Settings>("phone.lookup_settings").then(
      value => {
        if (current) {
          setSettings(value);
          setEnabled(value.enabled);
          setLineStatus(value.products.includes("line_status"));
          setCost(value.unit_cost ?? "");
          setCacheDays(value.cache_days);
        }
      },
      reason => {
        if (current) setError(String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, []);
  useEffect(() => {
    setQuote(null);
  }, [config, maximum]);
  useEffect(() => {
    let current = true;
    call<LookupHistory[]>("phone.lookup_history", { offset: page * 100 }).then(
      value => {
        if (current) setHistory(value);
      },
      reason => {
        if (current) setError(String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [page, version]);
  useEffect(() => {
    let active: string | null = null;
    try {
      active = localStorage.getItem(key);
    } catch {
      /* The running panel still works without browser storage. */
    }
    if (active) void execute(active);
    // One reconnection per panel mount; subsequent updates never start another provider request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  function progressEvent(value: Record<string, unknown>) {
    if (typeof value.done === "number" && typeof value.total === "number") setProgress({ done: value.done, total: value.total });
  }
  async function execute(existing?: string) {
    if (!existing && !quote) return;
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      const watch = {
        onEvent: progressEvent,
        onStart: (id: string) => {
          setJobId(id);
          try {
            localStorage.setItem(key, id);
          } catch {
            setMessage("Keep this panel open to follow the lookup; job history remains in the project.");
          }
        },
      };
      const result = existing
        ? await watchJob<LookupResult>(existing, watch)
        : await runJob<LookupResult>("phone.lookup", { dataset_id: datasetId, config, max_numbers: maximum, quote_token: quote!.quote_token }, watch);
      setMessage(`Lookup finished: ${result.succeeded} succeeded, ${result.failed} failed. Results are retained. Check phones again to include them.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
    // If the bridge fails, retain the job ID for reconnection and prevent accidental duplicate paid requests.
    try {
      const active = localStorage.getItem(key);
      if (active) {
        const job = await call<{ state: string }>("job.get", { job_id: active });
        if (!["completed", "failed", "cancelled"].includes(job.state)) {
          setMessage("Lookup is still running. Reopen this panel to reconnect; completed results are retained.");
          return;
        }
        localStorage.removeItem(key);
      }
    } catch {
      setMessage("Lookup status is unknown. Reopen this panel to reconnect before starting another batch.");
      return;
    }
    setJobId(null);
    setBusy(false);
    setQuote(null);
    setVersion(value => value + 1);
    await onUpdated();
  }
  return (
    <div className="phone-lookup-panel">
      <p className="muted">
        Twilio Lookup v2 can provide carrier, line type, and optional line status. It sends selected phone numbers to Twilio; names and addresses are excluded.
        No requests run automatically. A provider result does not verify ownership.
      </p>
      <form
        onSubmit={async event => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          setQuote(null);
          try {
            const value = await call<Settings>("phone.configure_lookup", {
              account_sid: sid,
              auth_token: token,
              enabled,
              unit_cost: cost,
              cache_days: cacheDays,
              products: lineStatus ? ["line_type_intelligence", "line_status"] : ["line_type_intelligence"],
            });
            setSettings(value);
            setSid("");
            setToken("");
            setMessage("Provider settings saved on this computer. Credentials are excluded from project files and downloads.");
          } catch (reason) {
            setError(String(reason));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy || !settings}>
          <legend>Provider setup</legend>
          <div className="fields">
            <label className="field">
              <span>Twilio Account SID</span>
              <input
                className="input"
                value={sid}
                autoComplete="off"
                placeholder={settings?.configured ? "Configured; leave blank to keep" : "AC…"}
                onChange={event => setSid(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Twilio Auth Token</span>
              <input
                className="input"
                type="password"
                value={token}
                autoComplete="new-password"
                placeholder={settings?.configured ? "Configured; leave blank to keep" : "Auth Token"}
                onChange={event => setToken(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Total USD price per number for selected products (optional)</span>
              <input
                className="input"
                type="number"
                min="0"
                max="100"
                step="any"
                value={cost}
                placeholder="Check your provider rates"
                onChange={event => setCost(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Reuse successful results for this many days</span>
              <input
                className="input"
                type="number"
                min="1"
                max="365"
                value={cacheDays}
                required
                onChange={event => setCacheDays(Number(event.target.value))}
              />
            </label>
          </div>
          <Check checked={lineStatus} onChange={setLineStatus}>
            Include line status (requires provider access and may add charges)
          </Check>
          <Check checked={enabled} onChange={setEnabled}>
            Enable optional live lookup on this computer
          </Check>
          <div className="row">
            <button type="submit" className="button ghost">
              Save provider settings
            </button>
            <button
              type="button"
              className="button ghost"
              disabled={!settings?.configured}
              onClick={async () => {
                setBusy(true);
                setError(null);
                setQuote(null);
                try {
                  const value = await call<Settings>("phone.configure_lookup", { enabled: false, clear_credentials: true });
                  setSettings(value);
                  setEnabled(false);
                  setSid("");
                  setToken("");
                  setMessage("Credentials removed and lookup disabled.");
                } catch (reason) {
                  setError(String(reason));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove credentials
            </button>
          </div>
        </fieldset>
      </form>
      <p className="muted">
        Estimates use the price you enter and exclude taxes or account-specific fees. Verify Twilio coverage and product rates. Availability and type can
        change; failures do not count as evidence.
      </p>
      <label className="field">
        <span>Maximum new requests in this batch</span>
        <input className="input" type="number" min="1" max="5000" value={maximum} disabled={busy} onChange={event => setMaximum(Number(event.target.value))} />
      </label>
      <button
        type="button"
        className="button ghost"
        disabled={busy || !settings?.configured || !settings.enabled}
        onClick={async () => {
          setBusy(true);
          setError(null);
          setQuote(null);
          try {
            setQuote(await call<Quote>("phone.lookup_preview", { dataset_id: datasetId, config, max_numbers: maximum }));
          } catch (reason) {
            setError(String(reason));
          } finally {
            setBusy(false);
          }
        }}
      >
        Preview requests and cost
      </button>
      {quote && (
        <div className="notice">
          <span>
            {quote.unique_numbers} unique valid numbers · {quote.cached} reused · {quote.requests} new requests · {quote.remaining} remaining after this batch.{" "}
            {quote.estimated_cost === null
              ? "Price is unknown: provider charges may apply. Enter your product rate for an estimate."
              : `Estimated cost: ${quote.estimated_cost} ${quote.currency}.`}{" "}
            Products: {quote.products.join(", ")}.
          </span>
          <button type="button" className="button" disabled={busy || !quote.requests} onClick={() => void execute()}>
            Send {quote.requests} numbers and run lookup
          </button>
        </div>
      )}
      {jobId && (
        <p className="notice" role="status">
          <span>
            Lookup {progress.done} of {progress.total}. Completed results are kept if stopped.
          </span>
          <button type="button" className="button ghost" onClick={() => void cancelSkiptraceJob(jobId).catch(reason => setError(String(reason)))}>
            Stop lookup
          </button>
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <div className="table-wrap history-table">
        <table className="compact">
          <caption>Retained lookup history</caption>
          <thead>
            <tr>
              <th>Number</th>
              <th>Date / provider</th>
              <th>Result</th>
              <th>Estimated request cost</th>
            </tr>
          </thead>
          <tbody>
            {history.map(entry => (
              <tr key={entry.id}>
                <td>{entry.number}</td>
                <td>
                  {new Date(entry.checked_at).toLocaleString()} · {entry.provider}
                  <small>{entry.products.join(", ")}</small>
                </td>
                <td>
                  {entry.success
                    ? `${entry.result.carrier ?? "Unknown carrier"} · ${entry.result.type ?? "Unknown type"} · ${entry.result.line_status ?? "Unknown status"}`
                    : entry.error}
                </td>
                <td>{entry.estimated_cost === null ? "Unknown" : `${entry.estimated_cost} USD`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!history.length && <p className="muted">No provider requests recorded in this project.</p>}
      <div className="row">
        <button type="button" className="button ghost small" disabled={!page} onClick={() => setPage(page - 1)}>
          Previous lookups
        </button>
        <span>Page {page + 1}</span>
        <button type="button" className="button ghost small" disabled={history.length < 100} onClick={() => setPage(page + 1)}>
          Next lookups
        </button>
      </div>
    </div>
  );
}
