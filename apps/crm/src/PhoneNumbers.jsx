import { useEffect, useState } from "react";
import { api } from "./remote/api.ts";
import { Card, Checkbox } from "./ui.jsx";

/** The owner's switch, team by team: agents see a lead's whole phone number, or only its last four digits (D163). Team leads,
 * admins and the owner always see whole numbers; the dialer dials the real number either way. */
export function PhoneNumbers({ notify }) {
  const [teams, setTeams] = useState(null);
  const [full, setFull] = useState(new Set());
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    Promise.all([api.teams(), api.protection()])
      .then(([listed, protection]) => {
        if (!live) return;
        setTeams(listed || []);
        setFull(new Set(protection?.full_number_teams || []));
      })
      .catch(cause => live && setError(cause?.message || "The teams could not be loaded."));
    return () => {
      live = false;
    };
  }, []);
  const change = async (team, on) => {
    setSaving(team.id);
    setError("");
    try {
      await api.setFullNumbers(team.id, on);
      setFull(current => {
        const next = new Set(current);
        if (on) next.add(team.id);
        else next.delete(team.id);
        return next;
      });
      notify?.(on ? `${team.name}: agents now see full phone numbers` : `${team.name}: agents see only the last four digits`);
    } catch (cause) {
      setError(cause?.message || "The setting could not be saved.");
    } finally {
      setSaving("");
    }
  };
  return (
    <Card title="Phone numbers" subtitle="Agents see only the last four digits of a lead's number unless you show their team full numbers. Team leads, admins and you always see them.">
      {error && <p className="notice bad" role="alert">{error}</p>}
      {teams === null && !error && <p className="muted">Loading the teams…</p>}
      {teams?.length === 0 && <p className="muted">There are no teams yet.</p>}
      <div className="phone-number-teams">
        {(teams || []).map(team => (
          <Checkbox
            key={team.id}
            label={`${team.name}: agents see full numbers${saving === team.id ? " (saving…)" : ""}`}
            checked={full.has(team.id)}
            onChange={event => saving || change(team, event.target.checked)}
          />
        ))}
      </div>
    </Card>
  );
}
