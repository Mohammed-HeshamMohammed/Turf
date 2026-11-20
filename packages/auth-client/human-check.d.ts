import type { Auth } from "./auth-client.js";

// Types for human-check.jsx (@callerwhale/auth-client/human-check.jsx).

/**
 * The reCAPTCHA token for one request, taken when it is sent (a token works once): a new invisible one, or the ticked
 * "I'm not a robot" box's (which is then cleared). Throws a readable error when the box is not ticked. Empty when the check is off.
 */
export function humanToken(getAuth: () => Promise<Auth>, action: string): Promise<string>;

/** Draws the "I'm not a robot" box (checkbox kind) or loads the invisible check and its notice; shows why when it cannot run. */
export function HumanCheck(props: {
  getAuth: () => Promise<Auth>;
  /** Show Google's notice inside the check (the default); false when the page shows <HumanNotice /> elsewhere. */
  notice?: boolean;
  /** true when the page must show <HumanNotice /> itself (the invisible kind, with notice={false}). */
  onEnabled?: (needsNotice: boolean) => void;
}): import("react").JSX.Element | null;

export function HumanNotice(): import("react").JSX.Element;
