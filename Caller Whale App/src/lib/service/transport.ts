type Envelope<T> = { schema_version: 1; ok: true; result: T } | { schema_version: 1; ok: false; error: { code: string; message: string } };

export class ServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const inDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function invokeHost<T>(command: string, args?: Record<string, unknown>) {
  return (await import("@tauri-apps/api/core")).invoke<T>(command, args);
}

function unwrap<T>(response: unknown): T {
  const envelope = response as Envelope<T> | undefined;
  if (!envelope || envelope.schema_version !== 1 || typeof envelope.ok !== "boolean") throw new ServiceError("invalid_response", "Caller Whale's service returned an unexpected response");
  if (!envelope.ok) {
    // The screens are newer than the service they are talking to. Say what to do, not the command's name.
    const message = envelope.error.code === "unknown_command" ? "Caller Whale's service is older than its screens. Close Caller Whale and open it again." : envelope.error.message;
    throw new ServiceError(envelope.error.code, message);
  }
  return envelope.result;
}

export async function call<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (inDesktop) {
    try {
      return unwrap<T>(await invokeHost("service_call", { command, payload }));
    } catch (reason) {
      // The host rejects with a plain string when the service cannot be started or reached.
      throw reason instanceof Error ? reason : new ServiceError("bridge_unavailable", String(reason));
    }
  }
  // The dev server forwards this to the service one request at a time (vite.config.ts).
  const turn = fetch("/rpc", { signal: AbortSignal.timeout(120_000), method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schema_version: 1, command, payload }) });
  let response: Response;
  try {
    response = await turn;
  } catch {
    throw new ServiceError("bridge_unavailable", "Caller Whale's service is not answering. Start Caller Whale with `npm run dev` or `npm run desktop`.");
  }
  if (!response.ok) throw new ServiceError("bridge_unavailable", "Caller Whale's service is not answering. It needs Python 3.11+ with service/requirements.txt installed.");
  return unwrap<T>(await response.json());
}
