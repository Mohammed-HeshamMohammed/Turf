import { useEffect, useRef, useState } from "react";
import { ChatCenteredText, Flag, Pause, Play, Plus, Question, Sparkle, Warning, X } from "@phosphor-icons/react";
import { Card, Select, Field } from "./ui.jsx";
import { cuesFor } from "./cues.js";
import { useCallSession } from "./callSession.js";

const STORAGE_KEY = "callerwhale.full-crm.ai-assist";
const INTERVAL = 6000;
const MAX_SHOWN = 5;

const KINDS = {
  say: { label: "Say next", icon: ChatCenteredText },
  ask: { label: "Ask", icon: Question },
  watch: { label: "Watch for", icon: Warning },
  next: { label: "Next step", icon: Flag },
};

const OPENINGS = {
  "First conversation": name => `Hi, this is ${name} from Oak & Palm. I'm reaching out about your property. Is now a good time for a quick conversation?`,
  Callback: () => "Hi, thanks for making time. Last time we spoke about your plans for the property. Has anything changed since then?",
  "Offer follow-up": () => "Hi, I wanted to see if you've had a chance to review the offer. What questions can I help with?",
};

/** The prompts a live assistant would raise, in the order a good call tends to need them, drawn from what the lead record already says. */
function suggestionsFor(lead, script) {
  const street = lead.address?.split(",")[0] || "the property";
  const first = lead.name?.split(" ")[0] || "them";
  const called = lead.calls?.length || 0;
  const list = [
    { kind: "say", text: `Use ${first}'s name early and confirm you're speaking about ${street}.` },
    {
      kind: "ask",
      text: lead.motivation
        ? `Their note says: “${lead.motivation}” Ask how that is shaping their plans now.`
        : "Ask what is prompting them to think about selling.",
    },
    { kind: "watch", text: "If they hesitate on price, don't counter yet. Ask what number would make the move work for them." },
    { kind: "ask", text: "Ask about the property's condition and whether anyone lives there or rents it." },
    { kind: "ask", text: "Ask about timing: is there a date they need to be moved or closed by?" },
    { kind: "watch", text: "If they say they're talking to other buyers, ask what matters most besides price." },
    { kind: "say", text: "Summarise back what you heard in two sentences before you suggest anything." },
    {
      kind: "next",
      text: lead.callback
        ? `Confirm the callback (${lead.callbackDate ? lead.callbackDate + " " : ""}${lead.callback}) and ask what they'd like covered.`
        : "Agree the next conversation before you hang up and put a time on it.",
    },
  ];
  if (script === "Callback" || called > 1) list.splice(1, 0, { kind: "say", text: "Reference the last call first so they know you were listening." });
  if (script === "Offer follow-up") list.splice(2, 0, { kind: "ask", text: "Ask which part of the offer they'd change if they could change one thing." });
  return list;
}

function readEnabled() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

/**
 * The call-side AI helper: an opening line to start with and, when switched on, live prompts that keep arriving while a call is running.
 * With captions off, prompts come from the lead's record on a timer. With captions on, it listens to the transcript instead and
 * answers what is actually said. All of it is matched on this device; nothing said is sent anywhere.
 */
