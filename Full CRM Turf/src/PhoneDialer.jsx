import { useEffect, useRef, useState } from "react";
import { Backspace, Phone, PhoneDisconnect, X } from "@phosphor-icons/react";
import { useCrm } from "./context.jsx";
import { capability, visibleLeads } from "./model.js";
import { beginDemoCall, clearCallOutcome, endDemoCall, useCallSession } from "./callSession.js";
import { dialerTarget } from "./dialer.js";
import { CallTimer } from "./CallTimer.jsx";
import { CallLog } from "./CallLog.jsx";
import { Button, Segmented, usePresence } from "./ui.jsx";

const KEYS = [["1", ""], ["2", "ABC"], ["3", "DEF"], ["4", "GHI"], ["5", "JKL"], ["6", "MNO"], ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"], ["*", ""], ["0", ""], ["#", ""]];

export function PhoneDialer() {
  const { state, navigate, notify, route } = useCrm();
  const session = useCallSession();
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState("");
  const [view, setView] = useState("Keypad");
  const root = useRef(null);
  const trigger = useRef(null);
  const input = useRef(null);
  const presence = usePresence(open);
  const allowed = capability(state, "call");
  const busy = session.active || session.awaitingOutcome;
  const linkedLead = visibleLeads(state).find(item => item.id === session.lead?.id);
  const contactVisible = session.lead?.adHoc || linkedLead;
  const target = dialerTarget(state, number);

  useEffect(() => {
    setOpen(false);
    setNumber("");
  }, [state.role, allowed]);
  useEffect(() => {
    if (!open) return;
    if (!busy && view === "Keypad") input.current?.focus({ preventScroll: true });
    else root.current?.querySelector(".phone-panel button")?.focus({ preventScroll: true });
  }, [open, busy, session.active, view]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = event => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    const keyboard = event => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keyboard);
    };
  }, [open]);

  if (!allowed) return null;
  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  function start(event) {
    event.preventDefault();
    if (busy || !state.online || target.error) return;
    if (beginDemoCall(target.lead)) notify("Demo call started — no real number is dialed");
  }
  function workspace() {
    if (!route.startsWith("work/calls")) navigate("work/calls/" + encodeURIComponent(session.lead?.id || ""));
    close();
  }

  return (
    <div className="phone-dialer" ref={root}>
      {presence.mounted && <section id="phone-dial-pad" className={"phone-panel" + (presence.leaving ? " leaving" : "")} role="dialog" aria-label="Phone dial pad" aria-hidden={!open} inert={!open}>
        <header className="phone-panel-head">
          <h2>{view === "Call log" ? "Call log" : busy ? session.active ? "On a call" : "Call ended" : "Dial pad"}</h2>
          <button type="button" className="phone-close" aria-label="Close dial pad" onClick={close}><X size={18} /></button>
        </header>
        <Segmented label="Phone view" value={view} options={["Keypad", "Call log"]} onChange={setView} />
        {view === "Call log" ? <CallLog onDial={phone => { setNumber(phone); setView("Keypad"); }} /> : busy ? <div className="phone-current-call">
          <span className={"phone-call-icon" + (session.awaitingOutcome ? " is-ended" : "")}><Phone size={25} weight="fill" /></span>
          <strong>{contactVisible ? session.lead?.adHoc ? session.lead.phone : linkedLead?.name : "Current call"}</strong>
          {linkedLead && <p>{linkedLead.phone}</p>}
          <CallTimer key={session.startedAt} startedAt={session.startedAt} endedAt={session.endedAt} />
          {session.lead?.adHoc && <small className="muted">This number is not linked to a lead.</small>}
          {session.active ? <Button variant="danger-button" icon={PhoneDisconnect} onClick={() => endDemoCall()}>End demo call</Button> : session.lead?.adHoc ? <Button variant="primary" onClick={clearCallOutcome}>Done</Button> : <>
            <p className="muted">Record the current call's outcome before dialing again.</p>
            <Button variant="primary" onClick={workspace}>Record call outcome</Button>
          </>}
          {session.active && linkedLead && <button type="button" className="text-button" onClick={workspace}>Open call workspace</button>}
        </div> : <form onSubmit={start}>
          <div className="phone-number-entry">
            <input ref={input} aria-label="Phone number" inputMode="tel" autoComplete="off" placeholder="Enter a number" maxLength={28} value={number} onChange={event => setNumber(event.target.value.replace(/[^\d+*# ()-]/g, ""))} />
            <button type="button" className="phone-close" aria-label="Delete last digit" disabled={!number} onClick={() => setNumber(value => value.slice(0, -1))}><Backspace size={20} /></button>
          </div>
          <p className="phone-number-context" role="status">{!state.online ? "Connect to start a call." : number ? target.error || (target.lead.adHoc ? "Number not linked to a lead" : target.lead.name) : "Type, paste, or use the keypad."}</p>
          <div className="phone-keypad" aria-label="Number keypad">
            {KEYS.map(([digit, letters]) => <button key={digit} type="button" aria-label={digit + (letters ? " " + letters : "")} onClick={() => setNumber(value => (value + digit).slice(0, 28))}><span>{digit}</span>{letters && <small>{letters}</small>}</button>)}
          </div>
          <div className="phone-dial-actions">
            <button type="button" className="phone-plus" aria-label="Add international prefix" onClick={() => setNumber(value => value.startsWith("+") ? value : "+" + value)}>+</button>
            <button type="submit" className="button primary" disabled={!state.online || Boolean(target.error)}><Phone size={18} />Start demo call</button>
            <button type="button" className="phone-clear" disabled={!number} onClick={() => setNumber("")}>Clear</button>
          </div>
          <p className="demo-note">No number is dialed and no microphone is used.</p>
        </form>}
      </section>}
      <button ref={trigger} type="button" className={"phone-launcher" + (open ? " is-open" : "")} aria-label={open ? "Close phone dial pad" : "Open phone dial pad"} title={busy ? session.active ? "Phone · Call in progress" : session.lead?.adHoc ? "Phone · Call ended" : "Phone · Outcome needed" : "Phone dial pad"} aria-expanded={open} aria-controls="phone-dial-pad" onClick={() => setOpen(value => !value)}>
        <Phone size={25} weight="fill" />
        {busy && <span className={"phone-launcher-status" + (session.awaitingOutcome ? " is-ended" : "")} />}
      </button>
    </div>
  );
}
