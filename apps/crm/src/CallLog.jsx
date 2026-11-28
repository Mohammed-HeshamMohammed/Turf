import { useState } from "react";
import { ArrowUpRight, Phone } from "@phosphor-icons/react";
import { useCrm } from "./context.jsx";
import { useCallSession } from "./callSession.ts";
import { calling } from "./calling.ts";
import { dialerTarget } from "./dialer.ts";
import { callDuration, visibleCallLog } from "./callLog.ts";
import { Button, Empty, Search } from "./ui.jsx";
import { capability } from "./model.ts";

export function CallLog({ onCall }) {
  const { state, navigate, notify } = useCrm();
  const session = useCallSession();
  const [search, setSearch] = useState("");
  const entries = visibleCallLog(state).filter(call => [call.name, call.phone, call.outcome].join(" ").toLowerCase().includes(search.toLowerCase()));
  const busy = session.active || session.awaitingOutcome;
  return <div className="call-log">
    {state.remote && capability(state, "import") && <div className="import-actions"><Button onClick={() => navigate("work/calls?view=import")}>Import ReadyMode history</Button></div>}
    <Search label="Search call log" placeholder="Search calls…" value={search} onChange={setSearch} />
    <div className="call-log-entries">
      {entries.map(call => {
        const target = dialerTarget(state, call.phone || "");
        const duration = callDuration(call);
        return <article className="call-log-entry" key={call.id}>
          <span className="call-log-icon"><Phone size={18} /></span>
          <div className="call-log-details">
            <div className="call-log-person"><strong>{call.name || call.phone}</strong>{call.name && call.phone && <span>{call.phone}</span>}</div>
            <div className="call-log-result"><span>{call.outcome}{duration && " · " + duration}</span>{call.endedBy === "contact" && <span>Contact hung up</span>}</div>
            {call.notes && <p className="muted">{call.notes}</p>}
            {call.source === "readymode" && <span className="muted">ReadyMode{call.details?.phones?.length > 1 ? " · Other numbers: " + call.details.phones.slice(1).join(", ") : ""}</span>}
            <div className="call-log-when"><time>{new Date(call.startedAt || call.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time><span>{call.agent}</span></div>
            <div className="call-log-actions">
              <Button icon={Phone} disabled={busy || !state.online || Boolean(target.error)} title={busy ? "Finish the current call and its outcome first" : target.error} onClick={async () => {
                // Called again the way the Calls page calls: through the dialer when this workspace has one.
                const started = await calling.start(state, target.lead);
                if (!started.ok) { notify(started.error || "The call did not start"); return; }
                notify(started.mode === "demo" ? "Demo call started — no real number is dialed" : "Calling " + (target.lead.name || target.lead.phone));
                onCall?.();
              }}>Call again</Button>
              {call.leadId && <button type="button" className="text-button" onClick={() => navigate("work/leads/" + call.leadId)}><ArrowUpRight size={15} />Lead</button>}
            </div>
          </div>
        </article>;
      })}
      {!entries.length && <Empty title={search ? "No matching calls" : "No calls yet"}>{search ? "Try another name or number." : "Calls you finish appear here, including numbers without a lead."}</Empty>}
    </div>
  </div>;
}
