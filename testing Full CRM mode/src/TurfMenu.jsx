import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, CloudArrowUp, FileCsv, GearSix, SidebarSimple, SquaresFour, WifiHigh, WifiSlash } from "@phosphor-icons/react";
import { ROLES } from "./data.js";
import { useCrm } from "./context.jsx";

export function TurfMenu({ collapsed, onToggleSidebar, onReset }) {
  const { state, dispatch, navigate, notify } = useCrm();
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
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    const element = root.current;
    element.addEventListener("focusout", focusOut);
    element.querySelector(".turf-menu-panel button")?.focus();
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      element.removeEventListener("focusout", focusOut);
    };
  }, [open]);
  function run(action) {
    setOpen(false);
    action();
    trigger.current?.focus();
  }
  const role = ROLES[state.role];
  return (
    <div className="turf-menu" ref={root}>
      <button
        ref={trigger}
        className="brand-mark"
        aria-label="Turf menu"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="turf-menu-panel"
        onClick={() => setOpen(!open)}
      >
        <img src="/favicon.svg" alt="" />
      </button>
      {open && (
        <div id="turf-menu-panel" className="turf-menu-panel" role="dialog" aria-label="Turf workspace menu">
          <div className="turf-menu-workspace">
            <small>Current workspace</small>
            <strong>{state.settings.workspace}</strong>
            <span>
              {role.person} · {role.name}
            </span>
          </div>
          <div className="turf-menu-actions">
            <button onClick={() => run(() => navigate("dashboard"))}>
              <SquaresFour size={19} />
              <span>Workspace overview</span>
            </button>
            {role.pages.includes("lists") && (
              <button onClick={() => run(() => navigate("lists"))}>
                <FileCsv size={19} />
                <span>Source lists & imports</span>
              </button>
            )}
            {role.pages.includes("settings") && (
              <button onClick={() => run(() => navigate("settings"))}>
                <GearSix size={19} />
                <span>Workspace settings</span>
              </button>
            )}
            <button className="desktop-menu-action" onClick={() => run(onToggleSidebar)}>
              <SidebarSimple size={19} />
              <span>{collapsed ? "Expand sidebar" : "Minimize sidebar"}</span>
            </button>
            <button onClick={() => run(() => dispatch({ type: "CONNECT", online: !state.online }))}>
              {state.online ? <WifiSlash size={19} /> : <WifiHigh size={19} />}
              <span>{state.online ? "Try offline mode" : "Reconnect preview"}</span>
            </button>
            <button onClick={() => run(() => navigate("sync"))}>
              <CloudArrowUp size={19} />
              <span>Sync & pending changes</span>
            </button>
          </div>
          <div className="role-switcher">
            <label htmlFor="preview-role">Explore as</label>
            <select
              id="preview-role"
              aria-label="Explore as role"
              value={state.role}
              onChange={event => {
                const selected = event.target.value;
                run(() => {
                  dispatch({ type: "ROLE", role: selected });
                  navigate("dashboard");
                  notify("Now viewing as " + ROLES[selected].name);
                });
                trigger.current?.focus();
              }}
            >
              {Object.entries(ROLES).map(([id, item]) => (
                <option key={id} value={id}>
                  {item.name}
                </option>
              ))}
            </select>
            <small>{role.scope} · UI preview</small>
          </div>
          <div className="turf-menu-actions">
            <button onClick={() => run(onReset)}>
              <ArrowClockwise size={19} />
              <span>Reset sample workspace</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
