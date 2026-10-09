import { useState } from "react";
import { Field } from "./Bits";
import { missingColumns, type SetupTemplate } from "../lib/skiptrace-workflow";
import type { SkiptraceConfig } from "../lib/types";

export function SkiptraceTemplates({ projectId, columns, config, onApply, onError }: {
  projectId: string; columns: string[]; config: SkiptraceConfig; onApply: (config: SkiptraceConfig) => Promise<void>; onError: (message: string) => void;
}) {
  const key = `turf.skiptrace.templates.${projectId}`;
  const [templates, setTemplates] = useState<SetupTemplate[]>(() => {
    try { const saved = JSON.parse(localStorage.getItem(key) ?? "[]"); return Array.isArray(saved) ? saved.filter(item => typeof item.name === "string" && Array.isArray(item.config?.phone_columns)) : []; }
    catch { return []; }
  });
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const chosen = templates.find(item => item.id === selected);
  function save() {
    const missing = missingColumns(config, columns);
    if (!config.phone_columns.length || missing.length) return onError("Choose valid phone and supporting columns before saving a template.");
    const next = [...templates, { id: crypto.randomUUID(), name: name.trim(), config, at: new Date().toISOString() }];
    try { localStorage.setItem(key, JSON.stringify(next)); setTemplates(next); setName(""); setMessage("Template saved on this computer for this project."); }
    catch { onError("The template could not be saved. Browser storage may be full or unavailable."); }
  }
  async function apply() {
    if (!chosen) return;
    const missing = missingColumns(chosen.config, columns);
    if (missing.length) return onError(`This template needs columns this list does not have: ${missing.join(", ")}. Your setup was kept. Choose another template or map the columns manually.`);
    setApplying(true); setMessage(null);
    try { await onApply(chosen.config); setMessage("Template applied. Review the editable mappings and status meanings for this list before checking."); }
    catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setApplying(false); }
  }
  return <details className="step skiptrace-optional template-box">
    <summary>Reuse or save a setup template</summary>
    <p className="muted">Templates keep phone, country, name, area, outcome, and warning-sign settings. They are scoped to this project on this computer. Missing columns never get silently substituted.</p>
    {templates.length > 0 && <div className="row">
      <Field label="Saved setup" optional="Choose a template" value={selected} onChange={setSelected} options={templates.map(item => ({ value: item.id, label: item.name }))} />
      <button type="button" className="button ghost" disabled={!chosen || applying} onClick={() => void apply()}>{applying ? "Loading…" : "Apply and review"}</button>
    </div>}
    <div className="row"><label className="field"><span>New template name</span><input className="input" maxLength={200} value={name} onChange={event => setName(event.target.value)} placeholder="For example: monthly dialer export" /></label>
      <button type="button" className="button ghost" disabled={!name.trim() || applying} onClick={save}>Save current setup as a template</button>
    </div>
    {message && <p role="status" className="notice good">{message}</p>}
  </details>;
}
