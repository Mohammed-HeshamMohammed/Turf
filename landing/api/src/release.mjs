const TTL_MS = 10 * 60 * 1000;

/**
 * The newest published desktop release, read from GitHub Releases. A draft is never listed there, so publishing the
 * draft is what puts a version on the site. Cached, so the site never waits on GitHub or meets its rate limit.
 */
export function latestRelease({ repo, fetchImpl = fetch, now = Date.now }) {
  let cached = null;
  return async () => {
    if (!repo) return { available: false };
    if (cached && now() - cached.at < TTL_MS) return cached.value;
    let value = { available: false };
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "callerwhale-landing-api" },
      });
      if (res.ok) {
        const release = await res.json();
        const installer = (release.assets || []).find(a => /\.(msi|exe)$/i.test(a.name));
        if (installer) {
          value = {
            available: true,
            version: String(release.tag_name || "").replace(/^desktop-v|^v/, ""),
            notes: release.body || "",
            published: release.published_at || "",
            file: installer.name,
            size: installer.size,
            url: installer.browser_download_url,
          };
        }
      }
    } catch {
      // GitHub unreachable: the site shows "coming soon" rather than an error.
    }
    cached = { at: now(), value };
    return value;
  };
}
