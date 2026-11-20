export const DEFAULT_PERSONAL_PREFERENCES = {
  taskReminders: true,
  replyReminders: true,
  handoffReminders: true,
  taskNoticeScope: "all",
  startPage: "dashboard",
  sidebarCollapsed: false,
  reduceMotion: false,
};

export const START_PAGES = [
  { id: "dashboard", label: "Overview", path: "dashboard" },
  { id: "leads", label: "Leads", path: "work/leads" },
  { id: "tasks", label: "Tasks", path: "work/tasks" },
  { id: "inbox", label: "Inbox", path: "work/inbox" },
  { id: "lists", label: "Source lists", path: "lists" },
];

const key = userId => `callerwhale.full-crm.preferences.${userId}`;

export function personalPreferences(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    taskReminders: typeof source.taskReminders === "boolean" ? source.taskReminders : true,
    replyReminders: typeof source.replyReminders === "boolean" ? source.replyReminders : true,
    handoffReminders: typeof source.handoffReminders === "boolean" ? source.handoffReminders : true,
    taskNoticeScope: source.taskNoticeScope === "due" ? "due" : "all",
    startPage: START_PAGES.some(page => page.id === source.startPage) ? source.startPage : "dashboard",
    sidebarCollapsed: source.sidebarCollapsed === true,
    reduceMotion: source.reduceMotion === true,
  };
}

export function loadPersonalPreferences(userId, storage) {
  if (!userId) return { ...DEFAULT_PERSONAL_PREFERENCES };
  try {
    return personalPreferences(JSON.parse((storage || globalThis.localStorage).getItem(key(userId)) || "null"));
  } catch {
    return { ...DEFAULT_PERSONAL_PREFERENCES };
  }
}

export function savePersonalPreferences(userId, value, storage) {
  if (!userId) return false;
  try {
    (storage || globalThis.localStorage).setItem(key(userId), JSON.stringify(personalPreferences(value)));
    return true;
  } catch {
    return false;
  }
}
