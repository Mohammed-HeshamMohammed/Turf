import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowSquareIn, ArrowSquareOut, ClosedCaptioning, DotsSixVertical, Microphone, PlayCircle, TextAa, X } from "@phosphor-icons/react";
import { ROLES } from "./data.js";
import { useCrm } from "./context.jsx";
import { addTranscriptLine, getCallSession, setCallSession, useCallSession } from "./callSession.js";
import { speechSupported, startListening } from "./listen.js";
import { CAPTIONS_CHANNEL, closeCaptionsWindow, inDesktopApp, openCaptionsWindow } from "./popout.js";
import { usePresence } from "./ui.jsx";

const WORD_MS = 230;
const TURN_PAUSE = 1100;
const POSITION_KEY = "turf.full-crm.captions-position";
const MARGIN = 8;

/** A believable two-sided conversation drawn from the lead record, played back word by word like live captions. */
function conversationFor(lead, agent) {
  const owner = lead.name?.split(" ")[0] || "Owner";
  const street = lead.address?.split(",")[0] || "the property";
  const reason = (lead.motivation || "I've been thinking about a move").replace(/\.$/, "");
  return [
    {
      who: agent,
      side: "agent",
      text: `Hi ${owner}, this is ${agent} from Oak & Palm. I'm reaching out about ${street}. Is now a good time for a quick conversation?`,
    },
    { who: owner, side: "owner", text: "Sure, I have a few minutes. What is this about?" },
    {
      who: agent,
      side: "agent",
      text: "We help owners who are thinking about selling. I wanted to understand your plans for the property and see if we can be useful.",
    },
    { who: owner, side: "owner", text: `${reason}. So I'm open to hearing what you'd offer.` },
    { who: agent, side: "agent", text: "That makes sense. Can you tell me a little about the condition of the house, and whether anyone is living there?" },
    { who: owner, side: "owner", text: "It's in decent shape. Nobody has lived there for a few months, so it's quiet at the moment." },
    { who: agent, side: "agent", text: "Thank you. And is there a date you would like to have everything wrapped up by?" },
    { who: owner, side: "owner", text: "Ideally within two or three months, but I can be flexible for the right number." },
    { who: agent, side: "agent", text: `Perfect. Let me put a time on our next conversation so we can go through the details together, ${owner}.` },
  ];
}

function readPosition() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(POSITION_KEY));
    return Number.isFinite(saved?.x) && Number.isFinite(saved?.y) ? saved : null;
  } catch {
    return null;
  }
}

/**
 * Produces the caption lines while captions are on and a call is live: a played-back sample conversation, or what the
 * microphone hears. Settled lines also go to the shared transcript, which is what the call assistant listens to.
 */
