import type { TrackedMod } from "./config.js";

/**
 * GitHub / update-source helpers. Each launcher used to make these calls itself,
 * once per installed mod — the whole point of this service is to make them ONCE
 * here. All functions are best-effort: a failure logs and yields a safe empty
 * result so one bad source never breaks the whole manifest.
 */

function ghHeaders(token: string): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": "wol-launcher-notifier",
    Accept: "application/vnd.github+json",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Resolves the latest available version string for a tracked mod, or "" on failure. */
export async function resolveLatestVersion(mod: TrackedMod, token: string): Promise<string> {
  try {
    if (mod.updateMechanism === "WolPatcher") {
      if (!mod.updateInfoUrl) return "";
      const res = await fetch(mod.updateInfoUrl, { headers: { "User-Agent": "wol-launcher-notifier" } });
      if (!res.ok) {
        console.warn(`[github] ${mod.id}: UpdateInfo.xml HTTP ${res.status}`);
        return "";
      }
      const xml = await res.text();
      return firstVersionFromUpdateInfo(xml);
    }

    if (mod.updateMechanism === "GitHubReleases") {
      if (!mod.githubRepo) return "";
      const url = `https://api.github.com/repos/${mod.githubRepo}/releases?per_page=10`;
      const res = await fetch(url, { headers: ghHeaders(token) });
      if (!res.ok) {
        console.warn(`[github] ${mod.id}: releases HTTP ${res.status}`);
        return "";
      }
      const releases = (await res.json()) as Array<{ tag_name?: string; draft?: boolean; prerelease?: boolean }>;
      // First non-draft release; GitHub returns newest first.
      const latest = releases.find((r) => !r.draft);
      return latest?.tag_name ?? "";
    }
  } catch (err) {
    console.warn(`[github] ${mod.id}: version resolve failed:`, (err as Error).message);
  }
  return "";
}

/**
 * Extracts the FIRST version from an UpdateInfo.xml body. The launcher treats
 * Versions[0] as the latest; the file lists newest first. Best-effort regex so
 * the server needs no XML-parser dependency — adjust the attribute name here if
 * your UpdateInfo schema differs (verify against the real file once).
 */
export function firstVersionFromUpdateInfo(xml: string): string {
  // Matches e.g. <version ver="1.0.18" ...> or <version version="1.0.18">.
  const m = xml.match(/<version\b[^>]*\b(?:ver|version)\s*=\s*"([^"]+)"/i);
  return m?.[1]?.trim() ?? "";
}

/**
 * Lists the published translation dedup KEYS for a mod's translations repo. The
 * key is the release TAG (the launcher's KeyOf prefers the tag), and a release
 * only counts when it ships BOTH translation.json AND a .zip — mirroring
 * TranslationRegistryService.FetchFromReleasesAsync. Returns [] on failure.
 */
export async function resolveTranslationKeys(repo: string | undefined, token: string): Promise<string[]> {
  if (!repo) return [];
  try {
    const url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
    const res = await fetch(url, { headers: ghHeaders(token) });
    if (!res.ok) {
      console.warn(`[github] translations ${repo}: HTTP ${res.status}`);
      return [];
    }
    const releases = (await res.json()) as Array<{
      tag_name?: string;
      draft?: boolean;
      assets?: Array<{ name?: string }>;
    }>;
    const keys: string[] = [];
    for (const r of releases) {
      if (r.draft || !r.tag_name) continue;
      const names = (r.assets ?? []).map((a) => (a.name ?? "").toLowerCase());
      const hasManifest = names.includes("translation.json");
      const hasZip = names.some((n) => n.endsWith(".zip"));
      if (hasManifest && hasZip) keys.push(r.tag_name);
    }
    return keys;
  } catch (err) {
    console.warn(`[github] translations ${repo}: failed:`, (err as Error).message);
    return [];
  }
}
