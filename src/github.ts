import { createHash } from "node:crypto";
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

/**
 * User-Agent for the WolPatcher UpdateInfo.xml fetch. We impersonate the
 * launcher's UA (its UpdateInfoService uses "WarsOfLibertyLauncher/0.3") because
 * some mod update servers (e.g. WoL's) 403 unknown agents — we observed a 403
 * with our own UA. We're doing exactly what the launcher does, just centrally.
 */
const UPDATE_INFO_UA = "WarsOfLibertyLauncher/0.3";

/** Resolves the latest available version string for a tracked mod, or "" on failure. */
export async function resolveLatestVersion(mod: TrackedMod, token: string): Promise<string> {
  try {
    if (mod.updateMechanism === "WolPatcher") {
      // Try the primary UpdateInfo.xml, then the alternate (mirror) on failure —
      // same primary→alt fallback the launcher's UpdateInfoService does.
      for (const url of [mod.updateInfoUrl, mod.updateInfoUrlAlt]) {
        if (!url) continue;
        try {
          const res = await fetch(url, { headers: { "User-Agent": UPDATE_INFO_UA } });
          if (!res.ok) {
            console.warn(`[github] ${mod.id}: UpdateInfo.xml HTTP ${res.status} (${url})`);
            continue;
          }
          const ver = firstVersionFromUpdateInfo(await res.text());
          if (ver) return ver;
          console.warn(`[github] ${mod.id}: no version parsed from ${url}`);
        } catch (e) {
          console.warn(`[github] ${mod.id}: UpdateInfo.xml fetch failed (${url}):`, (e as Error).message);
        }
      }
      return "";
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

/**
 * Content fingerprint of a folder-published pack. MUST stay byte-identical to the
 * launcher's TranslationCompat.ComputeContentHash so the dedup keys match: sort
 * files by path, join "path\ntranslatedHash" with "\n", sha256 the UTF-8 bytes,
 * take the first 16 lowercase-hex chars.
 */
function computeContentHash(
  files: Array<{ path?: string; translatedHash?: string }> | undefined,
): string {
  const ordered = (files ?? [])
    .filter((f) => f)
    .slice()
    .sort((a, b) => {
      const pa = a.path ?? "";
      const pb = b.path ?? "";
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
  const payload = ordered.map((f) => `${f.path ?? ""}\n${f.translatedHash ?? ""}`).join("\n");
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
}

/**
 * Folder-published translations: each pack lives in translations/<id>/ on main
 * with a translation.json (+ .zip). Lists the folder via the Contents API and
 * reads each manifest via the raw CDN; the key is `id@contentHash` (read from the
 * manifest, recomputed from files when absent — same recipe as the launcher).
 * Returns [] on failure or when the repo has no translations/ folder.
 */
export async function resolveTranslationFolderKeys(
  repo: string | undefined,
  token: string,
): Promise<string[]> {
  if (!repo) return [];
  try {
    // One call gets the whole tree; handles both translations/<id>/translation.json
    // (single version) and translations/<id>/<version>/translation.json (history).
    const url = `https://api.github.com/repos/${repo}/git/trees/main?recursive=1`;
    const res = await fetch(url, { headers: ghHeaders(token) });
    if (res.status === 404) return []; // no tree → empty, not an error
    if (!res.ok) {
      console.warn(`[github] translations tree ${repo}: HTTP ${res.status}`);
      return [];
    }
    const data = (await res.json()) as { tree?: Array<{ path?: string; type?: string }> };
    const re = /^translations\/([^/]+)(?:\/([^/]+))?\/translation\.json$/;

    // Group manifest paths by language id.
    const byLang = new Map<string, string[]>();
    for (const node of data.tree ?? []) {
      if (node.type !== "blob") continue;
      const m = re.exec(node.path ?? "");
      if (!m) continue;
      const arr = byLang.get(m[1]) ?? [];
      arr.push(node.path!);
      byLang.set(m[1], arr);
    }

    const keys: string[] = [];
    for (const [, paths] of byLang) {
      // Read each version's manifest; emit only the NEWEST version's key (same
      // newest as the launcher: date desc, then version desc).
      const candidates: { id: string; hash: string; date: string; version: string }[] = [];
      for (const path of paths) {
        try {
          const raw = `https://raw.githubusercontent.com/${repo}/main/${path}`;
          const mRes = await fetch(raw);
          if (!mRes.ok) continue;
          const m = (await mRes.json()) as {
            id?: string;
            contentHash?: string;
            date?: string;
            version?: string;
            files?: Array<{ path?: string; translatedHash?: string }>;
          };
          if (!m.id) continue;
          const hash =
            m.contentHash && m.contentHash.trim() ? m.contentHash.trim() : computeContentHash(m.files);
          candidates.push({ id: m.id, hash, date: m.date ?? "", version: m.version ?? "" });
        } catch (err) {
          console.warn(`[github] translations ${repo}/${path}: failed:`, (err as Error).message);
        }
      }
      if (candidates.length === 0) continue;
      candidates.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1; // date desc
        const av = a.version.toLowerCase();
        const bv = b.version.toLowerCase();
        return av === bv ? 0 : av < bv ? 1 : -1; // version desc
      });
      const newest = candidates[0];
      keys.push(`${newest.id}@${newest.hash}`);
    }
    return keys;
  } catch (err) {
    console.warn(`[github] translations tree ${repo}: failed:`, (err as Error).message);
    return [];
  }
}

/**
 * DUAL MODE: combined translation keys for a mod — folder-published packs (on
 * main) plus legacy release-published packs — deduped. This is what the manifest
 * builder calls.
 */
export async function resolveAllTranslationKeys(mod: TrackedMod, token: string): Promise<string[]> {
  const [folder, releases] = await Promise.all([
    resolveTranslationFolderKeys(mod.translationsFolderRepo, token),
    resolveTranslationKeys(mod.translationsRepo, token),
  ]);
  return Array.from(new Set([...folder, ...releases]));
}
