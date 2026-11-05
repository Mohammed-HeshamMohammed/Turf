// The words for every role, in one place. The authorization service owns the real catalog (GET /v1/roles); this is the same list kept
// here so a screen can name a role before the answer arrives and when it cannot be reached. Two groups, never mixed: the word "owner"
// means the platform owner for Caller Whale's own staff, and the agency owner for someone who runs one workspace.

export type RoleEntry = { key: string; name: string };

/** What a person is inside a customer's workspace: the standard roles every workspace starts with (the same seven the CRM has). */
export const WORKSPACE_ROLES: RoleEntry[] = [
  { key: "solo", name: "Solo operator" },
  { key: "researcher", name: "Data researcher" },
  { key: "caller", name: "Caller" },
  { key: "closer", name: "Acquisitions / closer" },
  { key: "manager", name: "Team manager" },
  { key: "owner", name: "Agency owner" },
  { key: "client", name: "Client / partner" },
];

/** What Caller Whale's own staff are, highest first. */
export const PLATFORM_ROLES: RoleEntry[] = [
  { key: "owner", name: "Platform owner" },
  { key: "cofounder", name: "Cofounder" },
  { key: "system_admin", name: "System admin" },
  { key: "tester", name: "Tester" },
];

/** A custom role's key in words: senior_closer is "Senior closer". */
export const prettyRole = (key: string) => key.replace(/_/g, " ").replace(/^./, letter => letter.toUpperCase());

/** Joins lists by key, so a role appears once; a later list's name wins (the server's wording over the built-in one). */
export function mergeRoles(...lists: RoleEntry[][]): RoleEntry[] {
  const byKey = new Map<string, RoleEntry>();
  for (const list of lists) for (const entry of list) byKey.set(entry.key, { key: entry.key, name: entry.name || prettyRole(entry.key) });
  return [...byKey.values()];
}

const nameIn = (list: RoleEntry[], key: string) => list.find(entry => entry.key === key)?.name;

/** The words for a workspace role (a custom one is made from its key). */
export const workspaceRoleName = (key: string, known: RoleEntry[] = WORKSPACE_ROLES) => nameIn(known, key) || nameIn(WORKSPACE_ROLES, key) || prettyRole(key);

/** The words for a platform staff role. */
export const platformRoleName = (key: string) => nameIn(PLATFORM_ROLES, key) || prettyRole(key);
