import { useEffect, useState } from "react";
import { api } from "./remote/api.ts";
import { LEAD_STAGES } from "./data.ts";
import { Button, Checkbox, Field, Modal, Select } from "./ui.jsx";

/** Gives many leads at once, on the server: the picked leads, or every lead matching a filter (or the first N of them), to one
 * person or shared evenly between several. Only the people the viewer manages are offered (the server checks it again). */
export function AssignLeadsDialog({ state, picked = [], stage = "", onClose, notify }) {
  const targets = state.remote?.assignTargets || [];
  const lists = (state.datasets || []).filter(item => item.id);
  const [scope, setScope] = useState(picked.length ? "picked" : "filter");
  const [filterStage, setFilterStage] = useState(stage || "");
  const [list, setList] = useState("");
  const [who, setWho] = useState("unassigned");
  const [howMany, setHowMany] = useState("");
  const [to, setTo] = useState([]);
  const [unassign, setUnassign] = useState(false);
  const [run, setRun] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!run || run.status !== "running") return;
    const timer = setTimeout(() => api.assignment(run.id).then(setRun, () => undefined), 800);
    return () => clearTimeout(timer);
  }, [run]);
  useEffect(() => {
    if (run?.status === "done") notify?.(`${Number(run.assigned).toLocaleString()} ${run.assigned === 1 ? "lead" : "leads"} given`);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tell once when the run finishes, not on every new notify
  }, [run?.status]);

  const submit = async event => {
    event.preventDefault();
    setError("");
    const selection = scope === "picked" ? { ids: picked } : { stage: filterStage, project_id: list, assignee: who === "anyone" ? "" : who };
    try {
      setRun(await api.startAssignment({ selection, to: unassign ? [] : to, limit: scope === "filter" && howMany ? Number(howMany) : 0 }));
    } catch (cause) {
      setError(cause?.message || "The leads could not be given.");
    }
  };
  const nameOf = id => targets.find(item => item.user_id === id)?.name || "Member";

  return (
    <Modal title="Give leads" onClose={onClose}>
      {run ? (
        <div className="assign-progress" role="status" aria-live="polite">
          <p>
            {run.status === "running" ? "Giving leads… " : run.status === "done" ? "Done. " : "Stopped. "}
            <strong>{Number(run.assigned).toLocaleString()}</strong> {run.assigned === 1 ? "lead" : "leads"} given
            {unassign ? " back to the pool" : ` to ${to.map(nameOf).join(", ")}`}.
          </p>
          {run.error && <p className="notice bad">{run.error}</p>}
          <div className="row">
            <Button variant="primary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      ) : (
        <form className="assign-form" onSubmit={submit}>
          {picked.length > 0 && (
            <Field label="Which leads">
              <Select aria-label="Which leads" value={scope} onChange={event => setScope(event.target.value)}>
                <option value="picked">The {picked.length.toLocaleString()} selected</option>
                <option value="filter">Leads matching a filter</option>
              </Select>
            </Field>
          )}
          {scope === "filter" && (
            <>
              <div className="form-grid">
                <Field label="Held by">
                  <Select aria-label="Held by" value={who} onChange={event => setWho(event.target.value)}>
                    <option value="unassigned">Nobody yet (unassigned)</option>
                    <option value="anyone">Anyone I can see</option>
                    {targets.map(person => (
                      <option key={person.user_id} value={person.user_id}>
                        {person.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Stage">
                  <Select aria-label="Stage" value={filterStage} onChange={event => setFilterStage(event.target.value)}>
                    <option value="">Any stage</option>
                    {LEAD_STAGES.map(item => (
                      <option key={item}>{item}</option>
                    ))}
                  </Select>
                </Field>
                {lists.length > 0 && (
                  <Field label="From list">
                    <Select aria-label="From list" value={list} onChange={event => setList(event.target.value)}>
                      <option value="">Any list</option>
                      {lists.map(item => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                <Field label="How many" help="Empty gives all of them.">
                  <input inputMode="numeric" value={howMany} placeholder="All" onChange={event => setHowMany(event.target.value.replace(/\D/g, ""))} />
                </Field>
              </div>
            </>
          )}
          <fieldset className="assign-targets">
            <legend>Give them to</legend>
            {targets.length === 0 && <p className="muted">There is nobody you can give leads to yet.</p>}
            {targets.map(person => (
              <Checkbox
                key={person.user_id}
                label={person.name}
                checked={to.includes(person.user_id)}
                onChange={event => {
                  setUnassign(false);
                  setTo(event.target.checked ? [...to, person.user_id] : to.filter(id => id !== person.user_id));
                }}
              />
            ))}
            <Checkbox label="Nobody: put them back in the pool" checked={unassign} onChange={event => { setUnassign(event.target.checked); if (event.target.checked) setTo([]); }} />
          </fieldset>
          {to.length > 1 && <p className="muted">The leads are shared evenly, in turn, between the {to.length} people.</p>}
          {error && <p className="notice bad" role="alert">{error}</p>}
          <div className="row">
            <Button variant="primary" type="submit" disabled={!unassign && to.length === 0}>
              Give leads
            </Button>
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
