import { flushSync } from "react-dom";
import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Bell, CalendarBlank, ChatCircle, CheckCircle, HouseLine, List, MagnifyingGlass, WifiSlash, X } from "@phosphor-icons/react";
import { ROLES } from "./data.ts";
import { loadPersonalPreferences, savePersonalPreferences, START_PAGES } from "./personal-preferences.ts";
import { loadWorkspace, saveWorkspace } from "./workspace-store.ts";
import { setLearnedHeaders } from "./skiptrace-fields.ts";
import { capability, conversationPath, loadState, navCounts, personalProfile, reducer, visibleLeads, visibleTasks, visibleThreads } from "./model.ts";
import { api, apiBase, auth, setApiBase, setOrganization } from "./remote/api.ts";
import { SyncEngine } from "./remote/engine.ts";
import { Messaging, messagingBase } from "./remote/messaging.ts";
import { Vault } from "./remote/vault.ts";
import { LOCAL_ONLY, remoteReducer, syncAction } from "./remote/session.ts";
import { applyIdentity, labelFor, operationFor } from "./remote/translate.ts";
import { importPath, importStatusMessage, needsImportAction } from "./remote/source-list-imports.js";
import { saveWorkspaceChoice } from "./remote/workspace-choice.ts";
import { CrmContext } from "./context.jsx";
import { Button, CountBadge, Empty, Modal, PageTransition, Search, money, useHeld, usePresence } from "./ui.jsx";
import { LiveCaptions } from "./LiveCaptions.jsx";
import { PhoneDialer } from "./PhoneDialer.jsx";
import { getCallSession, subscribeCallLog } from "./callSession.ts";
import { Sidebar } from "./Sidebar.jsx";
import { WindowStrip, windowDrag } from "./WindowStrip.jsx";
import { CallerWhaleMenu } from "./CallerWhaleMenu.jsx";
import { PersonalMenu, PersonalPage } from "./Personal.jsx";
import { PageSkeleton } from "./Skeleton.jsx";

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
const Mail = lazyPage(loadWork, "Mail");
const Tasks = lazyPage(loadWork, "Tasks");
const Lists = lazyPage(loadData, "Lists");
const SkipTracing = lazyPage(loadData, "SkipTracing");
const Reports = lazyPage(loadManagement, "Reports");
const Settings = lazyPage(loadManagement, "Settings");
const Sync = lazyPage(loadManagement, "Sync");
const Team = lazyPage(loadTeam, "Team");
const RemoteGate = lazyPage(() => import("./RemoteGate.jsx"), "RemoteGate");
const Approvals = lazyPage(() => import("./SecondStep.jsx"), "Approvals");
const preloadPages = () => [loadLeads, loadWork, loadData, loadManagement, loadTeam, loadDashboard].forEach(load => load());

// The product (the desktop app, or a build made with VITE_CALLERWHALE_REQUIRE_SIGN_IN=true) cannot be used without signing in
// to a Caller Whale server. Only the public demo build keeps the sample workspace. Developers can run the desktop app on the
// sample workspace with VITE_CALLERWHALE_SAMPLE=true (npm run desktop:sample).
const REQUIRE_SIGN_IN =
  import.meta.env?.VITE_CALLERWHALE_SAMPLE !== "true" &&
  (import.meta.env?.VITE_CALLERWHALE_REQUIRE_SIGN_IN === "true" || (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window));

