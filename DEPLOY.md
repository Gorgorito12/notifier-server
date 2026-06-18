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

## Operations

| Action | Command |
| --- | --- |
| Status / logs | `systemctl status notifier` · `journalctl -u notifier -f` |
| Restart after `.env` change | `sudo systemctl restart notifier` |
| Update to latest code | `cd ~/notifier-server && git pull && npm ci && npm run build && sudo systemctl restart notifier` |
| Cert renewal (automatic) | `sudo certbot renew --dry-run` to test |
| Add a GitHub token later | edit `GITHUB_TOKEN=` in `.env`, then restart |

Apache-2.0.
