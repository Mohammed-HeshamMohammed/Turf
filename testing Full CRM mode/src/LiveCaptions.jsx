import { useEffect, useRef, useState } from "react";
import { ClosedCaptioning, TextAa, X } from "@phosphor-icons/react";
import { usePresence } from "./ui.jsx";

const WORD_MS = 230;
const TURN_PAUSE = 1100;

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

/**
 * The live-caption bar: a dark pill that floats above the page while a call is running and captions are on.
 * There is no audio in the preview, so the captions are a played-back demo conversation.
 */
export function LiveCaptions({ show, lead, agent, onClose }) {
  const presence = usePresence(show);
  const [shown, setShown] = useState([]);
  const [large, setLarge] = useState(false);
  const run = useRef(0);

  useEffect(() => {
    if (!show || !lead) {
      setShown([]);
      return;
    }
    const token = ++run.current;
    const turns = conversationFor(lead, agent);
    let turn = 0;
    let word = 0;
    let timer;
    setShown([]);
    const tick = () => {
      if (token !== run.current) return;
      const current = turns[turn];
      if (!current) return;
      const words = current.text.split(" ");
      word += 1;
      const index = turn;
      const spoken = words.slice(0, word).join(" ");
      const live = word < words.length;
      setShown(previous => {
        const done = previous.filter(item => item.turn !== index);
        return [...done, { turn: index, who: current.who, side: current.side, text: spoken, live }].slice(-2);
      });
      if (word >= words.length) {
        turn += 1;
        word = 0;
        timer = setTimeout(tick, TURN_PAUSE);
      } else {
        timer = setTimeout(tick, WORD_MS + Math.min(words[word - 1].length, 9) * 12);
      }
    };
    timer = setTimeout(tick, 600);
    return () => {
      run.current += 1;
      clearTimeout(timer);
    };
  }, [show, lead?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!presence.mounted) return null;
  return (
    <div className={"captions" + (large ? " is-large" : "") + (presence.leaving ? " leaving" : "")} role="log" aria-live="off" aria-label="Live captions">
      <div className="captions-bar">
        <span className="captions-tag">
          <ClosedCaptioning size={16} weight="fill" /> Live captions
          <i className="captions-dot" aria-hidden="true" />
        </span>
        <span className="captions-demo">Demo audio</span>
        <button type="button" onClick={() => setLarge(!large)} aria-label={large ? "Smaller captions" : "Larger captions"} aria-pressed={large}>
          <TextAa size={17} />
        </button>
        <button type="button" onClick={onClose} aria-label="Turn captions off">
          <X size={16} />
        </button>
      </div>
      <div className="captions-lines">
        {shown.length === 0 && <p className="captions-wait">Waiting for the conversation to start…</p>}
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
