// Who gets a link to the CRM web app (app.callerwhale.com): Caller Whale's own staff, and people who belong to a workspace
// (a membership: a plan, a trial or a free grant, or an invitation they accepted). Everyone else has no CRM. The link is
// a convenience; the CRM server decides who is let in.

export type CrmAccess = { platform_role?: string; workspaces?: unknown[] };

export function hasCrmAccess(access: CrmAccess | null | undefined): boolean {
  if (!access) return false;
  return Boolean(access.platform_role) || (access.workspaces?.length ?? 0) > 0;
}
