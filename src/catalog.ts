import type { TrackedMod } from "./config.js";

/**
 * Catalog auto-discovery — the PRIMARY source of tracked mods.
 *
 * Mirrors the launcher's `ModCatalogService.FetchAsync`: list the catalog repo's
 * `/mods` directory, read each `mod.json`, and project it to a `TrackedMod` with
 * the SAME field mapping the launcher uses in `ModRegistry.ProjectToProfile`. The
 * upshot is that a modder only fills their catalog `mod.json` (via the launcher's
 * "Publish my mod" wizard or a catalog PR) — nobody hand-maintains this server,
 * and update/translation notifications "just work" for every catalog mod.
 *
 * Best-effort, like the launcher: one bad/unreadable `mod.json` is skipped with a
 * log; a failed listing returns [] (the poller keeps any manual overrides).
 */

/** The slice of the catalog mod.json this server reads (see mod.schema.json). */
interface CatalogModJson {
  id?: string;
  sourceRepo?: string;
  update?: {
    mechanism?: string;
    wol?: { updateInfoUrl?: string; updateInfoUrlAlt?: string };
  };
  translations?: { repo?: string; folderRepo?: string };
}

interface GitHubContentEntry {
  name?: string;
  type?: string;
}

function ghHeaders(token: string): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": "wol-launcher-notifier",
    Accept: "application/vnd.github+json",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/**
 * Discovers every mod in the catalog and projects it to a TrackedMod. Returns []
 * on a failed listing (never throws) so the poller falls back to manual overrides.
 */
export async function discoverFromCatalog(catalogRepo: string, token: string): Promise<TrackedMod[]> {
  if (!catalogRepo) return [];

  let listing: GitHubContentEntry[];
  try {
    const url = `https://api.github.com/repos/${catalogRepo}/contents/mods`;
    const res = await fetch(url, { headers: ghHeaders(token) });
    if (!res.ok) {
      console.warn(`[catalog] listing ${catalogRepo} HTTP ${res.status}`);
      return [];
    }
    listing = (await res.json()) as GitHubContentEntry[];
  } catch (err) {
    console.warn(`[catalog] listing failed:`, (err as Error).message);
    return [];
  }

  const mods: TrackedMod[] = [];
  for (const entry of listing) {
    if (entry.type !== "dir" || !entry.name) continue;
    const folder = entry.name;
    try {
      // Pull mod.json from the raw CDN (not rate-limited, unlike the API).
      const rawUrl = `https://raw.githubusercontent.com/${catalogRepo}/main/mods/${folder}/mod.json`;
      const res = await fetch(rawUrl, { headers: { "User-Agent": "wol-launcher-notifier" } });
      if (!res.ok) {
        console.warn(`[catalog] '${folder}': mod.json HTTP ${res.status} — skipped`);
        continue;
      }
      const m = (await res.json()) as CatalogModJson;
      const tracked = projectToTracked(m, folder);
      if (tracked) mods.push(tracked);
    } catch (err) {
      console.warn(`[catalog] '${folder}': mod.json parse failed — skipped:`, (err as Error).message);
    }
  }

  console.log(`[catalog] discovered ${mods.length} trackable mod(s) from ${catalogRepo}`);
  return mods;
}

/**
 * Projects a catalog mod.json into a TrackedMod, or null when there's nothing to
 * report (no trackable update mechanism AND no translations repo). Same mapping
 * as the launcher's ModRegistry.ProjectToProfile.
 */
function projectToTracked(m: CatalogModJson, folder: string): TrackedMod | null {
  const id = m.id || folder;
  const mechanism = m.update?.mechanism ?? "";
  const translationsRepo = m.translations?.repo || undefined;
  const translationsFolderRepo = m.translations?.folderRepo || undefined;

  let updateInfoUrl: string | undefined;
  let updateInfoUrlAlt: string | undefined;
  let githubRepo: string | undefined;
  if (mechanism === "WolPatcher") {
    updateInfoUrl = m.update?.wol?.updateInfoUrl || undefined;
    updateInfoUrlAlt = m.update?.wol?.updateInfoUrlAlt || undefined;
  } else if (mechanism === "GitHubReleases") {
    githubRepo = m.sourceRepo || undefined;
  }

  // Nothing to report: no version source and no translations → skip (e.g. a
  // Manual/DelegatedExternal mod with no translations repo, or the stock game).
  const hasVersionSource =
    (mechanism === "WolPatcher" && (!!updateInfoUrl || !!updateInfoUrlAlt)) ||
    (mechanism === "GitHubReleases" && !!githubRepo);
  if (!hasVersionSource && !translationsRepo && !translationsFolderRepo) return null;

  return {
    id,
    updateMechanism: mechanism,
    updateInfoUrl,
    updateInfoUrlAlt,
    githubRepo,
    translationsRepo,
    translationsFolderRepo,
  };
}
