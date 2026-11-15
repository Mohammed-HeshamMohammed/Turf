import { useCrm } from "./context.jsx";
import { LiquidProgress } from "./LiquidProgress.jsx";
import { Button } from "./ui.jsx";

const WORKING = ["uploading", "queued", "loading", "cleaning", "merging"];
const WAITING = { mapping: "Waiting for you: say what each column is", reviewing: "Waiting for you: review possible repeats", ready: "Waiting for you: add it to your leads" };

const number = value => Number(value || 0).toLocaleString();

/** How far one import got, in words and a percent (null when the step has no measure yet). */
export function importStep(job) {
  const total = job.progress?.total;
  switch (job.status) {
    case "uploading":
      return { text: "Sending the file", percent: null };
    case "queued":
      return { text: "Waiting its turn", percent: null };
    case "loading":
      return { text: job.loaded_rows ? `Reading rows · ${number(job.loaded_rows)} so far` : "Reading rows", percent: null };
    case "cleaning":
      return { text: job.progress?.phase === "matching" ? job.progress.step || "Looking for repeats" : "Tidying phones, emails and addresses", percent: typeof job.progress?.pct === "number" ? Math.min(99, job.progress.pct) : null };
    case "merging":
      return { text: `Adding to your leads · ${number(job.merged_rows)}${total ? " of " + number(total) : ""}`, percent: total ? Math.round((job.merged_rows / total) * 100) : null };
    default:
      return { text: WAITING[job.status] || job.status, percent: null };
  }
}

/** The imports still going (and those waiting on the person), each with its progress, at the top of the Overview and Source lists.
 * The list of imports is the one the app already follows (App.jsx polls it), so this costs no extra requests. */
export function ImportStrip() {
  const { importJobs = [], navigate, connection } = useCrm();
  if (connection !== "remote") return null;
  const open = importJobs.filter(job => WORKING.includes(job.status) || WAITING[job.status]);
  if (!open.length) return null;
  return (
    <section className="import-strip" aria-label="Imports in progress">
      {open.slice(0, 3).map(job => {
        const step = importStep(job);
        return (
          <div key={job.id} className={"import-strip-item" + (WAITING[job.status] ? " needs-you" : "")}>
            <div className="import-strip-text">
              <strong>{job.name || job.filename || "List import"}</strong>
              <small>
                {step.text}
                {step.percent !== null ? ` · ${step.percent}%` : ""}
              </small>
            </div>
            <LiquidProgress value={step.percent} label={step.percent === null ? "Working" : `${step.percent} percent`} />
            <Button onClick={() => navigate(job.project_id ? `lists/${job.project_id}/imports/${job.id}` : "lists")}>{WAITING[job.status] ? "Open" : "Follow"}</Button>
          </div>
        );
      })}
      {open.length > 3 && (
        <button type="button" className="text-link" onClick={() => navigate("lists/activity")}>
          {open.length - 3} more {open.length - 3 === 1 ? "import" : "imports"}
        </button>
      )}
    </section>
  );
}
