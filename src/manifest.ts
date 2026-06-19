import { createHash } from "node:crypto";
import type { AppConfig, TrackedMod } from "./config.js";
import { discoverFromCatalog } from "./catalog.js";
import { resolveLatestVersion, resolveAllTranslationKeys } from "./github.js";

/** The manifest the launchers read. Matches the launcher's NotificationFeed model. */
export interface Manifest {
  version: number;
  generatedAt: string;
  mods: Record<string, { latestVersion: string; translations: string[] }>;
}

/** A manifest plus the ETag launchers use for If-None-Match / 304. */
export interface ManifestState {
  manifest: Manifest;
  /** Quoted ETag value, e.g. "\"<sha256>\"". */
  etag: string;
}

/**
 * Polls every tracked mod's update source + translations repo and builds the
 * manifest. The ETag is a hash of the CONTENT only (the mods map) — NOT
 * generatedAt — so an unchanged poll keeps the same ETag and launchers get a
 * cheap 304. Throttle is the caller's POLL_INTERVAL.
 */
export async function buildManifest(config: AppConfig, nowIso: string): Promise<ManifestState> {
  // PRIMARY source: every mod discovered from the catalog. Manual overrides (if
  // any) are merged ON TOP by id, so an entry in mods.config.json supplements a
  // mod missing from the catalog or forces a different URL.
  const catalogMods = await discoverFromCatalog(config.catalogRepo, config.githubToken);
  const tracked = mergeById(catalogMods, config.manualOverrides);

  const mods: Manifest["mods"] = {};
  // Sequential on purpose: serialising keeps us gentle on GitHub's rate limit
  // from this single IP.
  for (const mod of tracked) {
    if (!mod.id) continue;
    const latestVersion = await resolveLatestVersion(mod, config.githubToken);
    // Dual mode: folder-published (translations/<id>/ on main) + legacy releases.
    const translations = await resolveAllTranslationKeys(mod, config.githubToken);
    mods[mod.id] = { latestVersion, translations };
  }

  const manifest: Manifest = { version: 1, generatedAt: nowIso, mods };
  return { manifest, etag: computeEtag(mods) };
}

/**
 * Merges manual overrides on top of the catalog-discovered list, keyed by id
 * (case-insensitive). An override replaces the catalog entry for that id; an
 * override for an id not in the catalog is added. Field-level: the override
 * object wins wholesale for its id (simplest, predictable).
 */
function mergeById(catalogMods: TrackedMod[], overrides: TrackedMod[]): TrackedMod[] {
  const byId = new Map<string, TrackedMod>();
  for (const m of catalogMods) if (m.id) byId.set(m.id.toLowerCase(), m);
  for (const o of overrides) {
    if (!o.id) continue;
    const key = o.id.toLowerCase();
    byId.set(key, { ...byId.get(key), ...o });
  }
  return [...byId.values()];
}

/** Stable content hash of the mods map (sorted keys) → the ETag. */
export function computeEtag(mods: Manifest["mods"]): string {
  const sorted = Object.keys(mods)
    .sort()
    .reduce<Manifest["mods"]>((acc, k) => {
      acc[k] = { latestVersion: mods[k].latestVersion, translations: [...mods[k].translations].sort() };
      return acc;
    }, {});
  const hash = createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
  return `"${hash}"`;
}
