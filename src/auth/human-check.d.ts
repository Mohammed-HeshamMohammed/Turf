import type { Auth } from "./auth-client.js";

// Types for human-check.jsx, a copy of services/auth/clients/human-check.jsx kept in step by sync.mjs.

/** A new reCAPTCHA token for one request, asked for when it is sent (a token works once). Empty when the check is off. */
export function humanToken(getAuth: () => Promise<Auth>, action: string): Promise<string>;

/** Loads Google's script when the check is on and shows its notice, or why the check cannot run. */
export function HumanCheck(props: {
  getAuth: () => Promise<Auth>;
  /** Show Google's notice inside the check (the default); false when the page shows <HumanNotice /> elsewhere. */
  notice?: boolean;
  onEnabled?: (enabled: boolean) => void;
}): import("react").JSX.Element | null;

export function HumanNotice(): import("react").JSX.Element;
