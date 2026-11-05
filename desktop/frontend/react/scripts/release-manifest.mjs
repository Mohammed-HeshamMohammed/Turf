import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Tauri's static update feed: URLs identify this exact signed release, never a mutable latest installer. */
export function releaseManifest({ version, repository, installer, signature, date = new Date().toISOString() }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected a stable release version, such as 0.1.4");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Expected owner/repository");
  if (!installer.endsWith(".exe") || /[/\\]/.test(installer)) throw new Error("Expected the Windows installer filename");
  if (!signature.trim()) throw new Error("The installer must be signed");
  return {
    version,
    notes: `Caller Whale ${version}. Includes the latest desktop improvements.`,
    pub_date: date,
    platforms: {
      "windows-x86_64": {
        signature: signature.trim(),
        url: `https://github.com/${repository}/releases/download/crm-v${version}/${encodeURIComponent(installer)}`,
      },
    },
  };
}

/** GitHub rewrites spaces in uploaded asset names. Use one fixed ASCII name before creating any URLs. */
export function prepareRelease(bundle, { version, repository }) {
  const installers = readdirSync(bundle).filter(name => name.endsWith(".exe"));
  if (installers.length !== 1) throw new Error(`Expected one installer, found ${installers.length}`);
  const original = installers[0];
  const installer = `CallerWhale_${version}_x64-setup.exe`;
  const manifest = releaseManifest({
    version,
    repository,
    installer,
    signature: readFileSync(new URL(original + ".sig", bundle), "utf8"),
  });
  if (original !== installer) {
    renameSync(new URL(original, bundle), new URL(installer, bundle));
    renameSync(new URL(original + ".sig", bundle), new URL(installer + ".sig", bundle));
  }
  writeFileSync(new URL("latest.json", bundle), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  prepareRelease(new URL("../../../container/rust/target/release/bundle/nsis/", import.meta.url), {
    version: process.env.RELEASE_VERSION,
    repository: process.env.GITHUB_REPOSITORY,
  });
}
