import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Bell, CalendarBlank, ChatCircle, CheckCircle, HouseLine, List, MagnifyingGlass, WifiSlash, X } from "@phosphor-icons/react";
import { ROLES } from "./data.js";
import { loadState, personalProfile, reducer, visibleLeads, visibleTasks, visibleThreads } from "./model.js";
import { CrmContext } from "./context.jsx";
import { Badge, Button, Empty, Modal, Search } from "./ui.jsx";
import { Dashboard } from "./Dashboard.jsx";
import { LeadDetail, Leads, NewLead } from "./Leads.jsx";
import { Calendar, Calls, Deals, Handoffs, Inbox, Tasks } from "./Work.jsx";
import { Lists, SkipTracing } from "./DataPages.jsx";
import { Reports, Settings, Sync } from "./Management.jsx";
import { Sidebar } from "./Sidebar.jsx";
import { TurfMenu } from "./TurfMenu.jsx";
import { PersonalMenu, PersonalPage } from "./Personal.jsx";

const readRoute = () => window.location.hash.slice(1).replace(/^\//, "") || "dashboard";

export function App() {
  const [state, dispatch] = useReducer(reducer, undefined, () => loadState(window.localStorage));
  const [route, setRoute] = useState(readRoute);
  const [toast, setToast] = useState("");
  const [query, setQuery] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem("turf.full-crm.sidebar-minimized") === "true";
    } catch {
      return false;
    }
  });
  const [notifications, setNotifications] = useState(false);
  const [reset, setReset] = useState(false);
  const [cacheError, setCacheError] = useState(false);
  const timer = useRef(null);
  const main = useRef(null);
  const role = ROLES[state.role];
  const profile = personalProfile(state);
  const queue = state.queue.filter(item => item.actor === role.person);
  const current = route.split("?")[0];
  const parts = current.split("/");
  const page = parts[0] === "work" ? parts[1] : parts[0];
  const activePrimary = ["leads", "calls", "deals", "handoffs", "tasks", "calendar", "inbox"].includes(page) ? "work" : page;
  const accessible = ["sync", "personal"].includes(page) || role.pages.includes(page);
  const leads = visibleLeads(state);
  const tasks = visibleTasks(state).filter(item => !item.done);
  const taskNotices = profile.taskReminders ? tasks : [];
  const replyNotices = profile.replyReminders && role.pages.includes("inbox") ? visibleThreads(state).filter(thread => thread.unread) : [];
  const noticeCount = taskNotices.length + replyNotices.length;
  const searchResults = query.trim()
    ? leads
        .filter(lead =>
          [lead.name, lead.address, lead.city, ...(state.role === "client" ? [] : [lead.phone, lead.email])]
            .join(" ")
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
        .slice(0, 6)
    : [];
  const notify = useCallback(message => {
    setToast(message);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(""), 4500);
  }, []);
  const navigate = useCallback(path => {
    window.location.hash = "/" + path;
    setQuery("");
    setMobileNav(false);
  }, []);
  useEffect(() => {
    const change = () => {
      setRoute(readRoute());
      setNotifications(false);
      main.current?.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem("turf.full-crm.prototype.v1", JSON.stringify(state));
      setCacheError(false);
    } catch {
      setCacheError(true);
    }
  }, [state]);
  useEffect(() => () => clearTimeout(timer.current), []);
  function toggleSidebar() {
    setSidebarCollapsed(current => {
      const next = !current;
      try {
        window.localStorage.setItem("turf.full-crm.sidebar-minimized", String(next));
      } catch {
        /* This session still supports the preference. */
      }
      return next;
    });
  }
  const context = { state, dispatch, navigate, notify, route };
  const primary = [
    { id: "dashboard", label: "Dashboard", target: "dashboard" },
    ...(role.pages.some(item => ["leads", "calls", "deals", "tasks", "inbox"].includes(item))
      ? [{ id: "work", label: "Work", target: state.role === "caller" ? "work/calls" : state.role === "closer" ? "work/deals" : "work/leads" }]
      : []),
    ...(role.pages.includes("lists") ? [{ id: "lists", label: "Lists", target: "lists" }] : []),
    ...(role.pages.includes("skip") ? [{ id: "skip", label: "Skip Tracing", target: "skip" }] : []),
    ...(role.pages.includes("reports") ? [{ id: "reports", label: "Reports", target: "reports" }] : []),
  ];
  function content() {
    if (!accessible)
      return (
        <Empty title="This page is outside your role" action={<Button onClick={() => navigate("dashboard")}>Return to your workspace</Button>}>
          Your role determines the records and actions you can access in this preview.
        </Empty>
      );
    if (page === "dashboard") return <Dashboard />;
    if (page === "leads") return parts[2] === "new" ? <NewLead /> : parts[2] ? <LeadDetail id={parts[2]} /> : <Leads />;
    if (page === "calls") return <Calls target={parts[2]} />;
    if (page === "deals") return <Deals id={parts[2]} />;
    if (page === "handoffs") return <Handoffs />;
    if (page === "tasks") return <Tasks create={parts[2] === "new"} />;
    if (page === "calendar") return <Calendar />;
    if (page === "inbox") return <Inbox />;
    if (page === "lists") return <Lists id={parts[1]} />;
    if (page === "skip") return <SkipTracing />;
    if (page === "reports") return <Reports />;
    if (page === "settings") return <Settings section={parts[1]} />;
    if (page === "sync") return <Sync />;
    if (page === "personal") return <PersonalPage section={parts[1]} />;
    return <Empty title="Choose a workspace page" action={<Button onClick={() => navigate("dashboard")}>Open overview</Button>} />;
  }
  return (
    <CrmContext.Provider value={context}>
      <div className="crm-window">
        <header className="app-header">
          <div className="brand">
            <button className="mobile-menu round-button" aria-label="Toggle navigation" onClick={() => setMobileNav(!mobileNav)}>
              <List size={22} />
            </button>
            <TurfMenu collapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} onReset={() => setReset(true)} onOpen={() => setNotifications(false)} />
            <strong>Turf</strong>
            <div className="header-workspace" title={state.settings.workspace}>
              <HouseLine size={18} weight="light" />
              <div>
                <strong>{state.settings.workspace}</strong>
                <small>{state.role === "client" ? "Partner workspace" : state.role === "solo" ? "Personal workspace" : "Acquisitions workspace"}</small>
              </div>
            </div>
          </div>
          <nav className="top-tabs" aria-label="Main sections">
            {primary.map(item => (
              <button key={item.id} aria-current={activePrimary === item.id ? "page" : undefined} onClick={() => navigate(item.target)}>
                {item.label}
              </button>
            ))}
          </nav>
          <div className="header-tools">
            <div className="global-search">
              <Search value={query} onChange={setQuery} placeholder="Find a person or property" label="Search workspace" />
              {query && (
                <div className="search-results">
                  <small>{role.scope}</small>
                  {searchResults.map(lead => (
                    <button key={lead.id} onClick={() => navigate("work/leads/" + lead.id)}>
                      <MagnifyingGlass size={16} />
                      <div>
                        <strong>{lead.name}</strong>
                        <span>{lead.address}</span>
                      </div>
                    </button>
                  ))}
                  {!searchResults.length && <p>No records match in your view.</p>}
                </div>
              )}
            </div>
            <div className="notification-anchor">
              <button className="round-button" aria-label="Notifications" aria-expanded={notifications} onClick={() => setNotifications(!notifications)}>
                <Bell size={21} />
                {noticeCount > 0 && <span className="notification-count">{noticeCount}</span>}
              </button>
              {notifications && (
                <div className="notification-panel">
                  <header>
                    <strong>Your notifications</strong>
                    <button aria-label="Close notifications" onClick={() => setNotifications(false)}>
                      <X size={16} />
                    </button>
                  </header>
                  {taskNotices.slice(0, 4).map(task => (
                    <button
                      key={task.id}
                      onClick={() => {
                        navigate("work/leads/" + task.leadId);
                        setNotifications(false);
                      }}
                    >
                      <ClockLabel />
                      <div>
                        <strong>{task.title}</strong>
                        <small>
                          {task.time} · {task.date}
                        </small>
                      </div>
                    </button>
                  ))}
                  {replyNotices.slice(0, 2).map(thread => (
                    <button
                      key={thread.id}
                      onClick={() => {
                        navigate("work/inbox?lead=" + thread.leadId);
                        setNotifications(false);
                      }}
                    >
                      <ChatCircle size={19} />
                      <div>
                        <strong>Unread {thread.channel.toLowerCase()} conversation</strong>
                        <small>{thread.preview}</small>
                      </div>
                    </button>
                  ))}
                  {!noticeCount && (
                    <p>{!profile.taskReminders && !profile.replyReminders ? "Your personal notifications are paused." : "You're all caught up."}</p>
                  )}
                </div>
              )}
            </div>
            <PersonalMenu onOpen={() => setNotifications(false)} />
          </div>
        </header>
        <div className={"workspace-body " + (sidebarCollapsed ? "sidebar-minimized" : "")}>
          <Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} mobileOpen={mobileNav} page={page} />
          {mobileNav && <button className="nav-backdrop" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
          <main className="main-content" ref={main} id="main-content">
            <div className="content-topline">
              <span>
                <span className="status-dot" />
                Florida acquisitions · October 2026
              </span>
              <div>
                <Badge>Sample data</Badge>
                <button className="text-button muted" onClick={() => setReset(true)}>
                  Reset preview
                </button>
              </div>
            </div>
            {cacheError && (
              <p className="notice" role="alert">
                Browser storage is full or unavailable. Current edits work in this session but cannot survive a refresh.
              </p>
            )}
            {!state.online && (
              <div className="offline-banner">
                <WifiSlash size={18} />
                <span>You're viewing cached records. CRM edits will queue; local Skip Tracing stays available.</span>
              </div>
            )}
            <div key={current + ":" + state.role} className="page-content">
              {content()}
            </div>
          </main>
        </div>
        <footer className="app-footer">
          <span>
            Turf · Full CRM mode <span className="footer-divider">/</span> Interactive UI prototype
          </span>
          <span className="footer-status">
            <span className={"status-dot " + (!state.online ? "amber" : "")} />
            {state.online
              ? queue.length
                ? queue.length + " items awaiting sync"
                : "All changes saved locally"
              : "Offline · " + queue.length + " pending items"}
          </span>
          <span>Sample workspace · no live outreach</span>
        </footer>
        {toast && (
          <div className="toast" role="status">
            <CheckCircle size={20} />
            <span>{toast}</span>
            <button aria-label="Dismiss notification" onClick={() => setToast("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {reset && (
          <Modal title="Start fresh with the sample workspace?" onClose={() => setReset(false)}>
            <p className="body-copy">
              This clears this prototype's saved edits, imported preview rows, drafts, and pending changes. The main Turf application is not affected.
            </p>
            <div className="row">
              <Button onClick={() => setReset(false)}>Keep my preview</Button>
              <Button
                variant="primary"
                onClick={() => {
                  dispatch({ type: "RESET" });
                  setReset(false);
                  navigate("dashboard");
                  notify("Sample workspace restored");
                }}
              >
                Reset sample workspace
              </Button>
            </div>
          </Modal>
        )}
      </div>
    </CrmContext.Provider>
  );
}
function ClockLabel() {
  return <CalendarBlank size={19} />;
}
