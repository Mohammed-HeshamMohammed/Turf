import { platformRoleName, workspaceRoleName } from "./roles.ts";
export type Access = {
  platform_role: string;
  platform_label?: string;
  workspaces: { org_id: string; roles: string[]; business_owner: boolean }[];
};


export function RoleBadges({ access }: { access: Access }) {
  const labels = [access.platform_label || (access.platform_role ? platformRoleName(access.platform_role) : ""),
    ...access.workspaces.flatMap(space => space.business_owner ? ["Agency owner"] : space.roles.map(role => workspaceRoleName(role)))]
    .filter(Boolean);
  return <div className="role-badges" aria-label="Your roles">{(labels.length ? [...new Set(labels)] : ["Account holder"]).map(label => <span className="role-badge" key={label}>{label}</span>)}</div>;
}
