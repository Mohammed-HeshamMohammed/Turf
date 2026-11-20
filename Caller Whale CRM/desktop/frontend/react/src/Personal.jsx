import { useEffect, useRef, useState } from "react";
import { Bell, CalendarBlank, CheckCircle, SlidersHorizontal, UserCircle } from "@phosphor-icons/react";
import { ROLES } from "./data.ts";
import { AVATAR_PRESETS, squareAvatar } from "./avatars.ts";
import { EmailChange } from "./EmailChange.jsx";
import { SITE } from "./remote/api.ts";
import { personalProfile } from "./model.ts";
import { START_PAGES } from "./personal-preferences.ts";
import { useCrm } from "./context.jsx";
import { Avatar, Badge, Breadcrumb, Button, Card, Field, PageHeader, usePresence } from "./ui.jsx";

export function PersonalMenu({ onOpen }) {
  const { state, navigate } = useCrm();
  const role = ROLES[state.role];
  const profile = personalProfile(state);
  const [open, setOpen] = useState(false);
  const panel = usePresence(open);
  const root = useRef(null);
  const trigger = useRef(null);
  useEffect(() => {
    if (!open) return;
    const outside = event => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    const escape = event => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const focusOut = event => {
      if (!root.current?.contains(event.relatedTarget)) setOpen(false);
    };
    const element = root.current;
    element.querySelector(".personal-menu-panel button")?.focus();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    element.addEventListener("focusout", focusOut);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      element.removeEventListener("focusout", focusOut);
    };
  }, [open]);
  function go(path) {
    setOpen(false);
    navigate(path);
    trigger.current?.focus();
  }
  return (
    <div className="personal-menu" ref={root}>
      <button
        ref={trigger}
        className="profile-button"
        aria-label="Personal menu"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="personal-menu-panel"
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      >
        <Avatar name={profile.name} avatar={profile.avatar} />
      </button>
      {panel.mounted && (
        <div
          id="personal-menu-panel"
          className={"personal-menu-panel callerwhale-menu-panel" + (panel.leaving ? " leaving" : "")}
          role="dialog"
          aria-label="Personal menu"
        >
          <div className="personal-menu-identity">
            <Avatar name={profile.name} avatar={profile.avatar} />
            <div>
              <strong>{profile.name}</strong>
              <small>{profile.email}</small>
            </div>
          </div>
          <div className="callerwhale-menu-actions">
            <button onClick={() => go("personal/profile")}>
              <UserCircle size={19} />
              <span>My profile</span>
            </button>
            <button onClick={() => go("personal/preferences")}>
              <Bell size={19} />
              <span>Preferences</span>
            </button>
            {role.pages.includes("tasks") && (
              <button onClick={() => go("work/tasks?mine=1")}>
                <CheckCircle size={19} />
                <span>My tasks</span>
              </button>
            )}
            {role.pages.includes("calendar") && (
              <button onClick={() => go("work/calendar")}>
                <CalendarBlank size={19} />
                <span>My calendar</span>
              </button>
            )}
          </div>
          <div className="personal-menu-footer">
            <Badge>{role.name}</Badge>
            <span>{state.remote ? "Signed in" : "Sample account"}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function PersonalPage({ section = "profile" }) {
  const { state, dispatch, notify, navigate, sidebarCollapsed, setSidebarPreference } = useCrm();
  const profile = personalProfile(state);
  const role = ROLES[state.role];
  return (
    <>
      <Breadcrumb items={[{ label: "My account", path: "personal/profile" }, { label: section === "profile" ? "Profile" : "Preferences" }]} />
      <PageHeader title={section === "profile" ? "My profile" : "Preferences"} description="Only you see these." />
      <div className="settings-tabs">
        <button aria-current={section === "profile" ? "page" : undefined} onClick={() => navigate("personal/profile")}>
          <UserCircle size={18} />
          My profile
        </button>
        <button aria-current={section !== "profile" ? "page" : undefined} onClick={() => navigate("personal/preferences")}>
          <SlidersHorizontal size={18} />
          Preferences
        </button>
      </div>
      {section === "profile" ? (
        <div className="two-columns">
          <Card title="Personal details" subtitle={state.remote ? "From your Caller Whale account." : "Your picture, display name and contact email."}>
            {state.remote ? (
              <div className="personal-account-details">
                <div className="personal-profile-identity">
                  <Avatar name={profile.name} avatar={profile.avatar} large />
                  <div><h3>{profile.name}</h3><small>{profile.email}</small></div>
                </div>
                <div className="definition-list">
                  {profile.firstName && <div><small>First name</small><strong>{profile.firstName}</strong></div>}
                  {profile.middleName && <div><small>Middle name</small><strong>{profile.middleName}</strong></div>}
                  {profile.lastName && <div><small>Last name</small><strong>{profile.lastName}</strong></div>}
                  {profile.phone && <div><small>Phone</small><strong>{profile.phone}</strong></div>}
                  {profile.username && <div><small>Username</small><strong>{profile.username}</strong></div>}
                  {profile.currency && <div><small>Account currency</small><strong>{profile.currency}</strong></div>}
                </div>
                <a className="button" href={`${SITE}/account`} target="_blank" rel="noopener noreferrer">Edit account profile</a>
              </div>
            ) : (
              <>
            <div className="avatar-picker">
              <div className="avatar-grid" role="group" aria-label="Choose an avatar">
                <button
                  type="button"
                  aria-label="Default avatar"
                  aria-pressed={!profile.avatar}
                  onClick={() => dispatch({ type: "PERSONAL", profile: { avatar: "" } })}
                >
                  <Avatar name={profile.name} avatar="" />
                </button>
                {AVATAR_PRESETS.map((preset, index) => (
                  <button
                    type="button"
                    key={preset}
                    aria-label={"Avatar " + (index + 1)}
                    aria-pressed={profile.avatar === preset}
                    onClick={() => dispatch({ type: "PERSONAL", profile: { avatar: preset } })}
                  >
                    <Avatar name={"Avatar " + (index + 1)} avatar={preset} />
                  </button>
                ))}
                {profile.avatar?.startsWith("data:") && (
                  <button type="button" aria-label="Your uploaded photo" aria-pressed="true">
                    <Avatar name={profile.name} avatar={profile.avatar} />
                  </button>
                )}
              </div>
              <div className="avatar-actions">
                <label className="button" tabIndex={0}>
                  Upload a photo
                  <input
                    type="file"
                    accept="image/*"
                    onChange={async event => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (!file) return;
                      try {
                        dispatch({ type: "PERSONAL", profile: { avatar: await squareAvatar(file) } });
                        notify("Photo saved on this device");
                      } catch (error) {
                        notify(error.message);
                      }
                    }}
                  />
                </label>
                {profile.avatar && <Button onClick={() => dispatch({ type: "PERSONAL", profile: { avatar: "" } })}>Remove picture</Button>}
              </div>
            </div>
            <form
              key={role.person}
              onSubmit={event => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                dispatch({ type: "PERSONAL", profile: { name: String(form.get("name")).trim() } });
                notify("Personal profile saved on this device");
              }}
            >
              <Field label="Display name">
                <input name="name" defaultValue={profile.name} required maxLength={80} />
              </Field>
              <button className="button primary" type="submit">
                Save name
              </button>
            </form>
            <EmailChange profile={profile} dispatch={dispatch} notify={notify} />
              </>
            )}
          </Card>
          <Card title="Your workspace identity">
            <div className="personal-profile-identity">
              <Avatar name={profile.name} avatar={profile.avatar} large />
              <div>
                <h3>{profile.name}</h3>
                <small>{profile.email}</small>
              </div>
            </div>
            <div className="definition-list">
              <div>
                <small>Role</small>
                <strong>{role.name}</strong>
              </div>
              <div>
                <small>Workspace</small>
                <strong>{state.settings.workspace}</strong>
              </div>
              <div>
                <small>Record access</small>
                <strong>{role.scope}</strong>
              </div>
            </div>
            <p className="body-copy">{state.remote ? "Your account profile is shared with Caller Whale. Workspace access and lead history remain attached to your account." : "Changing your display name keeps existing lead ownership and history intact."}</p>
          </Card>
        </div>
      ) : (
        <div className="preferences-sections">
          <Card title="Notifications" subtitle="Choose what appears under the bell in this CRM.">
            <div className="personal-preferences">
              {[
                ["taskReminders", "Open tasks", "Remind me about my open tasks and callbacks.", "tasks"],
                ["replyReminders", "Unread conversations", "Show unread messages I can access.", "inbox"],
                ["handoffReminders", "Pending handoffs", "Show handoffs waiting in the leads I can access.", "handoffs"],
              ].filter(([, , , page]) => role.pages.includes(page)).map(([key, label, description]) => (
                <label key={key}>
                  <div><strong>{label}</strong><small>{description}</small></div>
                  <input type="checkbox" checked={profile[key]} onChange={event => {
                    dispatch({ type: "PERSONAL", profile: { [key]: event.target.checked } });
                    notify("Preference saved on this device");
                  }} />
                </label>
              ))}
            </div>
            {role.pages.includes("tasks") && (
              <Field label="Tasks shown in the bell" help="The Tasks page still shows every task.">
                <select value={profile.taskNoticeScope} disabled={!profile.taskReminders} onChange={event => dispatch({ type: "PERSONAL", profile: { taskNoticeScope: event.target.value } })}>
                  <option value="all">All open tasks</option>
                  <option value="due">Due today or overdue</option>
                </select>
              </Field>
            )}
            <p className="muted">These settings control in-app notices only. They do not send email or SMS.</p>
          </Card>
          <Card title="Workspace and navigation" subtitle="Choose how the CRM opens on this device.">
            <Field label="Opening page" help="Used when you open the CRM without a page in the link. Bookmarked pages still open directly.">
              <select value={role.pages.includes(profile.startPage) ? profile.startPage : "dashboard"} onChange={event => dispatch({ type: "PERSONAL", profile: { startPage: event.target.value } })}>
                {START_PAGES.filter(page => role.pages.includes(page.id)).map(page => <option key={page.id} value={page.id}>{page.label}</option>)}
              </select>
            </Field>
            <div className="personal-preferences">
              <label>
                <div><strong>Compact sidebar</strong><small>Keep navigation collapsed until you open it.</small></div>
                <input type="checkbox" checked={sidebarCollapsed} onChange={event => setSidebarPreference(event.target.checked)} />
              </label>
            </div>
          </Card>
          <Card title="Display and accessibility" subtitle="Make movement in the CRM more comfortable.">
            <div className="personal-preferences">
              <label>
                <div><strong>Reduce motion</strong><small>Shorten animations and page transitions in the CRM.</small></div>
                <input type="checkbox" checked={profile.reduceMotion} onChange={event => dispatch({ type: "PERSONAL", profile: { reduceMotion: event.target.checked } })} />
              </label>
            </div>
            <p className="muted">Your device’s reduced-motion setting is also respected.</p>
          </Card>
          <p className="muted">Preferences are saved for {profile.name} on this device.</p>
        </div>
      )}
    </>
  );
}
