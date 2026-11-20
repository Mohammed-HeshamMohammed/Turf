import type { DatasetRow } from "../types";
import { call } from "./transport";

// A long list (more than LARGE rows) is counted, filtered and paged by the service; the window holds one page.

export const LARGE = 50_000;

export type ReachPayload = { phone_columns: string[]; email_columns: string[]; mail_columns: string[]; status_column: string | null; status_kinds: Record<string, string> };
export type AreaPayload = { state?: string; city?: string; zip?: string };
export type ListSummary = {
  count: number;
  columns: string[];
  checked: boolean;
  verdicts: Record<"corroborated" | "unverified" | "suspicious" | "wrong", number>;
  callable: number;
  flags: Record<"callable" | "wrong" | "dnc" | "manual" | "repeat" | "once" | "possible", number>;
  blocked_numbers: number;
  reach: Record<string, number>;
  coverage: { phone: number; severalPhones: number; email: number; neither: number };
  zipless: number;
  areas: Partial<Record<"state" | "city" | "zip", { name: string; count: number }[]>>;
  places: { zip: string; city: string; state: string; count: number }[];
};
export type PageFilter = { verdict?: string; flag?: string; column?: string; contains?: string; query?: string; level?: string | null; area?: string | null };

export const listSummary = (dataset_id: string, areas: AreaPayload, reach: ReachPayload) => call<ListSummary>("views.summary", { dataset_id, areas, reach });
export const listPage = (dataset_id: string, areas: AreaPayload, reach: ReachPayload, filter: PageFilter, offset: number, limit: number) =>
  call<{ total: number; rows: DatasetRow[] }>("views.page", { dataset_id, areas, reach, filter, offset, limit });
