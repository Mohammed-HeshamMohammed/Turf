import { useEffect, useState } from "react";
import { followUpRules, setFollowUpRules, type Rules } from "../lib/service";

/**
 * What happens by itself after a call, for the whole project: a callback some days after no answer or a voicemail,
 * and a lead closed as dead after so many calls in a row that reach no one. 0 turns a rule off.
 */
export function FollowUpRules({ fail }: { fail: (reason: unknown) => void }) {
  const [rules, setRules] = useState<Rules | null>(null);
  useEffect(() => {
    let live = true;
    followUpRules().then(found => live && setRules(found), fail);
    return () => {
      live = false;
    };
  }, [fail]);
  if (!rules) return null;
  const field = (key: keyof Rules, label: string, max: number) => (
    <label className="field">
      <span>{label}</span>
      <input
        className="input"
        type="number"
        min={0}
        max={max}
        value={rules[key]}
        onChange={event => {
          const value = Math.max(0, Math.min(max, Number(event.target.value) || 0));
          setRules({ ...rules, [key]: value });
          void setFollowUpRules({ [key]: value }).then(setRules, fail);
        }}
      />
    </label>
  );
  return (
    <details className="card step follow-up-rules">
      <summary>
        Follow-up rules: call back {rules.after_no_answer_days ? `${rules.after_no_answer_days} days after no answer` : "not set after no answer"},{" "}
        {rules.after_voicemail_days ? `${rules.after_voicemail_days} after a voicemail` : "not after a voicemail"}
        {rules.close_after_misses ? `; close a lead after ${rules.close_after_misses} misses in a row` : ""}
      </summary>
      <div className="fields">
        {field("after_no_answer_days", "Call back this many days after no answer (0: no)", 365)}
        {field("after_voicemail_days", "Call back this many days after a voicemail (0: no)", 365)}
        {field("close_after_misses", "Close a lead as dead after this many calls in a row without an answer (0: never)", 50)}
      </div>
      <p className="muted">
        A callback already set is kept. A lead reached for the first time becomes Contacted. The rules are the project&apos;s, for every list, and each thing
        they do shows in the lead&apos;s history.
      </p>
    </details>
  );
}
