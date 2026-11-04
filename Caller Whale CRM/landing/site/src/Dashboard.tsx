import { useEffect, useState } from "react";
import type { Auth, Me } from "./auth/auth-client.js";
import { Link } from "./nav.tsx";

type Access = {
  platform_role: string;
  platform_label?: string;
  workspaces: { org_id: string; roles: string[]; business_owner: boolean }[];
};

const staffRoles = new Set(["owner", "cofounder", "system_admin"]);

export function Dashboard({ me, auth, authBase }: { me: Me | null | undefined; auth: Auth; authBase: string }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    if (!me) return;
    const controller = new AbortController();
    setStatus("loading");
    auth.accessToken().then(async token => {
      if (!token) throw new Error("No session");
      const response = await fetch(`${authBase}/v1/me/access`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Membership unavailable");
      return response.json() as Promise<Access>;
    }).then(profile => {
      if (controller.signal.aborted) return;
      setAccess(profile);
      setStatus("ready");
    }).catch(() => {
      if (!controller.signal.aborted) setStatus("unavailable");
    });
    return () => controller.abort();
  }, [me?.id, auth, authBase]);

  if (!me) return <div className="form-wrap"><p className="muted">Loading your dashboard…</p></div>;
  const staff = access && staffRoles.has(access.platform_role);
  return <div className="dashboard-page">
    <header className="page-head">
      <span className="eyebrow">Your Caller Whale account</span>
      <h1>{staff ? "Administrative dashboard" : "Your dashboard"}</h1>
      <p className="lead">Your account, platform role and workspace memberships in one place.</p>
    </header>
    <div className="dashboard-panels">
      <section className="card" aria-labelledby="dashboard-account">
        <h2 id="dashboard-account">Account</h2>
        <p><strong>{me.name || me.email}</strong><br /><span className="muted">{me.email}</span></p>
        <Link to="/account">Your profile →</Link>
      </section>
      <section className="card" aria-labelledby="dashboard-memberships">
        <h2 id="dashboard-memberships">Memberships</h2>
        {status === "loading" && <p role="status">Checking your memberships…</p>}
        {status === "unavailable" && <p role="status">Membership information is unavailable right now. Try again later.</p>}
        {status === "ready" && access?.workspaces.length === 0 && <p>You do not belong to a workspace yet.</p>}
        {status === "ready" && access && access.workspaces.length > 0 && <ul className="membership-list">
          {access.workspaces.map((workspace, index) => <li key={workspace.org_id}>
            <strong>Workspace {index + 1}</strong>
            <span>{workspace.business_owner ? "Business owner" : workspace.roles.join(", ") || "Member"}</span>
          </li>)}
        </ul>}
      </section>
      {status === "ready" && access?.platform_role && <section className="card" aria-labelledby="dashboard-platform">
        <h2 id="dashboard-platform">Platform role</h2>
        <p>{access.platform_label || access.platform_role}</p>
      </section>}
      {staff && <section className="card" aria-labelledby="dashboard-administration">
        <h2 id="dashboard-administration">Administration</h2>
        <p>Your {access.platform_label?.toLowerCase() || "staff"} role is active. Staff management tools are being connected to this dashboard.</p>
      </section>}
    </div>
  </div>;
}
