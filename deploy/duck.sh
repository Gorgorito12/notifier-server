#!/usr/bin/env bash
# DuckDNS updater for wol-notify.duckdns.org. Lives on the VM at ~/duckdns/duck.sh
# and runs from cron every 5 minutes (Oracle public IPs can be ephemeral).
#
# RUN IT FROM THE VM, NEVER FROM YOUR PC. The `ip=` field is left EMPTY on
# purpose: DuckDNS then uses the requester's own IP. Run this from a laptop and
# the domain starts pointing at your home connection instead of the server,
# which is the classic "ERR_CONNECTION_TIMED_OUT" cause.
#
# The token is a UUID (8-4-4-4-12) and is NOT in this repo. Replace YOUR_TOKEN
# on the VM's copy. A `KO` reply means the token is wrong or malformed.
#
# Install (see DEPLOY.md section 4):
#   mkdir -p ~/duckdns && cp deploy/duck.sh ~/duckdns/duck.sh
#   chmod +x ~/duckdns/duck.sh
#   # edit in the real token, then:
#   ~/duckdns/duck.sh && nslookup wol-notify.duckdns.org
#   ( crontab -l 2>/dev/null; echo "*/5 * * * * ~/duckdns/duck.sh >/dev/null 2>&1" ) | crontab -

curl -s "https://www.duckdns.org/update?domains=wol-notify&token=YOUR_TOKEN&ip=" >/dev/null
