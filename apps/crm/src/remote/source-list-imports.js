const amount = value => Math.max(0, Number(value) || 0);

export const needsImportAction = job => ["mapping", "reviewing", "ready", "failed"].includes(job.status);

export const importPath = job => `lists/${job.project_id || "new"}/imports/${job.id}`;

export function importStatusMessage(job) {
  const name = job.name || job.filename || "Your list";
  switch (job.status) {
    case "mapping": return `${name}: confirm the source columns.`;
    case "reviewing": return `${name}: review possible repeats.`;
    case "ready": return `${name}: ready to add to your leads.`;
    case "done": return `${name}: import finished.`;
    case "failed": return `${name}: import needs attention.`;
    default: return "";
  }
}

export function sourceListProgress(jobs = []) {
  const result = { hasImport: jobs.length > 0, sourceRows: 0, processedRows: 0, unprocessedRows: 0, addedRows: 0, needsAction: false, inProgress: false };
  for (const job of jobs) {
    const report = job.report || {};
    const sourceRows = amount(report.rows ?? (amount(job.loaded_rows) - amount(report.exact_duplicates) - amount(report.empty_rows)));
    const phase = job.status === "failed" || job.status === "cancelled" ? job.progress?.phase : job.status;
    const processed = ["reviewing", "ready", "merging", "done"].includes(phase)
      ? sourceRows
      : phase === "cleaning" ? Math.min(sourceRows, amount(job.progress?.done)) : 0;
    result.sourceRows += sourceRows;
    result.processedRows += processed;
    result.unprocessedRows += sourceRows - processed;
    result.addedRows += amount(job.merged_rows);
    result.needsAction ||= needsImportAction(job);
    result.inProgress ||= ["uploading", "queued", "loading", "cleaning", "merging"].includes(job.status);
  }
  return result;
}
