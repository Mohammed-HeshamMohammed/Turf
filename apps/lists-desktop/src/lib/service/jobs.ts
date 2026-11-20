import { call, ServiceError } from "./transport";

export type JobWatch = { onStart?: (jobId: string) => void; onEvent?: (payload: Record<string, unknown>) => void };

export type Job<R = Record<string, unknown>> = { id: string; kind: string; state: string; result: R | null; error: string | null };

const FINISHED = ["completed", "failed", "cancelled"];

/**
 * Starts a long-running command and waits for its job, as the service reports it. `onEvent` gets each progress
 * event the job writes; `onStart` gets the job's id, which is what cancelling needs.
 */
export async function runJob<R>(command: string, payload: Record<string, unknown>, watch: JobWatch = {}): Promise<R> {
  const { job_id } = await call<{ job_id: string }>(command, payload);
  return watchJob<R>(job_id, watch);
}

export async function watchJob<R>(job_id: string, watch: JobWatch = {}): Promise<R> {
  watch.onStart?.(job_id);
  let seen = 0;
  for (;;) {
    const job = await call<Job<R> & { events?: { id: number; payload: Record<string, unknown> }[] }>("job.get", { job_id, after_event_id: seen });
    for (const event of job.events ?? []) {
      seen = Math.max(seen, event.id);
      watch.onEvent?.(event.payload);
    }
    if (job.state === "completed" && job.result) return job.result;
    if (FINISHED.includes(job.state)) throw new ServiceError(`job_${job.state}`, job.error ?? `The job was ${job.state}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
