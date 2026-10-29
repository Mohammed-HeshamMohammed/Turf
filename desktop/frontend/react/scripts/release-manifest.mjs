import { readFileSync, readdirSync, writeFileSync } from "node:fs";
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bundle = new URL("../../../container/rust/target/release/bundle/nsis/", import.meta.url);
  const installers = readdirSync(bundle).filter(name => name.endsWith(".exe"));
  if (installers.length !== 1) throw new Error(`Expected one installer, found ${installers.length}`);
  const installer = installers[0];
  const manifest = releaseManifest({
    version: process.env.RELEASE_VERSION,
    repository: process.env.GITHUB_REPOSITORY,
    installer,
    signature: readFileSync(new URL(installer + ".sig", bundle), "utf8"),
  });
  writeFileSync(new URL("latest.json", bundle), JSON.stringify(manifest, null, 2) + "\n");
}
