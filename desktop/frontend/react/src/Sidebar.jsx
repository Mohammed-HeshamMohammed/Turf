import { useLayoutEffect, useRef, useState } from "react";
import {
  ArrowClockwise,
  CalendarBlank,
  ChartBar,
  ChatCircle,
  EnvelopeSimple,
  CheckCircle,
  FileCsv,
  Handshake,
  Phone,
  ShieldCheck,
  SidebarSimple,
  SquaresFour,
  Users,
  UsersThree,
} from "@phosphor-icons/react";
import { ROLES } from "./data.js";
import { navCounts } from "./model.js";
import { useCrm } from "./context.jsx";
import { CountBadge } from "./ui.jsx";

const NAV = [
  { id: "dashboard", label: "Overview", path: "dashboard", icon: SquaresFour, group: "workspace" },
  { id: "leads", label: "Leads", path: "work/leads", icon: Users, group: "workspace" },
  { id: "calls", label: "Calls", path: "work/calls", icon: Phone, group: "workspace" },
  { id: "deals", label: "Deals", path: "work/deals", icon: Handshake, group: "workspace" },
  { id: "handoffs", label: "Handoffs", path: "work/handoffs", icon: ArrowClockwise, group: "workspace" },
  { id: "tasks", label: "Tasks", path: "work/tasks", icon: CheckCircle, group: "workspace" },
  { id: "calendar", label: "Calendar", path: "work/calendar", icon: CalendarBlank, group: "workspace" },
  { id: "inbox", label: "Inbox", path: "work/inbox", icon: ChatCircle, group: "workspace" },
  { id: "mail", label: "Mail", path: "work/mail", icon: EnvelopeSimple, group: "workspace" },
  { id: "lists", label: "Source lists", path: "lists", icon: FileCsv, group: "data" },
  { id: "skip", label: "Skip Tracing", path: "skip", icon: ShieldCheck, group: "data" },
  { id: "team", label: "Team", path: "team", icon: UsersThree, group: "data" },
  { id: "reports", label: "Reports", path: "reports", icon: ChartBar, group: "data" },
];

