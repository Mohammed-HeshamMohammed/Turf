import { useEffect, useState } from "react";
import { floodZone, type FloodZone } from "../lib/service";

/** The FEMA flood zone of a property. FEMA answers US connections only, so outside the US a VPN is needed. */
export function FloodLine({ position }: { position: [number, number] }) {
  const [answer, setAnswer] = useState<FloodZone | null>(null);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    let current = true;
    let timer = 0;
    let tries = 0;
    const ask = (retry: boolean) => floodZone(position[0], position[1], retry).then(result => {
      if (!current) return;
      setAnswer(result);
      if (result.pending && tries++ < 30) timer = window.setTimeout(() => ask(false), 2500);
    }, () => current && setAnswer({ unavailable: "FEMA could not be asked" }));
    void ask(again > 0);
    return () => { current = false; window.clearTimeout(timer); };
  }, [position[0], position[1], again]);
  if (!answer) return null;
  if (answer.pending) return <p className="muted">Asking FEMA for the flood zone…</p>;
  if (answer.unavailable) {
    return <p className="flood-line"><span className="muted">Flood zone: {answer.unavailable}</span> <button type="button" className="link" onClick={() => setAgain(count => count + 1)}>Try again</button></p>;
  }
  return <p className="flood-line"><span className={answer.risk === "high" ? "pill pill-suspicious" : "pill pill-none"}>{answer.zone ? `Flood zone ${answer.zone}` : "No flood zone"}</span> {answer.text}</p>;
}
