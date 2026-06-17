# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code
in this repository.

## What this is

A tiny **Node + Fastify (TypeScript)** service that publishes a single JSON
**notification manifest** for the [AoE3 Mod Launcher](https://github.com/Gorgorito12/AoE3-Mod-Launcher).
It polls GitHub **once for everyone** on a timer and serves `GET /manifest` —
each mod's *latest available version* plus the set of *published translation
keys*. Launchers read it with one cheap `ETag`/`304` request instead of each
launcher polling GitHub itself, once per installed mod, every 30 min.

**Why it exists:** the launcher's `SweepInstalledModsForNotificationsAsync`
historically fired an `UpdateService.CheckAsync()` + a translation-release listing
**per installed mod, per client** — duplicating the same work across every user and
burning GitHub's anonymous **60 req/h-per-IP** budget (a real concern behind shared
NAT / Radmin VPN). This service centralizes that polling on a single IP.

**Where it runs:** its **own free Oracle Cloud VM**, deliberately separate from the
lobby backend (`wol-launcher-lobby-node`, a 1 GB VM capped at ~60 concurrent users).
Keeping it separate isolates the GitHub-polling load and lets it grow a GitHub token
(5000 req/h) without touching lobbies.

## The launcher relationship (read first)

This service is **one half of a two-repo feature.** The other half lives in the
launcher repo:

- `WarsOfLibertyLauncher/Services/NotificationFeedService.cs` — reads this
  service's `/manifest` (with `If-None-Match`), caches it on disk, and **never
  throws**: on any failure it returns `Failed = true`.
- `WarsOfLibertyLauncher/MainWindow.xaml.cs` → `SweepInstalledModsForNotificationsAsync`
  — tries the feed once; on success applies it to every installed mod (zero
  per-mod GitHub calls); on failure **falls back to direct GitHub polling**.

**This service is therefore NEVER a single point of failure** — if it's down, the
launcher degrades to the old behaviour. Two consequences for how you change things:

1. **The manifest shape is a CONTRACT.** It is deserialized by the launcher's
   `NotificationFeed` / `NotificationFeedMod` C# models (in
   `Services/NotificationFeedService.cs`). Adding fields is safe (the client
   ignores unknown JSON); **renaming or removing `mods` / `latestVersion` /
   `translations` silently breaks every client's notifications** — they'd just
   fall back to GitHub. Coordinate any breaking change across both repos.
2. The launcher does the **diff and dedup locally** — it compares `latestVersion`
   against its cached installed version (`ModState.LastKnownVersion`) and the
   translation keys against `ModState.NotifiedTranslationKeys`. This service
   reports *availability only*; it knows nothing about any user.

## Build & run

Node **18+** (CI tests 18 and 20; developed on 24).

| Goal | Command |
| --- | --- |
| Install deps | `npm install` |
| Type-check (no emit) | `npm run typecheck` |
| Compile to `dist/` | `npm run build` |
| Run compiled | `npm start` |
| Watch mode (tsx) | `npm run dev` |

Configure before running:

```bash
cp .env.example .env                            # PORT, POLL_INTERVAL_MINUTES, GITHUB_TOKEN…
cp mods.config.example.json mods.config.json    # the mods to track + their update sources
```

Smoke-test the HTTP contract locally:

```bash
curl -i http://localhost:8090/manifest                  # 200 + ETag
curl -i -H 'If-None-Match: "<etag>"' .../manifest        # 304
curl -s http://localhost:8090/health                     # {"ok":true,"ready":…}
```

`README.md` has the Oracle-VM deploy sketch (reverse proxy + TLS + systemd/pm2).

## Architecture

```
src/index.ts     entry point: in-memory manifest, poll timer, Fastify routes
   └─ src/manifest.ts   buildManifest() polls every tracked mod → Manifest + ETag
        └─ src/github.ts   resolveLatestVersion() / resolveTranslationKeys()
   └─ src/config.ts   loadConfig(): env vars + mods.config.json
```