export function useCaptionEngine() {
  const { state } = useCrm();
  const { captions, source, active, lead } = useCallSession();
  const agent = ROLES[state.role].person.split(" ")[0];
  const [shown, setShown] = useState([]);

  useEffect(() => {
    setShown([]);
    if (!captions || !active || !lead) return undefined;

    if (source === "mic") {
      if (!speechSupported()) {
        setCallSession({ micState: "unavailable" });
        return undefined;
      }
      let counter = 0;
      // Browsers ask for permission without saying when they have been ignored, so say so ourselves after a few seconds.
      const nudge = setTimeout(() => getCallSession().micState !== "listening" && setCallSession({ micState: "waiting" }), 5000);
      const stop = startListening({
        onState: micState => setCallSession({ micState }),
        onInterim: text =>
          setShown(previous =>
            [...previous.filter(item => !item.live), ...(text ? [{ turn: "live", who: "You", side: "agent", text, live: true }] : [])].slice(-2),
          ),
        onFinal: text => {
          counter += 1;
          addTranscriptLine({ who: "You", side: "mic", text });
          setShown(previous => [...previous.filter(item => !item.live), { turn: "m" + counter, who: "You", side: "agent", text, live: false }].slice(-2));
        },
      });
      return () => {
        clearTimeout(nudge);
        stop();
        setCallSession({ micState: "idle" });
      };
    }

    // Sample conversation.
    setCallSession({ micState: "idle" });
    const turns = conversationFor(lead, agent);
    let alive = true;
    let turn = 0;
    let word = 0;
    let timer;
    const tick = () => {
      if (!alive) return;
      const current = turns[turn];
      if (!current) return;
      const words = current.text.split(" ");
      word += 1;
      const index = turn;
      const spoken = words.slice(0, word).join(" ");
      const live = word < words.length;
      setShown(previous =>
        [...previous.filter(item => item.turn !== index), { turn: index, who: current.who, side: current.side, text: spoken, live }].slice(-2),
      );
      if (word >= words.length) {
        addTranscriptLine({ who: current.who, side: current.side, text: current.text });
        turn += 1;
        word = 0;
        timer = setTimeout(tick, TURN_PAUSE);
      } else {
        timer = setTimeout(tick, WORD_MS + Math.min(words[word - 1].length, 9) * 12);
      }
    };
    timer = setTimeout(tick, 600);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [captions, source, active, lead?.id, agent]); // eslint-disable-line react-hooks/exhaustive-deps

  return shown;
}

/** The caption bar itself: the title row with its controls, then the lines. Used in the app and in a pop-out window. */
export function CaptionsPanel({ shown, active, large, source, micState, onSource, onLarge, onClose, onPopOut, onDock, grip, barProps }) {
  const blocked = source === "mic" && (micState === "denied" || micState === "unavailable");
  return (
    <div className={"captions" + (large ? " is-large" : "")} role="log" aria-live="off" aria-label="Live captions">
      <div className="captions-bar" {...barProps}>
        {grip}
        <span className="captions-tag">
          <ClosedCaptioning size={16} weight="fill" /> Live captions
          <i className="captions-dot" aria-hidden="true" />
        </span>
        <span className="captions-source" role="group" aria-label="Caption source">
          <button type="button" aria-pressed={source === "demo"} onClick={() => onSource("demo")} title="Play a sample conversation">
            <PlayCircle size={15} /> Demo
          </button>
          <button type="button" aria-pressed={source === "mic"} onClick={() => onSource("mic")} title="Caption what the microphone hears">
            <Microphone size={15} /> Mic
          </button>
        </span>
        <button type="button" onClick={onLarge} aria-label={large ? "Smaller captions" : "Larger captions"} aria-pressed={large}>
          <TextAa size={17} />
        </button>
        {onPopOut && (
          <button type="button" onClick={onPopOut} aria-label="Pop out to a floating window" title="Pop out: float over the whole screen">
            <ArrowSquareOut size={17} />
          </button>
        )}
        {onDock && (
          <button type="button" onClick={onDock} aria-label="Dock back into the app" title="Dock back into the app">
            <ArrowSquareIn size={17} />
          </button>
        )}
        <button type="button" onClick={onClose} aria-label="Turn captions off">
          <X size={16} />
        </button>
      </div>
      <div className="captions-lines">
        {blocked && (
          <p className="captions-wait">
            {micState === "denied"
              ? "Microphone access was blocked. Allow it for this app, or switch to Demo."
              : "Live speech to text isn't available here. Try Chrome or Edge, or switch to Demo."}
          </p>
        )}
        {source === "mic" && micState === "waiting" && shown.length === 0 && (
          <p className="captions-wait">Still waiting for the microphone. Allow access when asked, or switch to Demo.</p>
        )}
        {!blocked && !(source === "mic" && micState === "waiting") && shown.length === 0 && (
          <p className="captions-wait">
            {!active
              ? "Captions are on. Start the demo call and what is said appears here."
              : source === "mic"
                ? micState === "listening"
                  ? "Listening… speak and your words appear here."
                  : "Starting the microphone…"
                : "Waiting for the conversation to start…"}
          </p>
        )}
        {shown.map((line, index) => (
          <p key={line.turn} className={"caption-line " + line.side + (index === shown.length - 1 ? " is-current" : "")}>
            <b>{line.who}</b>
            <span>
              {line.text}
              {line.live && <em className="caret" aria-hidden="true" />}
            </span>
          </p>
        ))}
      </div>
    </div>
  );
}

/**
 * The live-caption bar: a dark pill that floats over the whole app while captions are on, and can be dragged anywhere in the window.
 */
export function LiveCaptions() {
  const { captions, source, micState, active, popout } = useCallSession();
  const shown = useCaptionEngine();
  const presence = usePresence(captions && !popout);
  const [large, setLarge] = useState(false);
  const [position, setPosition] = useState(readPosition);
  const [dragging, setDragging] = useState(false);
  const anchor = useRef(null);
  const drag = useRef(null);
  const latest = useRef(null);

  // Keep it fully on screen: clamp to the window, and sit bottom-centre until it has been moved.
  const place = useCallback(wanted => {
    const box = anchor.current?.getBoundingClientRect();
    const width = box?.width || 0;
    const height = box?.height || 0;
    const maxX = Math.max(MARGIN, window.innerWidth - width - MARGIN);
    const maxY = Math.max(MARGIN, window.innerHeight - height - MARGIN);
    const base = wanted || { x: (window.innerWidth - width) / 2, y: window.innerHeight - height - 56 };
    return { x: Math.min(Math.max(MARGIN, base.x), maxX), y: Math.min(Math.max(MARGIN, base.y), maxY) };
  }, []);
  const [placed, setPlaced] = useState(null);
  useLayoutEffect(() => {
    if (!presence.mounted) return;
    setPlaced(place(position));
  }, [presence.mounted, position, large, shown.length, place]);
  useEffect(() => {
    const onResize = () => setPlaced(place(position));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [position, place]);

  // ---- Floating window (desktop app only): this window runs the captions and streams each frame to it.
  const link = useRef(null);
  const dock = useCallback(() => {
    setCallSession({ popout: false });
    closeCaptionsWindow().catch(() => {});
  }, []);
  const popOut = useCallback(async () => {
    setCallSession({ popout: true });
    try {
      await openCaptionsWindow(() => setCallSession({ popout: false }));
    } catch {
      setCallSession({ popout: false });
    }
  }, []);
  const frame = useRef(null);
  frame.current = { type: "frame", shown, large, active, source, micState };
  useEffect(() => {
    if (!inDesktopApp()) return undefined;
    const channel = new BroadcastChannel(CAPTIONS_CHANNEL);
    link.current = channel;
    channel.onmessage = event => {
      const message = event.data;
      if (message?.type === "hello") channel.postMessage(frame.current);
      if (message?.type === "closed") setCallSession({ popout: false });
      if (message?.type === "action") {
        if (message.name === "source") setCallSession({ source: message.value });
        if (message.name === "large") setLarge(value => !value);
        if (message.name === "dock") dock();
        if (message.name === "close") {
          setCallSession({ captions: false, popout: false });
          closeCaptionsWindow().catch(() => {});
        }
      }
    };
    return () => channel.close();
  }, [dock]);
  useEffect(() => {
    if (popout) link.current?.postMessage({ type: "frame", shown, large, active, source, micState });
  }, [popout, shown, large, active, source, micState]);
  useEffect(() => {
    // Switching captions off from anywhere also closes the floating window.
    if (popout && !captions) dock();
  }, [popout, captions, dock]);

  function remember(next) {
    setPosition(next);
    try {
      window.localStorage.setItem(POSITION_KEY, JSON.stringify(next));
    } catch {
      /* Still moves for this session. */
    }
  }
  function startDrag(event) {
    if (event.button !== 0 || event.target.closest("button")) return;
    const current = latest.current || placed || place(position);
    latest.current = current;
    drag.current = { dx: event.clientX - current.x, dy: event.clientY - current.y };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* Dragging still works without capture. */
    }
    setDragging(true);
  }
  function moveDrag(event) {
    if (!drag.current) return;
    latest.current = place({ x: event.clientX - drag.current.dx, y: event.clientY - drag.current.dy });
    setPlaced(latest.current);
  }
  function endDrag(event) {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    if (latest.current) remember(latest.current);
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      /* Already released. */
    }
  }
  function keyMove(event) {
    const step = event.shiftKey ? 64 : 16;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    const current = placed || place(position);
    const next = place({ x: current.x + delta[0], y: current.y + delta[1] });
    latest.current = next;
    remember(next);
  }
  function resetPosition() {
    latest.current = null;
    setPosition(null);
    try {
      window.localStorage.removeItem(POSITION_KEY);
    } catch {
      /* Nothing saved to clear. */
    }
  }

  if (!presence.mounted) return null;
  const spot = placed || { x: 0, y: 0 };
  return (
    <div
      ref={anchor}
      className={"captions-anchor" + (dragging ? " is-dragging" : "") + (placed ? "" : " is-measuring") + (presence.leaving ? " leaving" : "")}
      style={{ transform: `translate3d(${Math.round(spot.x)}px, ${Math.round(spot.y)}px, 0)` }}
    >
      <CaptionsPanel
        shown={shown}
        active={active}
        large={large}
        source={source}
        micState={micState}
        onSource={value => setCallSession({ source: value })}
        onLarge={() => setLarge(!large)}
        onClose={() => setCallSession({ captions: false })}
        onPopOut={inDesktopApp() ? popOut : undefined}
        grip={
          <span
            className="captions-grip"
            role="button"
            tabIndex={0}
            aria-label="Move captions. Drag, or use the arrow keys. Hold Shift to move further."
            title="Drag to move · double-click to reset"
            onKeyDown={keyMove}
          >
            <DotsSixVertical size={18} weight="bold" />
          </span>
        }
        barProps={{
          onPointerDown: startDrag,
          onPointerMove: moveDrag,
          onPointerUp: endDrag,
          onPointerCancel: endDrag,
          onDoubleClick: event => !event.target.closest("button") && resetPosition(),
        }}
      />
    </div>
  );
}
