import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, CloudArrowUp, FileCsv, GearSix, Plugs, SidebarSimple, SignOut, SquaresFour, WifiHigh, WifiSlash, Info } from "@phosphor-icons/react";
import { ROLES } from "./data.js";
import { personalProfile } from "./model.js";
import { useCrm } from "./context.jsx";
import { Badge, Select, usePresence } from "./ui.jsx";
import { SignInMark } from "./SignInMarks.jsx";

export function TurfMenu({ collapsed, onToggleSidebar, onReset, onOpen, demoNotes, onDemoNotes }) {
  const { state, dispatch, navigate, notify, connect, signOut } = useCrm();
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
  const pending = state.queue.filter(item => item.actor === role.person).length;
  return (
    <div className="turf-menu" ref={root}>
      <button
        ref={trigger}
        className="brand-mark"
        aria-label="Turf menu"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="turf-menu-panel"
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      >
        <img src="/favicon.svg" alt="" />
      </button>
      {panel.mounted && (
        <div id="turf-menu-panel" className={"turf-menu-panel" + (panel.leaving ? " leaving" : "")} role="dialog" aria-label="Turf workspace menu">
          <div className="turf-menu-workspace">
            <small>Current workspace</small>
            <strong>{state.settings.workspace}</strong>
            <span>
              {personalProfile(state).name} · {role.name}
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
            <button className="desktop-menu-action" onClick={() => run(onToggleSidebar)}>
              <SidebarSimple size={19} />
              <span>{collapsed ? "Expand sidebar" : "Minimize sidebar"}</span>
            </button>
          </div>
          <div className="turf-menu-actions turf-menu-tools">
            <button
              className={"menu-connection " + (!state.online ? "offline" : "")}
              onClick={() => run(() => dispatch({ type: "CONNECT", online: !state.online }))}
            >
              {state.online ? <WifiHigh size={19} /> : <WifiSlash size={19} />}
              <div>
                <strong>{state.online ? (state.remote ? "Connected" : "Connected preview") : state.remote ? "Working offline" : "Offline preview"}</strong>
                <small>{state.online ? "Click to work offline" : "Click to reconnect"}</small>
              </div>
            </button>
            <button onClick={() => run(() => navigate("sync"))}>
              <CloudArrowUp size={19} />
              <span>Sync & pending changes</span>
              {pending > 0 && <Badge tone="peach">{pending}</Badge>}
            </button>
            <button
              disabled={!role.pages.includes("settings")}
              title={!role.pages.includes("settings") ? "Workspace settings are outside this role" : undefined}
              onClick={() => run(() => navigate("settings"))}
            >
              <GearSix size={19} />
              <span>Workspace settings</span>
            </button>
          </div>
          {state.remote ? (
            <div className="turf-menu-actions">
              <div className="turf-menu-workspace">
                <small>Signed in</small>
                <strong className="named">
                  <SignInMark method={state.remote.user.sign_in} />
                  {state.remote.user.name}
                </strong>
                <span>{state.remote.user.email}</span>
              </div>
              <button onClick={() => run(signOut)}>
                <SignOut size={19} />
                <span>Sign out</span>
              </button>
            </div>
          ) : (
            <>
              <div className="turf-menu-demo-head">
                <small>Sample workspace</small>
              </div>
              <div className="role-switcher">
                <label htmlFor="preview-role">Explore as</label>
                <Select
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
                </Select>
                <small>{role.scope} · UI preview</small>
              </div>
              <div className="turf-menu-actions">
                <button type="button" className="menu-switch" role="switch" aria-checked={Boolean(demoNotes)} onClick={() => onDemoNotes(!demoNotes)}>
                  <Info size={19} />
                  <span>Show demo notes</span>
                  <i className="mini-switch" aria-hidden="true" />
                </button>
                <button onClick={() => run(onReset)}>
                  <ArrowClockwise size={19} />
                  <span>Reset sample workspace</span>
                </button>
                <button onClick={() => run(connect)}>
                  <Plugs size={19} />
                  <span>Connect to a Turf server</span>
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
