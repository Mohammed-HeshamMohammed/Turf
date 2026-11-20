// The web cache keeps one agency in memory (build step 5). Switching to another drops the first one's records, but not the changes the
// person made there and could not send yet: those wait here, per agency, for the life of the tab, and go out when the person comes
// back to that agency. Nothing is written to the browser's storage (D194, D287).

const held = new Map<string, any[]>();

/** Keeps an agency's unsent changes while another agency is open. */
export function holdWork(organizationId: string, ops: any[]) {
  const waiting = ops.filter(op => op.status === "Pending" || op.status === "Conflict" || op.status === "Rejected");
  if (waiting.length) held.set(organizationId, waiting.map(op => ({ ...op })));
  else held.delete(organizationId);
}

/** Takes back an agency's waiting changes as it opens again. */
export function takeWork(organizationId: string): any[] {
  const ops = held.get(organizationId) || [];
  held.delete(organizationId);
  return ops;
}

/** Drops an agency's waiting changes: the person lost access to it, so the server would refuse them. */
export function dropWork(organizationId: string) {
  held.delete(organizationId);
}

/** How many changes wait in agencies that are not open, for the warning before the tab closes. */
export function heldCount(): number {
  let count = 0;
  for (const ops of held.values()) count += ops.filter(op => op.status === "Pending").length;
  return count;
}

/**
 * The person is in the middle of something the refresh must not pull out from under them: typing in a field, a dialog open, or a call
 * on. Checked by the sync engine before a quiet refresh or a full re-read.
 */
export function screenBusy(doc: Document | undefined = typeof document === "undefined" ? undefined : document, callOn = false): boolean {
  if (callOn) return true;
  if (!doc) return false;
  const focused = doc.activeElement as Element | null;
  if (focused?.closest?.("input:not([type='checkbox']):not([type='radio']):not([type='button']), textarea, select, [contenteditable='true']")) return true;
  return Boolean(doc.querySelector("dialog[open], [role='dialog'][aria-modal='true']"));
}
