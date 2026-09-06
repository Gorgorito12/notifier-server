# Deploy — Oracle Cloud VM (tested runbook)

This is the **actual, end-to-end procedure** used to put this service into
production, not a sketch. It runs on a free **Oracle Cloud** Ampere/x64 VM
(Ubuntu 24.04, 1 GB RAM), fronted by **nginx + Let's Encrypt** at a **DuckDNS**
hostname, under **systemd**.

> **Live deployment (reference values):** hostname `notifier-server`, public IP
> `129.213.160.55`, served at **`https://wol-notify.duckdns.org/manifest`**,
> systemd unit **`notifier`**. Substitute your own host/IP/token below.

The launcher already defaults to `https://wol-notify.duckdns.org/manifest`
(`ResolveNotificationFeedUrl()` in the launcher's `MainWindow.xaml.cs`), so a
deployment at that host needs **no client change**. If the service is down the
launcher falls back to polling GitHub directly — it is never a single point of
failure.

---

## 0. Prepare the VM

Ubuntu 24.04 with **1 GB RAM needs swap** (the build + Node would otherwise
OOM). Add 2 GB and install Node 20 + git:

```bash
# Swap (2 GB)
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf
sudo sysctl vm.swappiness=10

# Node 20 LTS + git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git
```

If `apt upgrade` pulled a new kernel, **reboot** before continuing
(`sudo reboot`); the systemd service comes back on its own.

## 1. Clone + build

```bash
cd ~
git clone https://github.com/Gorgorito12/notifier-server.git
cd notifier-server
npm ci
npm run build        # emits dist/
```

## 2. Configure `.env`

```bash
cp .env.example .env
sed -i 's/^HOST=.*/HOST=127.0.0.1/' .env   # bind locally; nginx fronts it
```

Defaults are fine: `PORT=8090`, `CATALOG_REPO=Gorgorito12/aoe3-mods-catalog`,
`POLL_INTERVAL_MINUTES=10`, `GITHUB_TOKEN=` (empty = anonymous, ~60 req/h is
plenty at current scale; add a scopeless classic PAT later for 5000 req/h).

> ⚠️ **The app does NOT auto-load `.env`** — it reads `process.env` directly
> (no dotenv). Inject the env via systemd `EnvironmentFile=` (step 3), or for a
> manual run use `node --env-file=.env dist/index.js` (Node 20.6+).

Smoke-test before wiring systemd:

```bash
node --env-file=.env dist/index.js &
sleep 12
curl -s http://localhost:8090/health      # {"ok":true,"ready":true}
curl -s http://localhost:8090/manifest    # {"version":1,...,"mods":{...}}
kill %1
```

## 3. systemd service

The unit is committed at [`deploy/notifier.service`](deploy/notifier.service) and the
heredoc below is byte-identical to it, so you can paste this or copy the file. Keeping both
in step is what makes the drift check in step 9.1 work.

```bash
sudo tee /etc/systemd/system/notifier.service >/dev/null <<'EOF'
[Unit]
Description=AoE3 Mod Launcher Notifier Feed
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/notifier-server
EnvironmentFile=/home/ubuntu/notifier-server/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5
MemoryMax=250M

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now notifier
systemctl status notifier --no-pager
curl -s http://localhost:8090/health
```

`MemoryMax=250M` is a guard rail for the 1 GB box (the service really uses a few
MB). `ExecStart` runs `node dist/index.js` and relies on `EnvironmentFile` for
config (no `--env-file` needed under systemd).

## 4. DNS — DuckDNS

Create the subdomain on duckdns.org, then **update it FROM the VM** so it
resolves to the VM's public egress IP. The `ip=` field is left **empty on
purpose** — DuckDNS then uses the requester's IP (the VM):

The script is committed at [`deploy/duck.sh`](deploy/duck.sh) (with `YOUR_TOKEN` as a
placeholder — **the real token is not in this repo**). Copy it instead of retyping, or use
the one-liner below:

```bash
mkdir -p ~/duckdns && cd ~/duckdns
echo 'curl -s "https://www.duckdns.org/update?domains=wol-notify&token=YOUR_TOKEN&ip=" >/dev/null' > duck.sh
chmod +x duck.sh && ./duck.sh
# keep it fresh (Oracle public IPs can be ephemeral):
( crontab -l 2>/dev/null; echo "*/5 * * * * ~/duckdns/duck.sh >/dev/null 2>&1" ) | crontab -
nslookup wol-notify.duckdns.org    # must return the VM's public IP
```

> ⚠️ **Do NOT update DuckDNS from your PC** with an empty `ip=` — that points the
> domain at your home IP, not the VM (the classic "ERR_CONNECTION_TIMED_OUT"
> cause). The token is a UUID `8-4-4-4-12`; a `KO` reply means a wrong/malformed
> token.

## 5. Firewall — Oracle has TWO layers (both required)

This is the #1 reason "the port won't open." You must allow 80/443 in **both**:

**(a) Oracle Security List (cloud level), in the web console:**
Networking → VCN → Subnet → **Security Lists** → *Default Security List* →
**Add Ingress Rules** → add two stateful (Stateless = No) rules:

| Source CIDR | IP Protocol | Destination Port |
| --- | --- | --- |
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

**(b) Local iptables (the Oracle Ubuntu image ships a restrictive INPUT chain).**
There is a `REJECT all -- reject-with icmp-host-prohibited` right after the
port-22 ACCEPT, so any ACCEPT added **after** it (e.g. a naive `-I INPUT 6` when
the chain is shorter) never runs. The 80/443 ACCEPTs must sit **before** that
REJECT:

```bash
# Inspect first — note the line number of the REJECT rule:
sudo iptables -L INPUT -n --line-numbers

# If your 80/443 ACCEPTs landed BELOW the REJECT, delete them (highest line first):
sudo iptables -D INPUT 7
sudo iptables -D INPUT 6

# Re-insert them BEFORE the REJECT (replace 5 with the REJECT's line number):
sudo iptables -I INPUT 5 -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 5 -p tcp --dport 443 -j ACCEPT

# Persist across reboots:
sudo DEBIAN_FRONTEND=noninteractive apt install -y netfilter-persistent iptables-persistent
sudo netfilter-persistent save

# Verify 80/443 are now ABOVE the REJECT:
sudo iptables -L INPUT -n --line-numbers
```

Sanity-check port reachability from outside before TLS (PowerShell on the client):

```powershell
Test-NetConnection -ComputerName wol-notify.duckdns.org -Port 80   # TcpTestSucceeded : True
```

## 6. nginx reverse proxy

This site file is committed at
[`deploy/nginx-notifier.conf`](deploy/nginx-notifier.conf) — the **pre-TLS** version. Step 7
lets certbot rewrite the live file for 443, so after that the two legitimately differ; the
part worth comparing is the `location /` block.

```bash
sudo apt install -y nginx certbot python3-certbot-nginx

sudo tee /etc/nginx/sites-available/notifier >/dev/null <<'EOF'
server {
    listen 80;
    server_name wol-notify.duckdns.org;
    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/notifier /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

> A `curl http://localhost/manifest` returning **404** is expected — the `Host`
> is `localhost`, which doesn't match `server_name`. Test with the real host:
> `curl -s -H 'Host: wol-notify.duckdns.org' http://localhost/manifest`.

## 7. TLS — certbot

Requires port 80 reachable from the internet (steps 4–6 done):

```bash
sudo certbot --nginx -d wol-notify.duckdns.org --redirect \
  -m you@example.com --agree-tos -n
```

This obtains the cert, rewrites nginx for 443, adds the HTTP→HTTPS redirect, and
schedules auto-renewal. Expect *"Successfully received certificate"* /
*"Congratulations!"*.

## 8. Verify (from the client)

```powershell
# HTTPS 200 + ETag
Invoke-WebRequest https://wol-notify.duckdns.org/manifest -UseBasicParsing |
  Select-Object StatusCode, @{n='ETag';e={$_.Headers.ETag}}

# 304 caching contract
$e = (Invoke-WebRequest https://wol-notify.duckdns.org/manifest -UseBasicParsing).Headers.ETag
$r = [Net.HttpWebRequest]::Create("https://wol-notify.duckdns.org/manifest")
$r.Headers.Add("If-None-Match", $e)
try { $r.GetResponse() } catch { $_.Exception.Response.StatusCode }   # NotModified (304)
```

The launcher consumes it automatically — confirm in its `launcher-debug.log`
that the notification sweep uses the feed (no "feed fetch failed").

---

## 9. Update a running deployment

Steps 0-8 are the first install. This is what you run afterwards, every time.

There is no CI/CD: nothing pushes to this VM. You SSH in, pull, rebuild, restart. The whole
thing takes about a minute.

### 9.0 Before you touch the VM

**The change has to be on GitHub, on the branch the VM tracks (`main`).** The VM deploys with
`git pull`; a commit that only exists on your laptop does not exist for it. A branch that is
pushed but not merged changes nothing here either.

```bash
# on your machine
git push origin main
```

### 9.1 Pre-flight, on the VM

```bash
ssh ubuntu@129.213.160.55
cd ~/notifier-server

git branch --show-current      # main
git status --porcelain         # EMPTY. Anything here is a hand-edit the pull will destroy
git rev-parse --short HEAD     # <- WRITE THIS DOWN. It is your rollback target
swapon --show                  # must not be empty
```

Two of those are not obvious:

- **A dirty working tree** means somebody patched the running server by hand and never
  committed it. `git pull` will either clobber it or refuse; either way you want to know
  before, not during.
- **Swap** because `tsc` does not fit in 1 GB of RAM. Step 0 makes it survive a reboot via
  `/etc/fstab`; if it was ever added by hand, a reboot took it away and the build will be
  OOM-killed halfway through.

Optionally, check the VM still matches what this repo documents:

```bash
diff deploy/notifier.service /etc/systemd/system/notifier.service   # expect no output
```

### 9.2 Update

```bash
git pull --ff-only
npm ci
npm run build
npm test
sudo systemctl restart notifier
```

`--ff-only` on purpose: if the VM has diverged, this **fails loudly** instead of
manufacturing a merge commit on a machine where nobody will ever look at the result.

`npm ci` deletes `node_modules` and reinstalls, dev dependencies included — this is why the
swap check matters. The service keeps serving the old build throughout; only the `restart`
interrupts it.

### 9.3 Verify — three checks, in this order

Each one rules out a different failure. Do not stop at the first.

```bash
# 1. Did it come back up?
systemctl is-active notifier                    # active

# 2. Did the first poll finish?
curl -s localhost:8090/health                   # {"ok":true,"ready":true}

# 3. Did the poll actually bring anything back?
journalctl -u notifier -n 30 --no-pager | grep '\[poll\]'
#   [poll] manifest rebuilt: 4 mods, etag="..."
```

- **`ready:true` is the real signal, not `ok`.** `ok` is a constant. `ready` is
  `state !== null`, which stays false until the first poll completes — so `ready:false` a
  few seconds in means the poll is not finishing.
- **`N mods` with N greater than zero is the one that catches the silent failure.** At N = 0
  the service is `active`, `/manifest` answers 200, and the manifest is empty: the catalog
  fetch failed and every launcher quietly gets nothing. Nothing else on this page would show
  it.
- **A few seconds of 502 right after the restart is NORMAL.** `main()` awaits the first
  `poll()` *before* `app.listen`, so the port is closed until the catalog has been walked and
  nginx has nothing to proxy to. Launchers fall back to polling GitHub directly, so it is not
  user-visible — but it looks like an outage if you are not expecting it.

Then from outside:

```bash
curl -sI https://wol-notify.duckdns.org/manifest | head -3       # 200 + ETag

curl -s https://wol-notify.duckdns.org/manifest \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['mods'])"
```

**No entry should have `latestVersion: ""`.** An empty version is a failed resolve that used
to be indistinguishable from "no change" — it hashes into the ETag, reaches launchers as the
mod's version, and raises no alarm anywhere.

### 9.4 Rolling back

```bash
cd ~/notifier-server
git checkout <the-sha-from-9.1>
npm ci && npm run build
sudo systemctl restart notifier
```

Then run 9.3 again. Two things to know:

- `git checkout <sha>` leaves **HEAD detached**. Before the next update you must
  `git checkout main`, or `git pull` will not do what you expect.
- **`.env` does not roll back with the code.** If you changed a variable in the same session,
  undo that by hand.

### 9.5 When it will not start

```bash
journalctl -u notifier -n 200 --no-pager          # the error, not just the state
journalctl -u notifier -p err --since '1 hour ago'
journalctl -u notifier | grep -i 'oom\|killed'    # MemoryMax=250M kills quietly
```

`MemoryMax=250M` plus `Restart=on-failure` turns an out-of-memory condition into a restart
loop that reads as "the service will not come up" — the actual reason only appears if you go
looking for the OOM. There is no log file: journald is the only place anything is written.

---

## Operations

| Action | Command |
| --- | --- |
| Status / logs | `systemctl status notifier` · `journalctl -u notifier -f` |
| Restart after `.env` change | `sudo systemctl restart notifier` |
| Update to latest code | **See [section 9](#9-update-a-running-deployment)** — the pre-flight and the three verification checks are the point; the bare `git pull && npm ci && npm run build && restart` cannot tell you whether it worked |
| Roll back | [section 9.4](#94-rolling-back) |
| Cert renewal (automatic) | `sudo certbot renew --dry-run` to test |
| Add a GitHub token later | edit `GITHUB_TOKEN=` in `.env`, then restart |

Apache-2.0.

---

## Announcements

The manifest carries the launcher's own announcements alongside the per-mod data, so news
reaches players in the notification bell instead of waiting for them to remember to go and read
a Discord.

**Publishing one is a commit**, to `announcements.json` in the launcher repo
(`Gorgorito12/AoE3-Mod-Launcher`). No deploy, no SSH, editable from the GitHub web UI. The next
poll picks it up.

```json
{
  "announcements": [
    {
      "id": "2026-09-competitive",
      "title": "Competitive rooms are live",
      "body": "Only competitive rooms count towards the ladder now.",
      "url": "https://discord.gg/WVarbzzzmc",
      "date": "2026-09-01"
    }
  ]
}
```

- **`id` is permanent.** It is the launcher's dedup key. Changing one re-announces the item to
  everybody; reusing one silently suppresses the new announcement for everyone who saw the old.
- `url` is optional — omit it and the launcher opens the project's Discord.
- Entries without an `id` or a `title` are dropped here rather than published.
- A missing or unreachable file is normal (404 → no announcements) and never blanks the rest of
  the manifest, the same best-effort rule every other source in `github.ts` follows.

Override the location with `ANNOUNCEMENTS_REPO` / `ANNOUNCEMENTS_PATH`.

### The ETag rule, which is the one way to break this silently

Launchers read this service with `If-None-Match`, so **the ETag is the only thing that decides
whether anybody ever sees a change.** `computeEtag` therefore hashes the mods map *and* the
announcements. Leave the announcements out and the failure is total and invisible: the service
looks healthy, the manifest is correct, every launcher gets a cheap `304`, and no announcement
ever arrives.

`generatedAt` stays OUT of the hash for the mirror-image reason — an unchanged poll must keep
the same ETag so the 304 stays cheap.

```bash
npm test        # pins exactly that: publishing or editing an announcement moves the ETag
```
