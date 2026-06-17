import { createHash } from "node:crypto";
import type { AppConfig } from "./config.js";
import { resolveLatestVersion, resolveTranslationKeys } from "./github.js";

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
  const mods: Manifest["mods"] = {};

  // Sequential on purpose: a handful of mods, and serialising keeps us gentle on
  // GitHub's rate limit from this single IP.
  for (const mod of config.mods) {
    if (!mod.id) continue;
    const latestVersion = await resolveLatestVersion(mod, config.githubToken);
    const translations = await resolveTranslationKeys(mod.translationsRepo, config.githubToken);
    mods[mod.id] = { latestVersion, translations };
  }

  const manifest: Manifest = { version: 1, generatedAt: nowIso, mods };
  return { manifest, etag: computeEtag(mods) };
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
