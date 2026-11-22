// Types for calendar.jsx, this app's own copy of packages/calendar (no longer synced).
import type { JSX } from "react";

export interface DateRange {
  from?: Date;
  to?: Date;
}
export interface CalendarEvent {
  date: Date | string;
  label?: string;
}
type DayLike = Date | string;

interface CalendarShared {
  month?: Date;
  defaultMonth?: Date;
  onMonthChange?: (month: Date) => void;
  /** 0 = Sunday (the default), 1 = Monday. */
  weekStartsOn?: 0 | 1;
  /** true for a day that cannot be chosen. */
  disabled?: (date: Date) => boolean;
  /** The earliest and latest days that can be chosen ("YYYY-MM-DD" or a Date). */
  min?: DayLike;
  max?: DayLike;
  /** Days that are taken: struck through and not choosable. */
  bookedDates?: DayLike[];
  /** Days with something on them: a dot under the number. */
  events?: CalendarEvent[];
  /** Press the month or the year in the header to jump to one. Default true. */
  quickNav?: boolean;
  /** The day shown as today (default: the computer's today). */
  today?: DayLike;
  /** What shows first: the days (default) or the years, e.g. for a date of birth. */
  initialView?: "days" | "years";
  /** Put the keyboard focus on the calendar's day when it appears. */
  autoFocus?: boolean;
  className?: string;
  "aria-label"?: string;
}
export type CalendarProps =
  | (CalendarShared & { mode?: "single"; selected?: Date | null; defaultSelected?: Date; onSelect?: (date: Date | undefined, pressed: Date) => void })
  | (CalendarShared & { mode: "multiple"; selected?: Date[]; defaultSelected?: Date[]; onSelect?: (dates: Date[], pressed: Date) => void })
  | (CalendarShared & { mode: "range"; selected?: DateRange; defaultSelected?: DateRange; onSelect?: (range: DateRange, pressed: Date) => void });

export function Calendar(props: CalendarProps): JSX.Element;

export interface DatePickerChange {
  target: { value: string; name?: string };
  currentTarget: { value: string; name?: string };
}
export interface DatePickerProps {
  /** "YYYY-MM-DD", or "" for none. */
  value?: string;
  defaultValue?: string;
  onChange?: (event: DatePickerChange) => void;
  name?: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  placeholder?: string;
  today?: DayLike;
  weekStartsOn?: 0 | 1;
  /** What the calendar shows first while no day is chosen. */
  initialView?: "days" | "years";
  className?: string;
  /** The field's look, e.g. the app's input class. */
  triggerClassName?: string;
  /** Where the calendar is drawn: the nearest element matching this selector (default "dialog"), else the page. */
  portalHost?: string;
  /** How the chosen day reads in the field. */
  format?: (value: string) => string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}
export function DatePicker(props: DatePickerProps): JSX.Element;

export function isoOf(date: Date): string;
export function parseIso(text: string | null | undefined): Date | null;
