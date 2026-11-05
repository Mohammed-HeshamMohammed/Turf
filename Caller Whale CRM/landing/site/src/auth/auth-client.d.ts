// Types for auth-client.js, which is a copy of services/auth/clients/auth-client.js kept in step by sync.mjs, so it stays
// plain JavaScript. Only what this site uses is described.
export class AuthError extends Error {
  status: number;
  code: string;
  data: unknown;
  constructor(status: number, code: string, message: string, data?: unknown);
}

/** The signed-in person, as the auth service's /v1/me answers. */
export interface Me {
  id: string;
  email: string;
  name: string;
	phone?: string;
	avatar?: string;
	currency?: string;
	age_confirmed?: boolean;
	mfa_enrolled?: boolean;
	mfa_passed?: boolean;
  mfa?: boolean;
  email_verified?: boolean;
  [key: string]: unknown;
}

export interface Auth {
  signedIn(): boolean;
  accessToken(): Promise<string | null>;
  me(options?: { fresh?: boolean }): Promise<Me>;
  signIn(email: string, password: string, code?: string, kind?: string, humanToken?: string): Promise<unknown>;
  signUp(name: string, email: string, password: string, kind?: string, humanToken?: string, birthDate?: string): Promise<unknown>;
  setBirthDate(birthDate: string): Promise<unknown>;
  signOut(): Promise<void>;
  forgotPassword(email: string): Promise<unknown>;
	setupMfa(): Promise<{ secret: string; otpauth_url: string }>;
	confirmMfa(code: string, label?: string): Promise<{ recovery_codes: string[] }>;
	verifyMfa(code: string): Promise<unknown>;
	startStepUp(): Promise<unknown>;
	sendCode(challenge: string, method: string, device?: string): Promise<unknown>;
	answer(challenge: string, method: string, code?: string): Promise<unknown>;
  providers(): Promise<{ google?: boolean; apple?: boolean }>;
  security(): Promise<{ bot_protection?: { enabled: boolean; site_key: string } }>;
  startProvider(provider: string, target: string, humanToken?: string, action?: string): Promise<unknown>;
  finishProvider(): Promise<unknown>;
}

export function createAuth(options: {
  base: string;
  storage?: Storage;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onChange?: () => void;
}): Auth;