// The page lives in the app, never in the address bar: a route in the URL from an old link is read once and removed.
const openedWithRoute = typeof window !== "undefined" && window.location.hash.length > 1 && !window.location.hash.startsWith("#/captions-window");
const readRoute = () => (openedWithRoute ? window.location.hash.slice(1).replace(/^\//, "") : "") || "dashboard";

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
  useEffect(() => {
    if (connection !== "remote") return;
    const refreshProfile = async () => {
      try {
        const profile = await auth.me({ fresh: true });
        if (profile.id === latest.current.remote?.user.id) apply({ type: "REMOTE_PROFILE", profile });
      } catch {
        // Keep the profile already shown until auth can be reached again.
      }
    };
    const onVisible = () => { if (document.visibilityState === "visible") void refreshProfile(); };
    void refreshProfile();
    window.addEventListener("focus", refreshProfile);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refreshProfile);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [connection]);
  const [route, setRoute] = useState(readRoute);
  const routeRef = useRef(route);
  const [toast, setToast] = useState("");
  const [query, setQuery] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem("callerwhale.full-crm.sidebar-minimized") === "true";
    } catch {
      return false;
    }
  });
  const [notifications, setNotifications] = useState(false);
  const [importJobs, setImportJobs] = useState([]);
  const importSeen = useRef(null);
  const [reset, setReset] = useState(false);
  const [cacheError, setCacheError] = useState(false);
  // One switch for every note that only exists to explain the demo ("sample photo", "no number is dialled" and so on).
  const [demoNotes, setDemoNotesState] = useState(() => {
    try {
      return window.localStorage.getItem("callerwhale.full-crm.demo-notes") === "on";
    } catch {
      return false;
    }
  });
  const setDemoNotes = useCallback(next => {
    setDemoNotesState(next);
    try {
      window.localStorage.setItem("callerwhale.full-crm.demo-notes", next ? "on" : "off");
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
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const taskNotices = profile.taskReminders && role.pages.includes("tasks")
    ? tasks.filter(task => profile.taskNoticeScope !== "due" || (task.date && task.date <= today))
    : [];
  const replyNotices = useMemo(
    () => (profile.replyReminders && role.pages.includes("inbox") ? visibleThreads(state).filter(thread => thread.unread) : []),
    [state, profile.replyReminders, role],
  );
  const handoffNotices = useMemo(() => {
    if (!profile.handoffReminders || !role.pages.includes("handoffs")) return [];
    const leadIds = new Set(leads.map(lead => lead.id));
    return state.handoffs.filter(item => item.status === "Requested" && leadIds.has(item.leadId));
  }, [state.handoffs, leads, profile.handoffReminders, role]);
  const importActionNotices = connection === "remote" && role.pages.includes("lists") ? importJobs.filter(needsImportAction) : [];
  const noticeCount = taskNotices.length + replyNotices.length + handoffNotices.length + importActionNotices.length;
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
      ["mail", "Mail", "work/mail"],
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
  const refreshImports = useCallback(async () => {
    const jobs = await api.imports.list();
    setImportJobs(jobs);
    return jobs;
  }, []);
  useEffect(() => {
    if (connection !== "remote" || !state.remote?.organizationId) {
      importSeen.current = null;
      setImportJobs([]);
      return;
    }
    importSeen.current = null;
    let active = true;
    let timerId;
    const poll = async () => {
      try {
        const jobs = await api.imports.list();
        if (!active) return;
        const previous = importSeen.current;
        if (previous) for (const job of jobs) {
          const before = previous.get(job.id);
          const message = importStatusMessage(job);
          if (message && before !== job.status && !routeRef.current.includes(`/imports/${job.id}`)) notify(message);
        }
        importSeen.current = new Map(jobs.map(job => [job.id, job.status]));
        setImportJobs(jobs);
      } catch {
        // Keep the last known import status while the connection recovers.
      } finally {
        if (active) timerId = window.setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => { active = false; window.clearTimeout(timerId); };
  }, [connection, state.remote?.organizationId, state.remote?.user?.id, notify]);
  // Every exported file says where it went (the desktop window saves to Downloads and shows it in the file manager).
  useEffect(() => {
    const saved = event => {
      const { path, error, browser } = event.detail || {};
      if (error) notify("The file could not be saved: " + error);
      else notify(browser ? "Download started: " + path : "Saved to " + path);
    };
    window.addEventListener("callerwhale-saved", saved);
    return () => window.removeEventListener("callerwhale-saved", saved);
  }, [notify]);
  const chat = useRef(null);
  const notifyRef = useRef(null);
  notifyRef.current = notify;
  const stopChat = () => {
    chat.current?.stop();
    chat.current = null;
  };
  // Connected: changes apply on screen at once and queue as operations for the server, which has the last word.
  const dispatch = useCallback(
    action => {
      const sync = engine.current;
      if (!sync) return apply(action);
      // Team chats and groups live in the messaging service: what is done to one goes there, and comes back as its new state.
      const talk = chat.current;
      if (talk && action.type === "CHAT_CREATE") return talk.create(action.kind, action.memberIds, action.title);
      if (talk?.has(action.id)) {
        if (action.type === "MESSAGE") {
          if (action.attach && action.attach.kind !== "poll") return void notify("Photos, files and GIFs are not available in team chats yet.");
          return void talk.send(action.id, action.text || "", { replyTo: action.replyTo, poll: action.attach?.poll });
        }
        if (action.type === "REACT") return void talk.react(action.id, action.index, action.emoji);
        if (action.type === "VOTE") return void talk.vote(action.id, action.index, action.option);
        if (action.type === "ARCHIVE") return void talk.archive(action.id, Boolean(action.archived));
        if (action.type === "MARK_READ") return void (action.unread === true ? talk.markUnread(action.id) : talk.markRead(action.id));
      }
      if (action.type === "SYNC") return void sync.sync();
      if (action.type === "REFRESH_LISTS") return void sync.refreshProjects().catch(error => notify("Lists could not be refreshed: " + error.message));
      if (action.type === "BROWSE_LEADS") return sync.browseLeads(action);
      if (action.type === "LEAD_DETAILS") return sync.leadDetails(action.id);
      if (action.type === "SEARCH_LEADS") return void sync.searchLeads(action.term).catch(() => {});
      if (action.type === "RESOLVE") return void sync.resolve(action.id, action.discard ? "discard" : "keep");
      if (["CONFLICT", "ROLE", "RESET"].includes(action.type)) return;
      if (action.type === "CONNECT") {
        sync.setOnline(action.online);
        return apply(action);
      }
      if (LOCAL_ONLY.has(action.type)) {
        if (action.type === "PERSONAL" && latest.current.remote?.user.id) {
          const current = personalProfile(latest.current);
          savePersonalPreferences(latest.current.remote.user.id, { ...current, ...action.profile });
        }
        return apply(action);
      }
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
  useEffect(() => subscribeCallLog(call => apply({ type: "CALL_LOG", call })), []);
  const connect = useCallback(async ({ me, vault }) => {
    const role = applyIdentity(me);
    const [directory, teams, projects] = await Promise.all([api.directory(), api.teams(), api.projects()]);
    const selectedWorkspace = me.organizations.find(item => item.id === me.organization_id);
    const organization = selectedWorkspace?.name || "";
    // `people`: the workspace's members from the server, with how each signs in.
    const preferences = loadPersonalPreferences(me.user.id);
    apply({ type: "REMOTE_START", role, preferences, remote: { user: me.user, capabilities: me.capabilities, organization, organizationId: me.organization_id, organizations: me.organizations, roles: me.roles, people: directory, timezone: selectedWorkspace?.timezone || "UTC" } });
    setSidebarCollapsed(preferences.sidebarCollapsed);
    if (!openedWithRoute) {
      const preferred = START_PAGES.find(page => page.id === preferences.startPage && ROLES[role].pages.includes(page.id));
      if (preferred) setRoute(preferred.path);
    }
    const sync = new SyncEngine({ vault, onChange: snapshot => apply(syncAction(snapshot, me.user.name)) });
    engine.current = sync;
    try {
      await sync.start({ directory, teams, projects, organizationId: me.organization_id });
      setConnection("remote");
      // Team chat is its own service and the CRM works without it: if it cannot be reached, the Inbox simply has no team chats.
      if (messagingBase() && me.capabilities.includes("message")) {
        const talk = new Messaging({ me: me.user.id, people: directory, onThreads: threads => apply({ type: "CHAT_THREADS", threads }), onError: message => notifyRef.current?.(message) });
        chat.current = talk;
        void talk.start().catch(() => {});
      }
    } catch (error) {
      sync.stop();
      engine.current = null;
      apply({ type: "REMOTE_END" });
      throw error;
    }
  }, []);
  const signOut = useCallback(async () => {
    stopChat();
    engine.current?.stop();
    engine.current = null;
    Vault.clearSession();
    // Signing out ends the session at the auth service; the organization is chosen again at the next sign-in.
    await auth.signOut().catch(() => {});
    setOrganization("");
    apply({ type: "REMOTE_END" });
    setConnection("gate");
  }, []);
  const switchWorkspace = useCallback(async id => {
    const current = latest.current.remote;
    if (!current || !current.organizations?.some(item => item.id === id) || current.organizationId === id) return;
    const sync = engine.current;
    if (sync) {
      await sync.sync();
      if (sync.status !== "synced" || sync.ops.length) {
        notify(sync.error || "Sync or resolve the pending changes before switching workspaces.");
        return;
      }
    }
    sync?.stop();
    stopChat();
    engine.current = null;
    saveWorkspaceChoice(current.user.id, id);
    setOrganization(id);
    apply({ type: "REMOTE_END" });
    setConnection("gate");
  }, [notify]);
  const useSample = useCallback(() => {
    stopChat();
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
    const apply = () => {
      setRoute(path.replace(/^\//, ""));
      setQuery("");
      setMobileNav(false);
    };
    // Opening a lead: its name in the list glides into the page title (a shared-element transition). Everything else just switches.
    const shared = document.querySelector("[data-shared]");
    if (shared && document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      shared.style.viewTransitionName = shared.dataset.shared;
      document.startViewTransition(() => flushSync(apply)).finished.finally(() => { shared.style.viewTransitionName = ""; delete shared.dataset.shared; });
    } else {
      shared?.removeAttribute("data-shared");
      apply();
    }
  }, []);
  useEffect(() => {
    routeRef.current = route;
    setNotifications(false);
    main.current?.scrollTo({ top: 0 });
  }, [route]);
  useEffect(() => {
    // Take any route an old link left in the address bar out of it.
    if (window.location.hash && !window.location.hash.startsWith("#/captions-window")) window.history.replaceState(null, "", window.location.pathname + window.location.search);
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
  const setSidebarPreference = useCallback(next => {
    setSidebarCollapsed(next);
    if (state.remote) dispatch({ type: "PERSONAL", profile: { sidebarCollapsed: next } });
    else {
      dispatch({ type: "PERSONAL", profile: { sidebarCollapsed: next } });
      try { window.localStorage.setItem("callerwhale.full-crm.sidebar-minimized", String(next)); } catch { /* Applies for this session. */ }
    }
  }, [dispatch, state.remote]);
  function toggleSidebar() { setSidebarPreference(!sidebarCollapsed); }
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
    () => ({ state, dispatch, navigate, notify, route, connection, importJobs, refreshImports, connect: showGate, signOut, switchWorkspace, sidebarCollapsed, setSidebarPreference }),
    [state, dispatch, navigate, notify, route, connection, importJobs, refreshImports, showGate, signOut, switchWorkspace, sidebarCollapsed, setSidebarPreference],
  );
  // Until the first records of a signed-in workspace have arrived, a page that shows them is its grey skeleton, not a page of zeros.
  const waitingForRecords = Boolean(state.remote && state.remoteLoading) && !["settings", "personal", "sync"].includes(current.split("/")[0] === "work" ? current.split("/")[1] : current.split("/")[0]);
  // The bar at the bottom (workspace name, "saved", "connected") is for the desktop app, where there is no browser to tell the person. In the
  // web CRM, signed in, it only appears when there is something to know: offline, changes waiting, or a sync problem.
  const inDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const needsAttention = !state.online || queue.length > 0 || state.remoteStatus === "offline" || state.remoteStatus === "error";
  const showFooter = !state.remote || inDesktop || needsAttention;
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
      case "mail":
        return <Mail />;
      case "lists":
        return <Lists id={parts[1]} importId={parts[2] === "imports" ? parts[3] : null} />;
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
  async function beforeUpdate() {
    const call = getCallSession();
    if (call.active || call.awaitingOutcome) throw new Error("Finish the call and save its outcome before installing the update.");
    const sync = engine.current;
    if (sync && (sync.running || sync.ops.length)) throw new Error("Sync pending changes before installing the update.");
    if (!latest.current.remote && !(await saveWorkspace(latest.current))) throw new Error("Your workspace could not be saved. Try again before installing the update.");
  }
  // A moment while the saved workspace is read, so the sample data never flashes in its place.
  if (connection === "local" && !restored) return null;
  if (connection === "gate")
    return (
      <div className="gate-window">
        {/* The desktop window has no system title bar, so the sign-in screen keeps the app's own controls. */}
        <WindowStrip title="Caller Whale" />
        <Suspense fallback={null}>
          <RemoteGate onReady={connect} onLeave={REQUIRE_SIGN_IN ? undefined : useSample} />
        </Suspense>
      </div>
    );
  return (
    <CrmContext.Provider value={context}>
      <div className={"crm-window" + (profile.reduceMotion ? " reduce-motion" : "")}>
        {state.remote && (
          <Suspense fallback={null}>
            <Approvals auth={auth} />
          </Suspense>
        )}
        <a className="skip-link" href="#main-content" onClick={event => (event.preventDefault(), main.current?.focus())}>
          Skip to content
        </a>
        <WindowStrip title="Caller Whale" beforeUpdate={beforeUpdate} />
        <header className="app-header" {...windowDrag}>
          <div className="brand">
            <button className="mobile-menu round-button" aria-label="Toggle navigation" onClick={() => setMobileNav(!mobileNav)}>
              <List size={22} />
            </button>
            <CallerWhaleMenu
              collapsed={sidebarCollapsed}
              onToggleSidebar={toggleSidebar}
              onReset={() => setReset(true)}
              onOpen={() => setNotifications(false)}
              demoNotes={demoNotes}
              onDemoNotes={setDemoNotes}
            />
            <strong>Caller Whale</strong>
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
                        navigate(conversationPath(thread));
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
                  {handoffNotices.slice(0, 2).map(handoff => (
                    <button key={handoff.id} onClick={() => { navigate("work/handoffs"); setNotifications(false); }}>
                      <CheckCircle size={19} />
                      <div><strong>Handoff waiting</strong><small>{handoff.from} · {handoff.note || "Review this handoff"}</small></div>
                    </button>
                  ))}
                  {importActionNotices.slice(0, 4).map(job => (
                    <button key={job.id} onClick={() => { navigate(importPath(job)); setNotifications(false); }}>
                      <List size={19} />
                      <div><strong>{job.name}</strong><small>{importStatusMessage(job)}</small></div>
                    </button>
                  ))}
                  {!noticeCount && (
                    <p>{!profile.taskReminders && !profile.replyReminders && !profile.handoffReminders ? "Your personal notifications are paused." : "You're all caught up."}</p>
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
            <PageTransition key={(current === "lists" || current.startsWith("lists/")) ? "lists:" + state.role : current + ":" + state.role}>
              <Suspense fallback={<PageSkeleton route={current} />}>{waitingForRecords ? <PageSkeleton route={current} /> : pageElement}</Suspense>
            </PageTransition>
          </main>
        </div>
        {showFooter && (
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
        )}
        <PhoneDialer />
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
              This clears this prototype's saved edits, imported preview rows, drafts, and pending changes. The main Caller Whale application is not affected.
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
