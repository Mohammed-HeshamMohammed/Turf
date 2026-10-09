import { useState } from "react";
import { downloadDataset } from "../lib/service";

export function ListDownloads({ datasetId, checkedId, fail }: { datasetId: string; checkedId?: string; fail: (reason: unknown) => void }) {
  const [busy, setBusy] = useState<"original" | "checked" | null>(null);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  async function download(version: "original" | "checked") {
    setBusy(version);
    setProgress(0);
    setMessage("");
    try {
      const saved = await downloadDataset(version === "checked" ? checkedId! : datasetId, version, setProgress);
      if (saved) setMessage(version === "original" ? "Original file downloaded." : "Checked CSV downloaded with all rows and result columns.");
    } catch (reason) { fail(reason); }
    finally { setBusy(null); }
  }
  return <div className="download-actions">
    <div className="row">
      <button type="button" className="button ghost small" disabled={busy !== null} onClick={() => void download("original")}>{busy === "original" ? `Downloading original… ${progress}%` : "Download original"}</button>
      {checkedId && <button type="button" className="button ghost small" disabled={busy !== null} onClick={() => void download("checked")}>{busy === "checked" ? `Downloading checked copy… ${progress}%` : "Download checked CSV"}</button>}
    </div>
    {message && <span className="muted" role="status">{message}</span>}
  </div>;
}
