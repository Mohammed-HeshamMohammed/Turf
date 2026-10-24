import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Bell, CalendarBlank, ChatCircle, CheckCircle, HouseLine, List, MagnifyingGlass, WifiSlash, X } from "@phosphor-icons/react";
import { ROLES } from "./data.js";
import { loadWorkspace, saveWorkspace } from "./workspace-store.js";
import { setLearnedHeaders } from "./skiptrace-fields.js";
import { capability, loadState, navCounts, personalProfile, reducer, visibleLeads, visibleTasks, visibleThreads } from "./model.js";
import { api, apiBase, setApiBase } from "./remote/api.js";
import { SyncEngine } from "./remote/engine.js";
import { LOCAL_ONLY, remoteReducer, syncAction } from "./remote/session.js";
import { applyIdentity, labelFor, operationFor } from "./remote/translate.js";
import { CrmContext } from "./context.jsx";
import { Button, CountBadge, Empty, Modal, PageTransition, Search, money, useHeld, usePresence } from "./ui.jsx";
import { LiveCaptions } from "./LiveCaptions.jsx";
import { Sidebar } from "./Sidebar.jsx";
import { WindowStrip, windowDrag } from "./WindowStrip.jsx";
import { TurfMenu } from "./TurfMenu.jsx";
import { PersonalMenu, PersonalPage } from "./Personal.jsx";

// Pages load on demand, so the first screen only carries what it shows; the rest are fetched quietly once the app is idle.
const lazyPage = (load, name) => lazy(() => load().then(module => ({ default: module[name] })));
const loadDashboard = () => import("./Dashboard.jsx");
const loadLeads = () => import("./Leads.jsx");
const loadWork = () => import("./Work.jsx");
const loadData = () => import("./DataPages.jsx");
const loadManagement = () => import("./Management.jsx");
const loadTeam = () => import("./Team.jsx");
const Dashboard = lazyPage(loadDashboard, "Dashboard");
const LeadDetail = lazyPage(loadLeads, "LeadDetail");
const Leads = lazyPage(loadLeads, "Leads");
const NewLead = lazyPage(loadLeads, "NewLead");
const Calendar = lazyPage(loadWork, "Calendar");
const Calls = lazyPage(loadWork, "Calls");
const Deals = lazyPage(loadWork, "Deals");
const Handoffs = lazyPage(loadWork, "Handoffs");
const Inbox = lazyPage(loadWork, "Inbox");
const Tasks = lazyPage(loadWork, "Tasks");
const Lists = lazyPage(loadData, "Lists");
const SkipTracing = lazyPage(loadData, "SkipTracing");
const Reports = lazyPage(loadManagement, "Reports");
const Settings = lazyPage(loadManagement, "Settings");
const Sync = lazyPage(loadManagement, "Sync");
const Team = lazyPage(loadTeam, "Team");
const RemoteGate = lazyPage(() => import("./RemoteGate.jsx"), "RemoteGate");
const preloadPages = () => [loadLeads, loadWork, loadData, loadManagement, loadTeam, loadDashboard].forEach(load => load());

// The product (the desktop app, or a build made with VITE_TURF_REQUIRE_SIGN_IN=true) cannot be used without signing in
// to a Turf server. Only the public demo build keeps the sample workspace.
const REQUIRE_SIGN_IN = import.meta.env?.VITE_TURF_REQUIRE_SIGN_IN === "true" || (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window);

