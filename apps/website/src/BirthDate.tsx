import { DatePicker } from "@callerwhale/calendar";
import { latestBirthDate } from "./age.ts";

/** The date of birth field: Caller Whale's calendar, opening on the years (most people jump decades back). */
export function BirthDateField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="field">
      <label>
        Date of birth
        <DatePicker
          aria-label="Date of birth"
          required
          min="1900-01-01"
          max={latestBirthDate()}
          initialView="years"
          placeholder="Choose your date of birth"
          triggerClassName="date-input"
          value={value}
          onChange={event => onChange(event.target.value)}
        />
      </label>
    </div>
  );
}
