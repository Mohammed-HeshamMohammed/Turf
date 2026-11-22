import { useEffect, useState } from "react";
import { api } from "./remote/api.ts";
import { Badge, Button, Card } from "./ui.jsx";

// What happens to a workspace's lists once they are added, and the administrator's choice (docs/legal/research/learning-store-compliance.md).
// Plain words first: a short list of what is kept and what is never kept, and one switch.
export function LearningChoice({ notify }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .learningStatus()
      .then((value) => live && setStatus(value))
      .catch(() => live && setStatus({ available: false }));
    return () => {
      live = false;
    };
  }, []);
  if (!status?.available) return null;
  const optedOut = status.opted_out || !status.enabled;
  const change = async (out) => {
    if (out && !window.confirm("Stop using this workspace's lists to improve Caller Whale, and erase what was kept from them? This cannot be undone.")) return;
    setBusy(true);
    try {
      await (out ? api.learningOptOut() : api.learningOptIn());
      setStatus({ ...status, opted_out: out });
      notify(out ? "Stopped, and what was kept has been erased" : "Turned on again");
    } catch (error) {
      notify("That could not be changed: " + (error?.message || "try again"));
    }
    setBusy(false);
  };
  return (
    <Card title="Improving Caller Whale with your lists">
      <p className="body-copy">
        {optedOut
          ? "Your lists are not used to improve Caller Whale."
          : "When a list is added, Caller Whale keeps a scrambled copy of it, only to improve its suggestions for your workspace."}
      </p>
      <ul className="offline-points">
        <li>
          <strong>Kept:</strong> phone numbers and emails only as one-way codes, the kind of name (person or company), city, state and ZIP, a few property
          facts, and what your team decides about each lead.
        </li>
        <li>
          <strong>Never kept:</strong> names, phone numbers, emails, street addresses, notes or recordings.
        </li>
        <li>
          <strong>Never shared or sold.</strong> It stays inside Caller Whale. You can switch it off at any time, and kept copies are deleted after two years.
        </li>
      </ul>
      <div className="row">
        <Badge>{optedOut ? "Off" : "On"}</Badge>
        {optedOut ? (
          status.enabled ? (
            <Button disabled={busy} onClick={() => change(false)}>
              Turn on
            </Button>
          ) : null
        ) : (
          <Button disabled={busy} onClick={() => change(true)}>
            Turn off and erase
          </Button>
        )}
      </div>
    </Card>
  );
}
