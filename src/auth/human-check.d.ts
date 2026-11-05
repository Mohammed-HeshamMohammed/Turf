import type { Auth } from "./auth-client.js";

// Types for human-check.jsx, a copy of services/auth/clients/human-check.jsx kept in step by sync.mjs.
export function HumanCheck(props: {
  getAuth: () => Promise<Auth>;
  action: string;
  resetKey?: number;
  onToken: (token: string) => void;
  /** Show Google's notice inside the check (the default); false when the page shows <HumanNotice /> elsewhere. */
  notice?: boolean;
  onEnabled?: (enabled: boolean) => void;
}): import("react").JSX.Element | null;

export function HumanNotice(): import("react").JSX.Element;