export function CallAssistant({ lead, person, script, onScript, activeCall, captions, onCaptions, onUse }) {
  const [enabled, setEnabled] = useState(readEnabled);
  const [paused, setPaused] = useState(false);
  const [feed, setFeed] = useState([]);
  const counter = useRef(0);
  const plan = useRef([]);
  const seen = useRef(new Set());
  const handled = useRef(0);
  const { transcript } = useCallSession();
  const status = !enabled ? "off" : !activeCall ? "ready" : paused ? "paused" : "listening";

  function toggle() {
    const next = !enabled;
    setEnabled(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
    } catch {
      /* The switch still works for this session. */
    }
  }

  // A new call (or a different lead) starts a fresh plan and feed.
  useEffect(() => {
    plan.current = lead ? suggestionsFor(lead, script) : [];
    counter.current = 0;
    seen.current = new Set();
    handled.current = 0;
    setFeed([]);
    setPaused(false);
  }, [lead?.id, activeCall, script]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listening mode: every new line said on the call can raise a prompt, once per topic.
  useEffect(() => {
    if (status !== "listening" || !captions) return;
    const fresh = transcript.filter(line => line.id > handled.current);
    if (!fresh.length) return;
    handled.current = fresh[fresh.length - 1].id;
    const cues = fresh.filter(line => line.side !== "agent").flatMap(line => cuesFor(line.text, seen.current).map(cue => ({ ...cue, quote: line.text })));
    if (!cues.length) return;
    setFeed(current => [...cues.map(cue => ({ ...cue, id: "cue-" + cue.ruleId })), ...current].slice(0, MAX_SHOWN));
  }, [transcript, status, captions]);

  useEffect(() => {
    // With captions on, the feed follows what is said; the timer only fills in when nothing is being transcribed.
    if (status !== "listening" || captions) return;
    const push = () => {
      const pool = plan.current;
      if (!pool.length) return;
      const item = pool[counter.current % pool.length];
      counter.current += 1;
      setFeed(current => [{ ...item, id: counter.current }, ...current].slice(0, MAX_SHOWN));
    };
    if (!counter.current) push();
    const timer = setInterval(push, INTERVAL);
    return () => clearInterval(timer);
  }, [status, captions]);

  const opening = (OPENINGS[script] || OPENINGS["First conversation"])(person);

  return (
    <Card className={"ai-assist status-" + status}>
      <header className="ai-head">
        <div className="ai-title">
          <span className="ai-spark">
            <Sparkle size={18} weight="fill" />
          </span>
          <div>
            <h2>Call assistant</h2>
            <small>
              {status === "off" && "Suggestions are off"}
              {status === "ready" && "Ready · starts with your call"}
              {status === "listening" && "Listening along"}
              {status === "paused" && "Paused"}
            </small>
          </div>
        </div>
        <button type="button" role="switch" aria-checked={enabled} aria-label="Live suggestions" className="ai-switch" onClick={toggle}>
          <span />
        </button>
      </header>

      {enabled && (
        <div className="ai-live" aria-live="polite">
          <div className="ai-live-bar">
            <span className={"ai-wave " + (status === "listening" ? "is-live" : "")} aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
            <span className="ai-live-text">
              {status === "listening"
                ? captions
                  ? "Listening to the call for cues"
                  : "Suggesting as the call goes"
                : status === "paused"
                  ? "Paused. Nothing new until you resume"
                  : "Start the call and prompts will appear here"}
            </span>
            {activeCall && (
              <button type="button" className="ai-mini" onClick={() => setPaused(!paused)} aria-label={paused ? "Resume suggestions" : "Pause suggestions"}>
                {paused ? <Play size={14} weight="fill" /> : <Pause size={14} weight="fill" />}
              </button>
            )}
          </div>
          <ol className="ai-feed">
            {feed.map((item, index) => {
              const Kind = KINDS[item.kind].icon;
              return (
                <li key={item.id} className={"ai-card kind-" + item.kind} data-newest={index === 0}>
                  <span className="ai-kind">
                    <Kind size={14} weight="bold" />
                    {KINDS[item.kind].label}
                  </span>
                  <p>{item.text}</p>
                  {item.heard && <small className="ai-heard">Heard “{item.heard}”</small>}
                  <div className="ai-card-actions">
                    <button type="button" onClick={() => onUse(item.text)}>
                      <Plus size={13} weight="bold" /> Add to note
                    </button>
                    <button type="button" aria-label="Dismiss suggestion" onClick={() => setFeed(current => current.filter(entry => entry.id !== item.id))}>
                      <X size={13} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      <div className="ai-captions-row">
        <div>
          <strong>Live captions</strong>
          <small>{captions ? (activeCall ? "Showing on screen" : "On · starts with your call") : "Show what is said, as it is said"}</small>
        </div>
        <button type="button" role="switch" aria-checked={captions} aria-label="Live captions" className="ai-switch" onClick={() => onCaptions()}>
          <span />
        </button>
      </div>

      <div className="ai-section">
        <Field label={enabled ? "Opening line for" : "Call script"}>
          <Select value={script} onChange={event => onScript(event.target.value)}>
            <option>First conversation</option>
            <option>Callback</option>
            <option>Offer follow-up</option>
          </Select>
        </Field>
        <div className="script">{opening}</div>
      </div>

      <div className="ai-section">
        <h3>Listen for</h3>
        <ul className="plain-list">
          <li>Their plans and reason for selling</li>
          <li>Property condition and occupancy</li>
          <li>Expected timeline</li>
          <li>The next agreed conversation</li>
        </ul>
      </div>
      <p className="ai-note demo-note">Preview only: no audio is captured or sent, and prompts are drawn from the lead record.</p>
    </Card>
  );
}
