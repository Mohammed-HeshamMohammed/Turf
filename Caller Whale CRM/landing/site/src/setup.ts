// What a new account is asked, in order, before the account pages open: its age (18 or older), agreement to the terms and privacy
// notice, and a few answers about its work. The lists below are exactly what the auth service accepts (services/auth/onboarding.go).

/** The version of the terms and privacy notice people agree to. The auth service holds the same text and refuses an old one. */
export const TERMS_VERSION = "2026-11";

export const WORK_ROLES = [
  { key: "business_owner", label: "Business owner", help: "I sell my own product or service" },
  { key: "lead_buyer", label: "Company that buys leads", help: "We call to buy leads or properties" },
  { key: "call_center", label: "Call center", help: "We make or take calls for other companies" },
  { key: "sales_team", label: "Sales team", help: "An in-house team selling for one company" },
  { key: "solo_caller", label: "Solo caller", help: "I work on my own" },
  { key: "data_provider", label: "Data and skip tracing", help: "I find, clean or sell contact data" },
  { key: "other", label: "Something else", help: "Tell us below" },
] as const;

export const TEAM_SIZES = [
  { key: "just_me", label: "Just me" },
  { key: "2_10", label: "2 to 10" },
  { key: "11_50", label: "11 to 50" },
  { key: "51_plus", label: "51 or more" },
] as const;

export const WORK_USES = [
  { key: "cold_calling", label: "Cold calling" },
  { key: "buying_selling_leads", label: "Buying or selling leads" },
  { key: "managing_deals", label: "Managing deals" },
  { key: "follow_ups", label: "Follow-ups and tasks" },
  { key: "skip_tracing", label: "Skip tracing" },
  { key: "team_reporting", label: "Team reports" },
  { key: "sms_email", label: "Text and email" },
] as const;

export type SetupStep = "age" | "terms" | "work" | null;

/** The next thing this person still has to do, or null when the account is ready. Fields the service did not send count as done. */
export function setupStep(me: { age_confirmed?: boolean; terms_accepted?: boolean; work_profile?: unknown }): SetupStep {
  if (me.age_confirmed === false) return "age";
  if (me.terms_accepted === false) return "terms";
  if (me.work_profile === null) return "work";
  return null;
}
