/** The address of a person's own page: callerwhale.com/their-username. Until the service has told us the username, the older /account. */
export const profilePath = (me: object | null | undefined) => {
  const name = String((me as { username?: unknown } | null | undefined)?.username || "");
  return /^[a-z0-9](?:-?[a-z0-9]){2,29}$/.test(name) ? `/${name}` : "/account";
};

/** The first level of an address that is not one of the site's own pages: the part that may be somebody's username. */
export const usernameInPath = (path: string) => {
  const match = /^\/([a-z0-9](?:-?[a-z0-9]){2,29})\/?$/.exec(path);
  return match ? match[1] : "";
};
