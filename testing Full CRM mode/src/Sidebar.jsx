import { useRef, useState } from "react";
import {
  ArrowClockwise,
  CalendarBlank,
  ChartBar,
  ChatCircle,
  CheckCircle,
  FileCsv,
  Handshake,
  Phone,
  ShieldCheck,
  SidebarSimple,
  SquaresFour,
  Users,
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
  const { state, navigate } = useCrm();
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const role = ROLES[state.role];
  const leads = visibleLeads(state);
  const tasks = visibleTasks(state).filter(task => !task.done);
  const items = NAV.filter(item => role.pages.includes(item.id));
  function track(event) {
    const button = event.target.closest("button[data-dock-id]");
    if (!button || !ref.current.contains(button)) return setHover(null);
    const rect = button.getBoundingClientRect();
    const id = button.dataset.dockId;
    const rail = ref.current.getBoundingClientRect();
    const y = rect.top - rail.top + rect.height / 2;
    const pointerY = Number.isFinite(event.clientY) ? event.clientY - rail.top : y;
    const edge = Math.max(0, Math.min(1, (y - 44) / 36, (rail.height - y - 44) / 36));
    const centers = Object.fromEntries(
      [...ref.current.querySelectorAll("[data-dock-id]")].map(item => {
        const bounds = item.getBoundingClientRect();
        return [item.dataset.dockId, bounds.top - rail.top + bounds.height / 2];
      }),
    );
    setHover(current =>
      current?.id === id && Math.abs(current.pointerY - pointerY) < 2
        ? current
        : {
            id,
            y,
            pointerY,
            edge,
            centers,
            bendY: Math.max(72, Math.min(rail.height - 72, y)),
            tooltipY: Math.max(24, Math.min(rail.height - 24, y)),
            label: button.getAttribute("aria-label"),
          },
    );
  }
  function influence(id) {
    const distance = hover ? Math.abs(hover.centers[id] - hover.pointerY) : Infinity;
    const strength = Math.exp(-Math.pow(distance / 38, 2));
    return { "--dock-scale": 1 + strength * (collapsed ? 0.22 : 0.14) * (0.65 + 0.35 * (hover?.edge || 0)) };
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
      style={{ "--hover-y": (hover?.bendY || 0) + "px", "--bend-opacity": hover ? 1 : 0 }}
    >
      <span className="sidebar-bend" aria-hidden="true" />
      <div className="sidebar-heading">
        <div className="scope-label">
          <ShieldCheck size={14} />
          {role.scope}
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
      {hover && collapsed && (
        <div className="dock-tooltip" role="tooltip" style={{ top: hover.tooltipY }}>
          <strong>{hover.label}</strong>
        </div>
      )}
    </aside>
  );
}
