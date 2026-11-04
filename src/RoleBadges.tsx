export type Access = {
  platform_role: string;
  platform_label?: string;
  workspaces: { org_id: string; roles: string[]; business_owner: boolean }[];
};

const roleLabel: Record<string, string> = {
  owner: "Platform owner", cofounder: "Cofounder", system_admin: "System admin", tester: "Tester",
  solo: "Solo operator", caller: "Caller", closer: "Closer", manager: "Manager", researcher: "Researcher", client: "Client",
};

export function RoleBadges({ access }: { access: Access }) {
  const labels = [access.platform_label || roleLabel[access.platform_role],
    ...access.workspaces.flatMap(space => space.business_owner ? ["Business owner"] : space.roles.map(role => roleLabel[role] || role))]
    .filter(Boolean);
  return <div className="role-badges" aria-label="Your roles">{(labels.length ? [...new Set(labels)] : ["Account holder"]).map(label => <span className="role-badge" key={label}>{label}</span>)}</div>;
}
