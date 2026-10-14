import { useEffect, useRef, useState } from "react";
import { Bell, CalendarBlank, CheckCircle, SlidersHorizontal, UserCircle } from "@phosphor-icons/react";
import { ROLES } from "./data.js";
import { personalProfile } from "./model.js";
import { useCrm } from "./context.jsx";
import { Avatar, Badge, Breadcrumb, Card, Field, PageHeader } from "./ui.jsx";

export function PersonalMenu({ onOpen }) {
  const { state, navigate } = useCrm();
  const role = ROLES[state.role];
  const profile = personalProfile(state);
  const [open, setOpen] = useState(false);
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
        <Avatar name={profile.name} />
      </button>
      {open && (
        <div id="personal-menu-panel" className="personal-menu-panel turf-menu-panel" role="dialog" aria-label="Personal menu">
          <div className="personal-menu-identity">
            <Avatar name={profile.name} />
            <div>
              <strong>{profile.name}</strong>
              <small>{profile.email}</small>
            </div>
          </div>
          <div className="turf-menu-actions">
            <button onClick={() => go("personal/profile")}>
              <UserCircle size={19} />
              <span>My profile</span>
            </button>
            <button onClick={() => go("personal/preferences")}>
              <Bell size={19} />
              <span>Notification preferences</span>
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
            <span>Sample account</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function PersonalPage({ section = "profile" }) {
  const { state, dispatch, notify, navigate } = useCrm();
  const profile = personalProfile(state);
  const role = ROLES[state.role];
  return (
    <>
      <Breadcrumb items={[{ label: "My account", path: "personal/profile" }, { label: section === "profile" ? "Profile" : "Preferences" }]} />
      <PageHeader
        eyebrow="Your account"
        title={section === "profile" ? "A little about you." : "Make yourself at home."}
        description="Your personal details and preferences stay with your account."
      />
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
          <Card title="Personal details" subtitle="Your display name and contact email.">
            <form
              key={role.person}
              onSubmit={event => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                dispatch({ type: "PERSONAL", profile: { name: String(form.get("name")).trim(), email: String(form.get("email")).trim() } });
                notify("Personal profile saved on this device");
              }}
            >
              <Field label="Display name">
                <input name="name" defaultValue={profile.name} required maxLength={80} />
              </Field>
              <Field label="Email address">
                <input name="email" type="email" defaultValue={profile.email} required />
              </Field>
              <button className="button primary" type="submit">
                Save profile
              </button>
            </form>
          </Card>
          <Card title="Your workspace identity">
            <div className="personal-profile-identity">
              <Avatar name={profile.name} />
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
            <p className="body-copy">Changing your display name keeps existing lead ownership and history intact.</p>
          </Card>
        </div>
      ) : (
        <Card title="Notifications, your way" subtitle="Choose what appears in your personal notification panel.">
          <div className="personal-preferences">
            {[
              ["taskReminders", "Task reminders", "Your next steps and open tasks."],
              ["replyReminders", "Unread conversations", "Unread messages in the conversations you can access."],
            ].map(([key, label, description]) => (
              <label key={key}>
                <div>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </div>
                <input
                  type="checkbox"
                  checked={profile[key]}
                  onChange={event => {
                    dispatch({ type: "PERSONAL", profile: { [key]: event.target.checked } });
                    notify("Personal preference saved");
                  }}
                />
              </label>
            ))}
          </div>
          <p className="muted">Saved for {profile.name}. These preview preferences control in-app notices; they do not send email or SMS.</p>
        </Card>
      )}
    </>
  );
}