const readRoute = () => window.location.hash.slice(1).replace(/^\//, "") || "dashboard";

export function App() {
  const [state, apply] = useReducer(remoteReducer, undefined, () => loadState(window.localStorage));
  // Headers mapped by hand before are used for every list (skiptrace-fields.js). Set during render so the first
  // render of a page already uses them.
  setLearnedHeaders(state.settings?.learnedHeaders);
  // The saved workspace is read from IndexedDB once; nothing is saved (or shown) before that, so it is never overwritten.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let live = true;
    loadWorkspace().then(saved => {
      if (!live) return;
      if (saved) apply({ type: "HYDRATE", state: saved });
      setRestored(true);
    });
    return () => {
      live = false;
    };
  }, []);
  // "local": the sample workspace; "gate": signing in to a server; "remote": connected.
  const [connection, setConnection] = useState(() => (REQUIRE_SIGN_IN || apiBase() ? "gate" : "local"));
  const engine = useRef(null);
  const latest = useRef(state);
  latest.current = state;
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
  // One switch for every note that only exists to explain the demo ("sample photo", "no number is dialled" and so on).
  const [demoNotes, setDemoNotesState] = useState(() => {
    try {
      return window.localStorage.getItem("turf.full-crm.demo-notes") === "on";
    } catch {
      return false;
    }
  });
  const setDemoNotes = useCallback(next => {
    setDemoNotesState(next);
    try {
      window.localStorage.setItem("turf.full-crm.demo-notes", next ? "on" : "off");
    } catch {
      /* Still applies for this session. */
    }
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("demo-quiet", !demoNotes);
  }, [demoNotes]);
  const timer = useRef(null);
  const main = useRef(null);
  useEffect(() => {
    const page = main.current;
    if (!page) return undefined;
    const keepLeft = () => page.scrollLeft && (page.scrollLeft = 0);
    page.addEventListener("scroll", keepLeft, { passive: true });
    return () => page.removeEventListener("scroll", keepLeft);
  });
  const role = ROLES[state.role];
  const profile = personalProfile(state);
  const queue = state.queue.filter(item => item.actor === role.person);
  const current = route.split("?")[0];
  const parts = current.split("/");
  const page = parts[0] === "work" ? parts[1] : parts[0];
  const accessible = ["sync", "personal"].includes(page) || role.pages.includes(page);
  const leads = useMemo(() => visibleLeads(state), [state]);
  const tasks = useMemo(() => visibleTasks(state).filter(item => !item.done), [state]);
  const taskNotices = profile.taskReminders ? tasks : [];
  const replyNotices = useMemo(
    () => (profile.replyReminders && role.pages.includes("inbox") ? visibleThreads(state).filter(thread => thread.unread) : []),
    [state, profile.replyReminders, role],
  );
  const noticeCount = taskNotices.length + replyNotices.length;
  const shownQuery = useHeld(query.trim());
  const searchPanel = usePresence(Boolean(query));
  const notePanel = usePresence(notifications);
  const toastPanel = usePresence(Boolean(toast));
  const shownToast = useHeld(toast);
  const searchResults = useMemo(() => {
    if (!shownQuery) return [];
    const needle = shownQuery.toLowerCase();
    const has = (...parts) => parts.join(" ").toLowerCase().includes(needle);
    const people = leads
      .filter(lead => has(lead.name, lead.address, lead.city, ...(state.role === "client" ? [] : [lead.phone, lead.email])))
      .slice(0, 5)
      .map(lead => ({ key: "lead-" + lead.id, group: "Leads", icon: "lead", title: lead.name, detail: lead.address, path: "work/leads/" + lead.id }));
    const found = [...people];
    if (role.pages.includes("deals") && capability(state, "finance")) {
      const ids = new Set(leads.map(lead => lead.id));
      state.deals
        .filter(deal => ids.has(deal.leadId))
        .forEach(deal => {
          const lead = leads.find(item => item.id === deal.leadId);
          if (has(lead.address, lead.name, deal.stage, "deal"))
            found.push({
              key: "deal-" + deal.id,
              group: "Deals",
              icon: "deal",
              title: lead.address,
              detail: deal.stage + " · " + money(deal.amount),
              path: "work/deals/" + deal.id,
            });
        });
    }
    if (role.pages.includes("tasks"))
      tasks
        .filter(task => has(task.title))
        .slice(0, 3)
        .forEach(task =>
          found.push({
            key: "task-" + task.id,
            group: "Tasks",
            icon: "task",
            title: task.title,
            detail: task.time + " · " + task.date,
            path: "work/leads/" + task.leadId,
          }),
        );
    if (role.pages.includes("lists"))
      state.datasets
        .filter(set => has(set.name))
        .slice(0, 3)
        .forEach(set => found.push({ key: "list-" + set.id, group: "Lists", icon: "list", title: set.name, detail: set.status, path: "lists/" + set.id }));
    const pages = [
      ["dashboard", "Overview", "dashboard"],
      ["leads", "Leads", "work/leads"],
      ["calls", "Calls", "work/calls"],
      ["deals", "Deals", "work/deals"],
      ["handoffs", "Handoffs", "work/handoffs"],
      ["tasks", "Tasks", "work/tasks"],
      ["calendar", "Calendar", "work/calendar"],
      ["inbox", "Inbox", "work/inbox"],
      ["lists", "Source lists", "lists"],
      ["skip", "Skip Tracing", "skip"],
      ["team", "Team", "team"],
      ["reports", "Reports", "reports"],
      ["settings", "Settings", "settings"],
    ];
    pages
      .filter(([id, label]) => role.pages.includes(id) && has(label))
      .slice(0, 3)
      .forEach(([id, label, path]) => found.push({ key: "page-" + id, group: "Go to", icon: "page", title: label, detail: "Open this page", path }));
    return found.slice(0, 10);
  }, [shownQuery, leads, tasks, state, role]);
  // notify("Saved") or notify("Lead archived", { undo: () => ... }): a reversible change offers Undo instead of asking first.
  const notify = useCallback((message, options = {}) => {
    setToast({ message, undo: options.undo || null });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(""), options.undo ? 7000 : 4500);
  }, []);
  // Connected: changes apply on screen at once and queue as operations for the server, which has the last word.
  const dispatch = useCallback(
    action => {
      const sync = engine.current;
      if (!sync) return apply(action);
      if (action.type === "SYNC") return void sync.sync();
      if (action.type === "RESOLVE") return void sync.resolve(action.id, action.discard ? "discard" : "keep");
      if (["CONFLICT", "ROLE", "RESET"].includes(action.type)) return;
      if (action.type === "CONNECT") {
        sync.setOnline(action.online);
        return apply(action);
      }
      if (LOCAL_ONLY.has(action.type)) return apply(action);
      const before = latest.current;
      const operation = operationFor(action, before, sync.store || {});
      if (!operation) return apply(action);
      if (operation.online && !before.online) {
        notify("This change needs a connection. Reconnect and try again.");
        return;
      }
      if (reducer(before, action) === before) return;
      sync.enqueue({ ...operation, action, label: labelFor(operation, before) });
      apply(action);
    },
    [notify],
  );
  const connect = useCallback(async ({ me, vault }) => {
    const role = applyIdentity(me);
    const quiet = promise => promise.catch(() => []);
    const [directory, teams, projects] = await Promise.all([quiet(api.directory()), quiet(api.teams()), quiet(api.projects())]);
    const organization = me.organizations.find(item => item.id === me.organization_id)?.name || "";
    apply({ type: "REMOTE_START", role, remote: { user: me.user, capabilities: me.capabilities, organization, roles: me.roles } });
    const sync = new SyncEngine({ vault, onChange: snapshot => apply(syncAction(snapshot, me.user.name)) });
    engine.current = sync;
    setConnection("remote");
    await sync.start({ directory, teams, projects });
  }, []);
  const signOut = useCallback(async () => {
    engine.current?.stop();
    engine.current = null;
    await api.logout().catch(() => {});
    apply({ type: "REMOTE_END" });
    setConnection("gate");
  }, []);
  const useSample = useCallback(() => {
    engine.current?.stop();
    engine.current = null;
    setApiBase("");
    apply({ type: "REMOTE_END" });
    setConnection("local");
  }, []);
  useEffect(() => {
    if (state.remoteStatus === "signed-out") signOut();
  }, [state.remoteStatus, signOut]);
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
    // Server records are kept only in the encrypted offline copy, never in plain browser storage.
    if (state.remote || !restored) return;
    const save = () => saveWorkspace(state).then(saved => setCacheError(!saved));
    // Serialising the whole workspace is the heaviest thing a click does, so wait for a quiet moment and flush on the way out.
    const timer = setTimeout(save, 350);
    window.addEventListener("pagehide", save);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pagehide", save);
    };
  }, [state, restored]);
  useEffect(() => {
    const idle = window.requestIdleCallback || (callback => setTimeout(callback, 1200));
    const handle = idle(preloadPages);
    return () => (window.cancelIdleCallback || clearTimeout)(handle);
  }, []);
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
  const counts = useMemo(() => navCounts(state, role), [state, role]);
  // The most used sections, also in the top bar. The sidebar keeps the full list.
  const topSections = [
    { id: "dashboard", label: "Overview", path: "dashboard" },
    { id: "leads", label: "Leads", path: "work/leads" },
    { id: "calls", label: "Calls", path: "work/calls" },
    { id: "deals", label: "Deals", path: "work/deals" },
    { id: "tasks", label: "Tasks", path: "work/tasks" },
    { id: "inbox", label: "Inbox", path: "work/inbox" },
  ]
    .filter(item => item.id === "dashboard" || role.pages.includes(item.id))
    .slice(0, 5);
  const showGate = useCallback(() => setConnection("gate"), []);
  // Memoised so typing in search, opening a panel or a toast does not re-render every page.
  const context = useMemo(
    () => ({ state, dispatch, navigate, notify, route, connection, connect: showGate, signOut }),
    [state, dispatch, navigate, notify, route, connection, showGate, signOut],
  );
  const pageElement = useMemo(() => {
    if (!accessible)
      return (
        <Empty title="This page is outside your role" action={<Button onClick={() => navigate("dashboard")}>Return to your workspace</Button>}>
          Your role determines the records and actions you can access in this preview.
        </Empty>
      );
    const parts = current.split("/");
    const section = parts[0] === "work" ? parts[1] : parts[0];
    const last = parts[2];
    switch (section) {
      case "dashboard":
        return <Dashboard />;
      case "leads":
        return last === "new" ? <NewLead /> : last ? <LeadDetail id={last} /> : <Leads />;
      case "calls":
        return <Calls target={last} />;
      case "deals":
        return <Deals id={last} />;
      case "handoffs":
        return <Handoffs />;
      case "tasks":
        return <Tasks create={last === "new"} />;
      case "calendar":
        return <Calendar />;
      case "inbox":
        return <Inbox />;
      case "lists":
        return <Lists id={parts[1]} />;
      case "skip":
        return <SkipTracing />;
      case "reports":
        return <Reports />;
      case "settings":
        return <Settings section={parts[1]} />;
      case "team":
        return <Team />;
      case "sync":
        return <Sync />;
      case "personal":
        return <PersonalPage section={parts[1]} />;
      default:
        return <Empty title="Choose a workspace page" action={<Button onClick={() => navigate("dashboard")}>Open overview</Button>} />;
    }
  }, [accessible, current, navigate]);
  // A moment while the saved workspace is read, so the sample data never flashes in its place.
  if (connection === "local" && !restored) return null;
  if (connection === "gate")
    return (
      <div className="gate-window">
        {/* The desktop window has no system title bar, so the sign-in screen keeps the app's own controls. */}
        <WindowStrip title="Turf" />
        <Suspense fallback={null}>
          <RemoteGate onReady={connect} onLeave={REQUIRE_SIGN_IN ? undefined : useSample} />
        </Suspense>
      </div>
    );
  return (
    <CrmContext.Provider value={context}>
      <div className="crm-window">
        <a className="skip-link" href="#main-content" onClick={event => (event.preventDefault(), main.current?.focus())}>
          Skip to content
        </a>
        <WindowStrip title="Turf · Full CRM mode" />
        <header className="app-header" {...windowDrag}>
          <div className="brand">
            <button className="mobile-menu round-button" aria-label="Toggle navigation" onClick={() => setMobileNav(!mobileNav)}>
              <List size={22} />
            </button>
            <TurfMenu
              collapsed={sidebarCollapsed}
              onToggleSidebar={toggleSidebar}
              onReset={() => setReset(true)}
              onOpen={() => setNotifications(false)}
              demoNotes={demoNotes}
              onDemoNotes={setDemoNotes}
            />
            <strong>Turf</strong>
            <div className="header-workspace" title={state.settings.workspace}>
              <HouseLine size={18} weight="light" />
              <div>
                <strong>{state.settings.workspace}</strong>
                <small>{state.role === "client" ? "Partner workspace" : state.role === "solo" ? "Personal workspace" : "Acquisitions workspace"}</small>
              </div>
            </div>
          </div>
          <nav className="top-nav" aria-label="Main sections">
            {topSections.map(item => (
              <button key={item.id} type="button" aria-current={page === item.id ? "page" : undefined} onClick={() => navigate(item.path)}>
                {item.label}
                <CountBadge count={counts[item.id] || 0} label={item.label.toLowerCase() + " needing attention"} />
              </button>
            ))}
          </nav>
          <div className="header-tools">
            <div className="header-search">
              <div className="global-search">
                <Search value={query} onChange={setQuery} placeholder="Find a person or property" label="Search workspace" />
                {searchPanel.mounted && (
                  <div className={"search-results" + (searchPanel.leaving ? " leaving" : "")}>
                    <small>{role.scope}</small>
                    {searchResults.map((result, index) => (
                      <Fragment key={result.key}>
                        {(index === 0 || searchResults[index - 1].group !== result.group) && <small className="search-group">{result.group}</small>}
                        <button onClick={() => navigate(result.path)}>
                          <MagnifyingGlass size={16} />
                          <div>
                            <strong>{result.title}</strong>
                            <span>{result.detail}</span>
                          </div>
                        </button>
                      </Fragment>
                    ))}
                    {!searchResults.length && <p>No records match in your view.</p>}
                  </div>
                )}
              </div>
            </div>
            <div className="notification-anchor">
              <button className="round-button" aria-label="Notifications" aria-expanded={notifications} onClick={() => setNotifications(!notifications)}>
                <Bell size={21} />
                <CountBadge count={noticeCount} className="on-bell" />
              </button>
              {notePanel.mounted && (
                <div className={"notification-panel" + (notePanel.leaving ? " leaving" : "")}>
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
          <main className="main-content" ref={main} id="main-content" tabIndex={-1}>
            {state.remoteError && state.remoteStatus === "error" && (
              <p className="notice" role="alert">
                {state.remoteError}
              </p>
            )}
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
            <PageTransition key={current + ":" + state.role}>
              <Suspense fallback={null}>{pageElement}</Suspense>
            </PageTransition>
          </main>
        </div>
        <footer className="app-footer">
          <span>{state.settings.workspace}</span>
          <span className="footer-status">
            <span className={"status-dot " + (!state.online ? "amber" : "")} />
            {state.online
              ? queue.length
                ? queue.length + " items awaiting sync"
                : state.remote
                  ? "All changes saved to the server"
                  : "All changes saved locally"
              : "Offline · " + queue.length + " pending items"}
          </span>
          <span>
            {state.remote ? (
              state.remoteStatus === "syncing" ? (
                "Syncing with the server"
              ) : state.remoteStatus === "offline" ? (
                "Server unreachable"
              ) : state.remoteStatus === "error" ? (
                "Sync problem"
              ) : (
                "Connected to the server"
              )
            ) : (
              <>
                Sample workspace<span className="demo-note"> · no live outreach</span>
              </>
            )}
          </span>
        </footer>
        <LiveCaptions />
        {toastPanel.mounted && (
          <div className={"toast" + (toastPanel.leaving ? " leaving" : "")} role="status">
            <CheckCircle size={20} />
            <span>{shownToast?.message ?? shownToast}</span>
            {shownToast?.undo && (
              <button
                type="button"
                className="toast-undo"
                onClick={() => {
                  shownToast.undo();
                  setToast("");
                }}
              >
                Undo
              </button>
            )}
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
