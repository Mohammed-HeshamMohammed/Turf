import { useEffect, useState } from "react";
import type { Auth, Me } from "./auth/auth-client.js";
import { Profile } from "./Profile.tsx";
import { SettingsConnections } from "./SettingsConnections.tsx";
import { SettingsSecurity } from "./SettingsSecurity.tsx";

const TABS = [
  { key: "profile", label: "Profile" },
  { key: "security", label: "Security" },
  { key: "connections", label: "Connections" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const fromAddress = (): Tab => {
  const hash = typeof window === "undefined" ? "" : window.location.hash.replace("#", "");
  return TABS.some(tab => tab.key === hash) ? (hash as Tab) : "profile";
};

/** The account page: Profile (as before), Security (the second step) and Connections. */
export function Settings({ me, auth, authBase, onSaved }: { me: Me; auth: Auth; authBase: string; onSaved: () => void }) {
  const [tab, setTab] = useState<Tab>("profile");
  useEffect(() => setTab(fromAddress()), []);
  const choose = (next: Tab) => {
    setTab(next);
    try { window.history.replaceState(null, "", next === "profile" ? window.location.pathname : `#${next}`); } catch { /* the tab still changes */ }
  };
  return (
    <div className="settings">
      <div className="settings-tabs" role="tablist" aria-label="Settings">
        {TABS.map(item => (
          <button key={item.key} type="button" role="tab" id={`tab-${item.key}`} aria-selected={tab === item.key} aria-controls={`panel-${item.key}`} className={tab === item.key ? "is-current" : ""} onClick={() => choose(item.key)}>{item.label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "profile" && <Profile me={me} auth={auth} authBase={authBase} onSaved={onSaved} />}
        {tab === "security" && <SettingsSecurity me={me} auth={auth} onChanged={onSaved} />}
        {tab === "connections" && <SettingsConnections auth={auth} authBase={authBase} />}
      </div>
    </div>
  );
}
