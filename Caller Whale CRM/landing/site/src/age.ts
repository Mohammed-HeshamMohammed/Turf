// The age check on the website's side: the same rule the auth service enforces (18 or older), used to say so at once instead of
// after a round trip. The service has the final word.

export const MINIMUM_AGE = 18;

const pad = (value: number) => String(value).padStart(2, "0");

/** The whole years between a birth date (YYYY-MM-DD) and a day, or null when it is not a real date. */
export function ageOn(birth: string, today: Date): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birth.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const t = { year: today.getFullYear(), month: today.getMonth() + 1, day: today.getDate() };
  let age = t.year - year;
  if (t.month < month || (t.month === month && t.day < day)) age -= 1;
  return age;
}

/** A sentence to show under the date, or an empty text when it is fine (or still empty). */
export function ageProblem(birth: string, today: Date = new Date()): string {
  if (!birth) return "";
  const age = ageOn(birth, today);
  if (age === null || age < 0 || age > 120) return "Enter your real date of birth.";
  if (age < MINIMUM_AGE) return `You must be ${MINIMUM_AGE} or older to use Caller Whale.`;
  return "";
}

/** The latest birth date that is old enough today, for the date field's `max`. */
export function latestBirthDate(today: Date = new Date()): string {
  return `${today.getFullYear() - MINIMUM_AGE}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
}
