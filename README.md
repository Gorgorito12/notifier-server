# wol-launcher-notifier

Central **notification feed** for the [AoE3 Mod Launcher](https://github.com/Gorgorito12/AoE3-Mod-Launcher).

Each launcher used to poll GitHub itself — once per installed mod, every 30 min —
to detect mod updates and new translations. That duplicated the same work across
every user and burned GitHub's anonymous **60 req/h-per-IP** budget. This service
does that polling **once for everyone** on a small VM and publishes a tiny JSON
manifest the launchers read with a single cheap `ETag`/`304` request. The launcher
still does the version/translation **diff and dedup locally** — the feed only
moves the data fetch off each client.

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
cp .env.example .env                       # PORT, POLL_INTERVAL_MINUTES, GITHUB_TOKEN…
cp mods.config.example.json mods.config.json  # the mods to track + their update sources
```

`mods.config.json` lists each tracked mod with its `updateMechanism`
(`WolPatcher` → reads `UpdateInfo.xml`; `GitHubReleases` → reads repo releases)
and the relevant URL/repo, plus an optional `translationsRepo`.

> ⚠️ **Verify the version extraction once.** `WolPatcher` mods read the first
> `<version ver="…">` out of `UpdateInfo.xml` with a regex (no XML-parser dep).
> Confirm the attribute name against the real file and adjust
> `firstVersionFromUpdateInfo` in `src/github.ts` if your schema differs.

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
