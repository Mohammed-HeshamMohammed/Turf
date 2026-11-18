import { useEffect, useState } from "react";
import type { Auth, Me } from "./auth/auth-client.js";
import { SettingsConnections } from "./SettingsConnections.tsx";
import { SettingsSecurity } from "./SettingsSecurity.tsx";
import { SettingsPrivacy } from "./SettingsPrivacy.tsx";
import { SettingsAccess } from "./SettingsAccess.tsx";

const TABS = [
  { key: "security", label: "Security" },
  { key: "privacy", label: "Privacy" },
  { key: "access", label: "My access" },
  { key: "connections", label: "Connections" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const fromAddress = (): Tab => {
  const hash = typeof window === "undefined" ? "" : window.location.hash.replace("#", "");
  return TABS.some(tab => tab.key === hash) ? (hash as Tab) : "security";
};

/** Settings: Security (the second step), Privacy (the name tag and who can see and reach the person) and Connections. The profile (name, picture, username) is its own page, at the person's own address. */
export function Settings({ me, auth, authBase, onSaved, embedded = false }: { me: Me; auth: Auth; authBase: string; onSaved: () => void; embedded?: boolean }) {
  const [tab, setTab] = useState<Tab>("security");
  useEffect(() => { if (!embedded) setTab(fromAddress()); }, [embedded]);
  const choose = (next: Tab) => {
    setTab(next);
    if (embedded) return; // inside the dashboard the address already says which page this is
    try { window.history.replaceState(null, "", next === "security" ? window.location.pathname : `#${next}`); } catch { /* the tab still changes */ }
  };
  return (
    <div className="settings">
      <div className="settings-tabs" role="tablist" aria-label="Settings">
        {TABS.map(item => (
          <button key={item.key} type="button" role="tab" id={`tab-${item.key}`} aria-selected={tab === item.key} aria-controls={`panel-${item.key}`} className={tab === item.key ? "is-current" : ""} onClick={() => choose(item.key)}>{item.label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "security" && <SettingsSecurity me={me} auth={auth} onChanged={onSaved} />}
        {tab === "access" && <SettingsAccess auth={auth} authBase={authBase} />}
        {tab === "privacy" && <SettingsPrivacy me={me} auth={auth} authBase={authBase} onSaved={onSaved} />}
        {tab === "connections" && <SettingsConnections auth={auth} authBase={authBase} />}
      </div>
    </div>
  );
}
