import type { Auth } from "./auth-client.js";

// Types for human-check.jsx, a copy of services/auth/clients/human-check.jsx kept in step by sync.mjs.
export function HumanCheck(props: {
  getAuth: () => Promise<Auth>;
  action: string;
  resetKey?: number;
  onToken: (token: string) => void;
}): import("react").JSX.Element | null;
