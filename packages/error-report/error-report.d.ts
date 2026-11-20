// Types for error-report.js (@callerwhale/error-report).
export type Report = { app: string; kind: string; page: string; where: string[]; version: string };
export function framesOf(stack: string | undefined): string[];
export function reportFor(error: unknown, pathname: string, app: string, version: string): Report;
export function installErrorReports(endpoint: string, app: string, version: string): void;
