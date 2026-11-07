import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { nextStep, problemWith, recap, said, steps, type Answers, type Step } from "./signup-flow.ts";

// A sign-up that reads like a conversation (the /test page). It is a try-out: nothing is sent, saved or created. The questions are a
// script (signup-flow.ts), the choices are given, and consent comes as boxes that start unticked.

type Entry = { id: string; value: string | string[] };

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function Bubble({ who, children }: { who: "bot" | "me"; children: React.ReactNode }) {
  return <div className={`bubble ${who}`}>{children}</div>;
}

function Typing() {
  return (
    <div className="bubble bot typing" role="status" aria-label="The assistant is typing">
      <span /><span /><span />
    </div>
  );
}

function Question({ step, onAnswer }: { step: Step; onAnswer: (value: string | string[]) => void }) {
  const [value, setValue] = useState("");
  const [ticked, setTicked] = useState<string[]>([]);
  const [shown, setShown] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const send = (answer: string | string[]) => {
    const problem = problemWith(step, answer);
    if (problem) return setError(problem);
    onAnswer(answer);
  };
  if (step.kind === "choice") {
    return (
      <div className="chat-choices" role="group" aria-label="Choose one">
        {step.choices.map(choice => (
          <button key={choice.value} type="button" className="button raised" onClick={() => onAnswer(choice.value)}>
            {choice.label}
          </button>
        ))}
      </div>
    );
  }
  if (step.kind === "consent") {
    const toggle = (id: string) => (setError(""), setTicked(t => (t.includes(id) ? t.filter(x => x !== id) : [...t, id])));
    return (
      <form className="chat-consent" onSubmit={(e: FormEvent) => (e.preventDefault(), send(ticked))}>
        <fieldset>
          <legend className="sr-only">Your permissions</legend>
          {step.boxes.map(box => (
            <label key={box.id} className="chat-box">
              <input type="checkbox" checked={ticked.includes(box.id)} onChange={() => toggle(box.id)} />
              <span>
                {box.label} <small>{box.required ? "(required)" : "(optional)"}</small>
              </span>
            </label>
          ))}
        </fieldset>
        {error && <p className="notice bad" role="alert">{error}</p>}
        <button className="button primary" type="submit">Continue</button>
      </form>
    );
  }
  if (step.kind === "review") return null;
  const password = step.kind === "password";
  return (
    <form className="chat-input" onSubmit={(e: FormEvent) => (e.preventDefault(), send(password ? value : value.trim()))} noValidate>
      <div className="chat-input-row">
        <input
          ref={input}
          type={password && !shown ? "password" : step.kind === "email" ? "email" : "text"}
          autoComplete={password ? "new-password" : step.kind === "email" ? "email" : "given-name"}
          aria-label={step.ask[step.ask.length - 1]}
          placeholder={step.placeholder}
          value={value}
          onChange={e => (setValue(e.target.value), setError(""))}
        />
        {password && (
          <button type="button" className="button raised" onClick={() => setShown(s => !s)} aria-pressed={shown}>
            {shown ? "Hide" : "Show"}
          </button>
        )}
        <button className="button primary" type="submit">Send</button>
      </div>
      {error && <p className="notice bad" role="alert">{error}</p>}
    </form>
  );
}

export function ChatSignup() {
  const [log, setLog] = useState<Entry[]>([]);
  const [created, setCreated] = useState(false);
  const [typing, setTyping] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const answers: Answers = Object.fromEntries(log.map(entry => [entry.id, entry.value]));
  const step = nextStep(answers);

  // The assistant "types" for a moment before each question, except the first and for people who ask for less motion.
  useEffect(() => {
    if (!log.length || reducedMotion()) {
      setTyping(false);
      return;
    }
    setTyping(true);
    const timer = setTimeout(() => setTyping(false), 450);
    return () => clearTimeout(timer);
  }, [log.length, created]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [log.length, typing, created]);

  const answer = (value: string | string[]) => step && setLog(l => [...l, { id: step.id, value }]);
  const restart = () => (setLog([]), setCreated(false));

  return (
    <div className="form-wrap">
      <div className="card chat-card">
        <p className="notice" role="note">This is a try-out page. Nothing you type here is sent, saved or turned into an account.</p>
        <div className="chat" role="log" aria-live="polite" aria-label="Sign-up conversation">
          {log.map(entry => {
            const past = steps.find(s => s.id === entry.id)!;
            return (
              <Fragment key={entry.id}>
                {past.ask.map(line => <Bubble key={line} who="bot">{line}</Bubble>)}
                {past.kind !== "review" && <Bubble who="me">{said(past, entry.value)}</Bubble>}
              </Fragment>
            );
          })}
          {step && step.kind !== "review" && (typing ? <Typing /> : step.ask.map(line => <Bubble key={line} who="bot">{line}</Bubble>))}
          {step?.kind === "review" && !created && (typing ? <Typing /> : (
            <Bubble who="bot">
              Here is what I will set up for you:
              <dl className="chat-recap">
                {recap(answers).map(([title, text]) => <Fragment key={title}><dt>{title}</dt><dd>{text}</dd></Fragment>)}
              </dl>
            </Bubble>
          ))}
          {created && (
            <Bubble who="bot">
              {answers.intent === "new" ? "That is everything. In the real thing, I would create your account now and send a link to confirm your email." : "You would be signed in now, and asked for your two-step code first if your account uses one."}{" "}
              Because this is a try-out, nothing was created or sent.
            </Bubble>
          )}
          <div ref={end} />
        </div>

        {!typing && step && step.kind !== "review" && <Question key={step.id} step={step} onAnswer={answer} />}
        {!typing && step?.kind === "review" && !created && (
          <div className="chat-choices">
            <button type="button" className="button primary" onClick={() => setCreated(true)}>
              {answers.intent === "new" ? "Create my account" : "Sign me in"}
            </button>
            <button type="button" className="button raised" onClick={() => setLog(l => l.slice(0, -1))}>Change my last answer</button>
          </div>
        )}
        {created && <div className="chat-choices"><button type="button" className="button raised" onClick={restart}>Start again</button></div>}
        {log.length > 0 && !created && !typing && step?.kind !== "review" && (
          <button type="button" className="chat-undo" onClick={() => setLog(l => l.slice(0, -1))}>← Change my last answer</button>
        )}
      </div>
    </div>
  );
}
