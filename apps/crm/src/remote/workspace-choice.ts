const key = userId => `callerwhale.workspace-choice.${userId}`;

export function readWorkspaceChoice(userId) {
  try {
    const value = JSON.parse(localStorage.getItem(key(userId)) || "null");
    return value && typeof value.id === "string" && Number.isFinite(value.at) ? value : null;
  } catch {
    return null;
  }
}

export function saveWorkspaceChoice(userId, id, at = Date.now()) {
  try {
    localStorage.setItem(key(userId), JSON.stringify({ id, at }));
  } catch {
    // The choice still applies in this tab; the server stores it on /me.
  }
}

export function preferredWorkspace(organizations, serverId, serverAt, localChoice) {
  const allowed = new Set(organizations.map(item => item.id));
  const savedAt = Date.parse(serverAt || "") || 0;
  if (localChoice && allowed.has(localChoice.id) && localChoice.at > savedAt) return localChoice.id;
  if (allowed.has(serverId)) return serverId;
  return organizations[0]?.id || "";
}
