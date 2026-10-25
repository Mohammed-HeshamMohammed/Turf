import { useState } from "react";
import { ArrowUpRight, Phone } from "@phosphor-icons/react";
import { useCrm } from "./context.jsx";
import { beginDemoCall, useCallSession } from "./callSession.js";
import { dialerTarget } from "./dialer.js";
import { callDuration, visibleCallLog } from "./callLog.js";
import { Button, Empty, Search } from "./ui.jsx";

export function CallLog({ onDial, onClose }) {
  const { state, navigate, notify } = useCrm();
  const session = useCallSession();
  const [search, setSearch] = useState("");
  const entries = visibleCallLog(state).filter(call => [call.name, call.phone, call.outcome].join(" ").toLowerCase().includes(search.toLowerCase()));
  const busy = session.active || session.awaitingOutcome;
  return <div className="call-log">
    <Search label="Search call log" placeholder="Search calls…" value={search} onChange={setSearch} />
    <div className="call-log-entries">
      {entries.map(call => {
        const target = dialerTarget(state, call.phone || "");
        const duration = callDuration(call);
        return <article className="call-log-entry" key={call.id}>
          <span className="call-log-icon"><Phone size={18} /></span>
          <div className="call-log-details">
            <strong>{call.name || call.phone}</strong>
            {call.name && call.phone && <span>{call.phone}</span>}
            <span>{call.outcome}{duration && " · " + duration}</span>
            <time>{new Date(call.startedAt || call.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
            <span>{call.agent}{call.endedBy === "contact" && " · Contact hung up"}</span>
            <div className="call-log-actions">
              <Button icon={Phone} disabled={busy || !state.online || Boolean(target.error)} title={busy ? "Finish the current call and its outcome first" : target.error} onClick={() => {
                if (onDial) return onDial(call.phone);
                if (beginDemoCall(target.lead)) { notify("Demo call started — no real number is dialed"); onClose?.(); }
              }}>Call again</Button>
              {call.leadId && <button type="button" className="text-button" onClick={() => { navigate("work/leads/" + call.leadId); onClose?.(); }}><ArrowUpRight size={15} />Lead</button>}
            </div>
          </div>
        </article>;
      })}
      {!entries.length && <Empty title={search ? "No matching calls" : "No calls yet"}>{search ? "Try another name or number." : "Calls you finish appear here, including numbers without a lead."}</Empty>}
    </div>
  </div>;
}
