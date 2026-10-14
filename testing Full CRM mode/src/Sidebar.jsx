import { useRef, useState } from "react";
import {
  ArrowClockwise,
  CalendarBlank,
  ChartBar,
  ChatCircle,
  CheckCircle,
  CloudArrowUp,
  FileCsv,
  GearSix,
  Handshake,
  HouseLine,
  Phone,
  ShieldCheck,
  SidebarSimple,
  SquaresFour,
  Users,
  WifiHigh,
  WifiSlash,
} from "@phosphor-icons/react";
import { ROLES } from "./data.js";
import { visibleLeads, visibleTasks } from "./model.js";
import { useCrm } from "./context.jsx";
import { Badge } from "./ui.jsx";

const NAV = [
  { id: "dashboard", label: "Overview", path: "dashboard", icon: SquaresFour, group: "workspace" },
  { id: "leads", label: "Leads", path: "work/leads", icon: Users, group: "workspace" },
  { id: "calls", label: "Calls", path: "work/calls", icon: Phone, group: "workspace" },
  { id: "deals", label: "Deals", path: "work/deals", icon: Handshake, group: "workspace" },
  { id: "handoffs", label: "Handoffs", path: "work/handoffs", icon: ArrowClockwise, group: "workspace" },
  { id: "tasks", label: "Tasks", path: "work/tasks", icon: CheckCircle, group: "workspace" },
  { id: "calendar", label: "Calendar", path: "work/calendar", icon: CalendarBlank, group: "workspace" },
  { id: "inbox", label: "Inbox", path: "work/inbox", icon: ChatCircle, group: "workspace" },
  { id: "lists", label: "Source lists", path: "lists", icon: FileCsv, group: "data" },
  { id: "skip", label: "Skip Tracing", path: "skip", icon: ShieldCheck, group: "data" },
  { id: "reports", label: "Reports", path: "reports", icon: ChartBar, group: "data" },
];