- **`src/config.ts`** — `loadConfig()` reads env (`PORT`, `HOST`,
  `POLL_INTERVAL_MINUTES`, `GITHUB_TOKEN`, `MODS_CONFIG`) and the tracked-mods
  JSON. `TrackedMod` mirrors the launcher's `ModProfile` fields this service needs
  (`id`, `updateMechanism`, `updateInfoUrl` | `githubRepo`, `translationsRepo`).
- **`src/github.ts`** — all GitHub / update-source I/O. Every function is
  **best-effort: it logs and returns a safe empty value on failure** so one bad
  source never blanks the whole manifest.
- **`src/manifest.ts`** — `buildManifest()` walks the tracked mods sequentially
  (gentle on the rate limit) and computes the ETag. `computeEtag()` is exported
  for testing.
- **`src/index.ts`** — holds the current manifest in memory, rebuilds on
  `setInterval`, serves `/manifest` (+ `/health`). Stateless beyond that
  in-memory copy; a restart just re-polls.

## Important gotchas

- **The ETag hashes CONTENT ONLY — never `generatedAt`.** `computeEtag()` hashes a
  sorted projection of the `mods` map, deliberately excluding the `generatedAt`
  timestamp. If `generatedAt` were in the hash, every poll would mint a new ETag
  and **no client would ever get a 304** — defeating the entire point. If you add
  a top-level field that changes every poll, keep it out of the hash too.

- **Translation keys MUST match the launcher's `KeyOf` exactly.** The launcher
  dedups translations on a key it computes as the GitHub **release tag** (falling
  back to `id@version`) — see `NotifyNewTranslations` in the launcher's
  `MainWindow.xaml.cs`. `resolveTranslationKeys()` therefore emits the
  **`tag_name`** of each release that ships BOTH `translation.json` AND a `.zip`
  (mirroring the launcher's `TranslationRegistryService.FetchFromReleasesAsync`
  filter). If this service emitted a different key format (e.g. always
  `id@version`), the client baseline and the feed would mismatch → false "new
  translation" bells or none at all. Keep the key = release tag.

- **The `WolPatcher` version regex is best-effort and UNVERIFIED against a real
  file.** `firstVersionFromUpdateInfo()` pulls the first `<version ver="…">` (or
  `version="…"`) out of `UpdateInfo.xml` with a regex, so the service needs no
  XML-parser dependency. The launcher treats `Versions[0]` as the latest and the
  file lists newest-first. **Confirm the attribute name against the actual WoL
  `UpdateInfo.xml` and adjust the regex if the schema differs** — a wrong match
  yields `""` (no update ever offered for that mod), which is silent.

- **`mods.config.json` is gitignored on purpose; commit the `.example`.** It holds
  deploy-specific URLs. The committed `mods.config.example.json` is the template.
  With no `mods.config.json` present the service starts, **warns**, and serves an
  empty `mods: {}` manifest (valid — clients just see no mods). So an empty
  manifest in production usually means a missing/misread config, not a code bug.

- **CI runs `npm ci`, which REQUIRES `package-lock.json` to be committed.**
  `.github/workflows/ci.yml` does `npm ci` → `npm run typecheck` → `npm run build`
  on Node 18/20. `package-lock.json` is **not** gitignored — keep it committed and
  in sync (run `npm install` after changing deps). If you ever drop the lockfile,
  switch CI to `npm install` or CI goes red.

- **`.gitignore` covers `node_modules/`, `dist/`, `.env`, `mods.config.json`,
  `*.log`.** `dist/` is build output (CI rebuilds it; deploy builds on the VM).

## Conventions

- **ESM + TypeScript strict.** `"type": "module"`, `tsconfig` `strict: true`. Use
  `.js` import specifiers for local modules (`./config.js`) even though the source
  is `.ts` — that's ESM/NodeNext resolution, not a typo.
- **Never throw out of a poll or a GitHub helper.** A failed fetch must log and
  keep the previous manifest (`index.ts`'s `poll()` catch) or return an empty
  result (`github.ts`) — the client's fallback depends on this service staying up
  with stale-but-valid data rather than crashing.
- **Apache-2.0**, same as the launcher. Sign commits off: `git commit -s` (DCO).
- Diagnostic logs (`console.log`/`warn`/`error`) are English, prefixed by stage
  (`[config]`, `[github]`, `[poll]`, `[startup]`).
