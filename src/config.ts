import { readFileSync } from "node:fs";

/** One mod the poller tracks. Mirrors the launcher's ModProfile fields it needs. */
export interface TrackedMod {
  id: string;
  /** "WolPatcher" → read UpdateInfo.xml; "GitHubReleases" → read repo releases. */
  updateMechanism: "WolPatcher" | "GitHubReleases";
  /** WolPatcher: URL of UpdateInfo.xml. */
  updateInfoUrl?: string;
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
  mods: TrackedMod[];
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(): AppConfig {
  const modsConfigPath = process.env.MODS_CONFIG ?? "./mods.config.json";
  let mods: TrackedMod[] = [];
  try {
    const parsed = JSON.parse(readFileSync(modsConfigPath, "utf8"));
    mods = Array.isArray(parsed?.mods) ? parsed.mods : [];
  } catch (err) {
    console.error(`[config] could not read ${modsConfigPath}:`, (err as Error).message);
  }

  return {
    port: envInt("PORT", 8090),
    host: process.env.HOST ?? "0.0.0.0",
    pollIntervalMs: envInt("POLL_INTERVAL_MINUTES", 10) * 60_000,
    githubToken: process.env.GITHUB_TOKEN ?? "",
    mods,
  };
}