export function Sidebar({ collapsed, onToggle, mobileOpen, page }) {
  const { state, navigate } = useCrm();
  const ref = useRef(null);
  const wasCollapsed = useRef(collapsed);
  const [hover, setHover] = useState(null);
  const [bend, setBend] = useState(null);
  const [selection, setSelection] = useState(null);
  const role = ROLES[state.role];
  const counts = navCounts(state, role);
  const items = NAV.filter(item => role.pages.includes(item.id));
  // Same sections the top bar shows; the sidebar hides them while the top bar is visible.
  const topIds = ["dashboard", "leads", "calls", "deals", "tasks", "inbox"].filter(id => id === "dashboard" || role.pages.includes(id)).slice(0, 5);
  useLayoutEffect(() => {
    const nav = ref.current.querySelector("nav");
    function measureSelection() {
      const button = nav.querySelector("[aria-current]");
      if (!button) return setSelection(null);
      const rect = button.getBoundingClientRect();
      const bounds = nav.getBoundingClientRect();
      if (!rect.width) return setSelection(null);
      setSelection({
        top: rect.top - bounds.top + nav.scrollTop,
        left: rect.left - bounds.left,
        width: rect.width,
        height: rect.height,
      });
    }
    measureSelection();
    const observer = new ResizeObserver(measureSelection);
    observer.observe(nav);
    // While the rail minimises or expands, the selected pill follows its item frame by frame instead of lagging behind.
    let frame = 0;
    const rail = ref.current;
    if (wasCollapsed.current !== collapsed) {
      wasCollapsed.current = collapsed;
      rail.classList.add("is-resizing");
      const until = performance.now() + 340;
      const follow = () => {
        measureSelection();
        if (performance.now() < until) frame = requestAnimationFrame(follow);
        else rail.classList.remove("is-resizing");
      };
      frame = requestAnimationFrame(follow);
    }
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      rail.classList.remove("is-resizing");
    };
  }, [page, collapsed, state.role, mobileOpen]);
  function clearHover() {
    setHover(null);
    setBend(current => (current ? { ...current, active: false } : current));
  }
  function track(event) {
    let button = event.target.closest("button[data-dock-id]");
    if (!button && event.target.closest("nav") && Number.isFinite(event.clientY)) {
      button = [...ref.current.querySelectorAll("[data-dock-id]")].find(item => {
        const rect = item.getBoundingClientRect();
        return Math.abs(event.clientY - rect.top - rect.height / 2) <= rect.height / 2 + 5;
      });
    }
    if (!button || !ref.current.contains(button)) return clearHover();
    const rect = button.getBoundingClientRect();
    const id = button.dataset.dockId;
    const rail = ref.current.getBoundingClientRect();
    const y = rect.top - rail.top + rect.height / 2;
    const pointerY = Number.isFinite(event.clientY) ? event.clientY - rail.top : y;
    const edge = Math.max(0, Math.min(1, (y - 44) / 36, (rail.height - y - 44) / 36));
    const bendY = Math.max(72, Math.min(rail.height - 72, y));
    // Moving within the same item changes nothing, so skip the re-render.
    setBend(current =>
      current?.active && current.y === bendY ? current : { y: bendY, active: true, entry: current?.active ? current.entry : (current?.entry || 0) + 1 },
    );
    setHover(current =>
      current?.id === id
        ? current
        : {
            id,
            y,
            pointerY,
            edge,
            tooltipY: Math.max(24, Math.min(rail.height - 24, y)),
            label: button.getAttribute("aria-label"),
          },
    );
  }
  function influence(id) {
    // Only the hovered item grows; its neighbours stay put.
    const strength = hover?.id === id ? 1 : 0;
    return { "--dock-scale": 1 + strength * (collapsed ? 0.22 : 0.14) * (0.65 + 0.35 * (hover?.edge || 0)) };
  }
  function dockProps(id, label) {
    return { "data-dock-id": id, "aria-label": label, style: influence(id) };
  }
  return (
    <aside
      id="crm-sidebar"
      aria-label="Workspace navigation"
      ref={ref}
      className={"sidebar " + (collapsed ? "is-minimized " : "") + (mobileOpen ? "mobile-open" : "")}
      onPointerMove={track}
      onPointerLeave={clearHover}
      onFocusCapture={track}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) clearHover();
      }}
      style={{ "--hover-y": (bend?.y || 0) + "px" }}
    >
      <span key={bend?.entry || 0} className={"sidebar-bend" + (bend?.active ? " is-active" : "")} aria-hidden="true" />
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
            clearHover();
            onToggle();
          }}
        >
          <SidebarSimple size={20} weight="light" />
        </button>
      </div>
      <nav aria-label="Workspace pages" onScroll={clearHover}>
        {selection && <span className="sidebar-selection" aria-hidden="true" style={selection} />}
        {["workspace", "data"]
          .filter(group => items.some(item => item.group === group))
          .map(group => (
            <div className="nav-group" key={group}>
              <small>{group === "workspace" ? "YOUR WORKSPACE" : "DATA & INSIGHT"}</small>
              {items
                .filter(item => item.group === group)
                .map(item => {
                  const Icon = item.icon;
                  const count = counts[item.id] || 0;
                  return (
                    <button
                      key={item.id}
                      {...dockProps(item.id, item.label)}
                      className={topIds.includes(item.id) ? "in-top-bar" : undefined}
                      aria-current={page === item.id ? "page" : undefined}
                      onClick={() => {
                        navigate(item.path);
                      }}
                    >
                      <span className="dock-icon">
                        <Icon size={21} weight="light" />
                      </span>
                      <span className="nav-label">{item.label}</span>
                      <CountBadge count={count} label={item.label.toLowerCase() + " needing attention"} />
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