export function Sidebar({ collapsed, onToggle, mobileOpen, page }) {
  const { state, dispatch, navigate, notify } = useCrm();
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const role = ROLES[state.role];
  const leads = visibleLeads(state);
  const tasks = visibleTasks(state).filter(task => !task.done);
  const queue = state.queue.filter(item => item.actor === role.person);
  const items = NAV.filter(item => role.pages.includes(item.id));
  const dockIds = [...items.map(item => item.id), "connection", "sync", ...(role.pages.includes("settings") ? ["settings"] : [])];
  function track(event) {
    const button = event.target.closest("button[data-dock-id]");
    if (!button || !ref.current.contains(button)) return setHover(null);
    const rect = button.getBoundingClientRect();
    const id = button.dataset.dockId;
    const y = rect.top - ref.current.getBoundingClientRect().top + rect.height / 2;
    setHover(current => (current?.id === id && Math.abs(current.y - y) < 1 ? current : { id, y, label: button.getAttribute("aria-label") }));
  }
  function influence(id) {
    const distance = hover ? Math.abs(dockIds.indexOf(id) - dockIds.indexOf(hover.id)) : Infinity;
    const strength = Math.exp((-distance * distance) / 1.4);
    return { "--dock-scale": 1 + strength * 0.32, "--dock-shift": strength * 4 + "px" };
  }
  function dockProps(id, label) {
    return { "data-dock-id": id, "aria-label": label, style: influence(id) };
  }
  return (
    <aside
      id="crm-sidebar"
      ref={ref}
      className={"sidebar " + (collapsed ? "is-minimized " : "") + (mobileOpen ? "mobile-open" : "")}
      onPointerMove={track}
      onPointerLeave={() => setHover(null)}
      onFocusCapture={track}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHover(null);
      }}
      style={{ "--hover-y": (hover?.y || 0) + "px", "--bend-opacity": hover ? 1 : 0 }}
    >
      <span className="sidebar-bend" aria-hidden="true" />
      <div className="sidebar-heading">
        <div className="workspace-label">
          <span className="workspace-symbol">
            <HouseLine size={22} weight="light" />
          </span>
          <div>
            <strong>{state.settings.workspace}</strong>
            <small>{state.role === "client" ? "Partner workspace" : state.role === "solo" ? "Personal workspace" : "Acquisitions workspace"}</small>
          </div>
        </div>
        <button
          className="sidebar-toggle"
          aria-controls="crm-sidebar"
          aria-label={collapsed ? "Expand sidebar" : "Minimize sidebar"}
          title={collapsed ? "Expand sidebar" : "Minimize sidebar"}
          aria-expanded={!collapsed}
          onClick={() => {
            setHover(null);
            onToggle();
          }}
        >
          <SidebarSimple size={20} weight="light" />
        </button>
      </div>
      <div className="scope-label">
        <ShieldCheck size={14} />
        {role.scope}
      </div>
      <nav aria-label="Workspace pages" onScroll={() => setHover(null)}>
        {["workspace", "data"]
          .filter(group => items.some(item => item.group === group))
          .map(group => (
            <div className="nav-group" key={group}>
              <small>{group === "workspace" ? "YOUR WORKSPACE" : "DATA & INSIGHT"}</small>
              {items
                .filter(item => item.group === group)
                .map(item => {
                  const Icon = item.icon;
                  const count =
                    item.id === "handoffs"
                      ? state.handoffs.filter(h => h.status === "Requested" && leads.some(lead => lead.id === h.leadId)).length
                      : item.id === "tasks"
                        ? tasks.length
                        : null;
                  return (
                    <button
                      key={item.id}
                      {...dockProps(item.id, item.label)}
                      aria-current={page === item.id ? "page" : undefined}
                      onClick={() => {
                        setHover(null);
                        navigate(item.path);
                      }}
                    >
                      <span className="dock-icon">
                        <Icon size={21} weight="light" />
                      </span>
                      <span className="nav-label">{item.label}</span>
                      {count > 0 && <Badge>{count}</Badge>}
                    </button>
                  );
                })}
            </div>
          ))}
      </nav>
      <div className="sidebar-bottom">
        <button
          {...dockProps("connection", state.online ? "Connected preview — try offline mode" : "Offline preview — reconnect")}
          className={"connection-button " + (!state.online ? "offline" : "")}
          onClick={() => {
            dispatch({ type: "CONNECT", online: !state.online });
            notify(state.online ? "Offline preview enabled. Edits will queue on this device." : "Connection restored. Review and sync pending changes.");
          }}
        >
          <span className="connection-icon dock-icon">{state.online ? <WifiHigh size={21} /> : <WifiSlash size={21} />}</span>
          <div className="nav-label">
            <strong>{state.online ? "Connected preview" : "Offline preview"}</strong>
            <small>{state.online ? "Click to try offline mode" : "Your edits stay on this device"}</small>
          </div>
        </button>
        <button
          {...dockProps("sync", "Sync & pending changes")}
          className="sidebar-link"
          onClick={() => navigate("sync")}
          aria-current={page === "sync" ? "page" : undefined}
        >
          <span className="dock-icon">
            <CloudArrowUp size={21} />
          </span>
          <span className="nav-label">Sync & pending changes</span>
          {queue.length > 0 && <Badge tone="peach">{queue.length}</Badge>}
        </button>
        {role.pages.includes("settings") && (
          <button
            {...dockProps("settings", "Workspace settings")}
            className="sidebar-link"
            onClick={() => navigate("settings")}
            aria-current={page === "settings" ? "page" : undefined}
          >
            <span className="dock-icon">
              <GearSix size={21} />
            </span>
            <span className="nav-label">Workspace settings</span>
          </button>
        )}
      </div>
      {hover && collapsed && (
        <div className="dock-tooltip" role="tooltip" style={{ top: hover.y }}>
          <strong>{hover.label}</strong>
        </div>
      )}
    </aside>
  );
}
