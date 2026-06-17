import { readFileSync } from "node:fs";

/** One mod the poller tracks. Mirrors the launcher's ModProfile fields it needs. */
export interface TrackedMod {
  id: string;
  /**
   * The launcher's `update.mechanism`: "WolPatcher" → read UpdateInfo.xml;
   * "GitHubReleases" → read repo releases. Any other value ("Manual",
   * "DelegatedExternal", or something unknown) resolves to an empty version —
   * the mod can still report translations.
   */
  updateMechanism: string;
  /** WolPatcher: URL of UpdateInfo.xml. */
  updateInfoUrl?: string;
  /** WolPatcher: alternate/mirror UpdateInfo.xml URL, tried if the primary fails. */
  updateInfoUrlAlt?: string;
  /** GitHubReleases: "owner/repo" whose latest release tag is the version. */
  githubRepo?: string;
  /** Optional "owner/repo" of the community translations repo for this mod. */
  translationsRepo?: string;
}

export interface AppConfig {
  port: number;
  host: string;
  pollIntervalMs: number;
  githubToken: string;
  /**
   * The mods catalog repo ("owner/repo") — the PRIMARY source. The poller
   * auto-discovers every mod from here (see catalog.ts), so a modder only has
   * to publish their mod.json to the catalog; nobody hand-maintains this server.
   */
  catalogRepo: string;
  /**
   * OPTIONAL per-mod overrides from mods.config.json, merged ON TOP of the
   * catalog-discovered list by id. Use for edge cases: a mod not in the catalog,
   * or forcing a different URL than the catalog declares. Empty when the file is
   * absent (the normal case — the catalog is enough).
   */
  manualOverrides: TrackedMod[];
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(): AppConfig {
  // Optional overrides file. Absent is the normal case — the catalog is the
  // source of truth — so a missing file is silent (not an error).
  const modsConfigPath = process.env.MODS_CONFIG ?? "./mods.config.json";
  let manualOverrides: TrackedMod[] = [];
  try {
    const parsed = JSON.parse(readFileSync(modsConfigPath, "utf8"));
    manualOverrides = Array.isArray(parsed?.mods) ? parsed.mods : [];
    if (manualOverrides.length > 0)
      console.log(`[config] ${manualOverrides.length} manual override(s) from ${modsConfigPath}`);
  } catch {
    // No overrides file (or unreadable) → catalog-only. Intentionally quiet.
  }

  return {
    port: envInt("PORT", 8090),
    host: process.env.HOST ?? "0.0.0.0",
    pollIntervalMs: envInt("POLL_INTERVAL_MINUTES", 10) * 60_000,
    githubToken: process.env.GITHUB_TOKEN ?? "",
    catalogRepo: process.env.CATALOG_REPO ?? "Gorgorito12/aoe3-mods-catalog",
    manualOverrides,
  };
}
