import type { Auth } from "./auth-client.js";

// Types for sign-in-flow.js and sign-in-flow.jsx: the steps of signing in, with no screen; each app draws its own.

export type SignInMethod = "totp" | "email" | "telegram" | "push";

export type SignInState = {
  /** "password" until auth asks for a second step; then "second". */
  step: "password" | "second";
  challenge: string;
  /** The ways auth offers for this person. */
  methods: SignInMethod[];
  method: SignInMethod | "";
  /** The code was sent, or the other device was asked. */
  sent: boolean;
  busy: boolean;
  error: string;
  note: string;
};

export type SignInOptions = {
  auth: Auth;
  /** The human check's token for this sign-in ("" when it is off). */
  humanToken?: () => Promise<string>;
  onSignedIn?: () => void;
  /** How an approval request names this device. */
  device?: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  now?: () => number;
  pollMs?: number;
};

export type SignInFlow = {
  getState(): SignInState;
  subscribe(listener: () => void): () => void;
  restore(): boolean;
  signIn(email: string, password: string, options?: { kind?: "browser" | "shared" | "desktop" }): Promise<void>;
  begin(second: { challenge: string; methods: SignInMethod[] }): void;
  choose(method: SignInMethod): void;
  send(): Promise<void>;
  answer(code: string): Promise<void>;
  back(): void;
  stop(): void;
};

export function createSignInFlow(options: SignInOptions): SignInFlow;
export function needsCode(state: SignInState): boolean;
export function useSignInFlow(options: SignInOptions): [SignInState, SignInFlow];
