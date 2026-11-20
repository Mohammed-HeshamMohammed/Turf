import { useEffect, useState } from "react";

export function CallTimer({ startedAt, endedAt }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (endedAt) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [endedAt]);
  const seconds = Math.max(0, Math.floor(((endedAt || now) - (startedAt || now)) / 1000));
  return <span className="call-timer">{Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0")}</span>;
}
