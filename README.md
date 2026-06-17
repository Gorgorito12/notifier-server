# wol-launcher-notifier

Central **notification feed** for the [AoE3 Mod Launcher](https://github.com/Gorgorito12/AoE3-Mod-Launcher).

Each launcher used to poll GitHub itself — once per installed mod, every 30 min —
to detect mod updates and new translations. That duplicated the same work across
every user and burned GitHub's anonymous **60 req/h-per-IP** budget. This service
does that polling **once for everyone** on a small VM and publishes a tiny JSON
manifest the launchers read with a single cheap `ETag`/`304` request. The launcher
still does the version/translation **diff and dedup locally** — the feed only
moves the data fetch off each client.

**Mods are auto-discovered from the catalog — nobody hand-maintains this server.**
The poller reads the launcher's mods catalog (`CATALOG_REPO`), parses each mod's
`mod.json`, and derives its update source + translations repo automatically — the
same fields the launcher uses. So a **modder just publishes their mod to the
catalog** (via the launcher's "Publish my mod" wizard or a catalog PR) and their
update / new-translation notifications reach everyone, with zero config here and
nothing for them to understand about this service. `mods.config.json` exists only
as an **optional override** for edge cases.

> Intended to run on its **own free Oracle Cloud VM**, separate from the lobby
> backend (`wol-launcher-lobby-node`). If this service is down, launchers
> automatically fall back to polling GitHub directly — it is never a single point
> of failure.

## The manifest

`GET /manifest` →

```json
{
  "version": 1,
  "generatedAt": "2026-06-17T12:00:00Z",
  "mods": {
    "wol": { "latestVersion": "1.0.18", "translations": ["v1.0.18-es", "v1.0.17-pt"] },
    "improvement-mod": { "latestVersion": "9.0.4", "translations": [] }
  }
}
```

- `latestVersion` — the latest AVAILABLE version (not the user's installed one;
  the launcher compares against its own cached installed version).
- `translations` — the published translation dedup **keys**, each the GitHub
  release **tag** (falling back to `id@version`) — identical to the key the
  launcher computes locally, so dedup stays consistent across the feed and the
  GitHub fallback.
- The `ETag` is a hash of the **content only** (not `generatedAt`), so an
  unchanged poll returns the same ETag and the launcher gets a `304`.

## Configure

```bash
cp .env.example .env       # set CATALOG_REPO (the rest have sane defaults)
```

Normally that's all — set `CATALOG_REPO` to your mods catalog and the poller
discovers everything. `mods.config.json` is **optional** (copy from
`mods.config.example.json`) and only for edge cases: tracking a mod that isn't in
the catalog, or forcing a different URL than the catalog declares. Its entries
merge **on top of** the catalog by `id`.

> ⚠️ **`WolPatcher` version extraction is best-effort.** It reads the first
> `<version ver="…">` out of `UpdateInfo.xml` with a regex (no XML-parser dep),
> trying the primary URL then the `updateInfoUrlAlt` mirror, with the launcher's
> User-Agent (`WarsOfLibertyLauncher/0.3`) — some mod servers `403` unknown
> agents (WoL's `aoe3wol.com` does; the SourceForge mirror works). Confirm the
> attribute name against the real file and adjust `firstVersionFromUpdateInfo` in
> `src/github.ts` if a mod's schema differs.

## Run

```bash
npm install
npm run build && npm start     # production
npm run dev                    # watch mode
```

Then:

```bash
curl -i http://localhost:8090/manifest                 # 200 + ETag
curl -i -H 'If-None-Match: "<etag>"' .../manifest       # 304
```

## Deploy (Oracle Cloud VM, sketch)

1. Open the port (or front with nginx/caddy + your DuckDNS hostname, e.g.
   `wol-notify.duckdns.org`), TLS via Let's Encrypt.
2. Install Node 18+, `npm ci && npm run build`.
3. Run under a process manager (systemd / pm2) so it restarts on reboot.
4. Point the launcher at it: set `notificationFeedUrl` in `launcher-config.json`
   to `https://<your-host>/manifest` (or change the built-in default
   `ResolveNotificationFeedUrl()` in `MainWindow.xaml.cs`).

## Notes

- WebSocket frames bypass per-request budgets, but this is plain REST on purpose:
  the manifest must reach **every** user, including those not signed in or not on
  the Multiplayer tab, so it can't ride the lobby backend's `/global/ws`.
- The feed carries only **public** data (already on GitHub) and collects nothing
  from users — no auth required.

Apache-2.0.
