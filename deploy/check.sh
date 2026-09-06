#!/usr/bin/env bash
#
# Did the deploy work?
#
# Prints one line per check and a single verdict. DEPLOY OK is the only output that means
# you are finished. Exit code 0 on success, 1 on failure, so it can gate a script.
#
# It CHANGES NOTHING. Safe to run whenever, as many times as you like.
#
#   ./deploy/check.sh              on the VM: local checks + the public URL
#   ./deploy/check.sh --remote     from anywhere: the public URL only
#
# The remote form is the useful one when you are not at the machine — it needs nothing but
# curl, and it still catches the failure that matters most (see "mods with a version").

set -uo pipefail

HOST="${NOTIFIER_HOST:-https://wol-notify.duckdns.org}"
LOCAL="${NOTIFIER_LOCAL:-http://localhost:8090}"
UNIT="${NOTIFIER_UNIT:-notifier}"

REMOTE_ONLY=0
[ "${1:-}" = "--remote" ] && REMOTE_ONLY=1

fails=0
ok()   { printf '  \033[32m OK \033[0m %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fails=$((fails+1)); }
note() { printf '       %s\n' "$1"; }

echo
echo "Checking ${HOST}"
[ "$REMOTE_ONLY" -eq 0 ] && echo "and the service on this machine"
echo

# ---------------------------------------------------------------- on the VM
if [ "$REMOTE_ONLY" -eq 0 ] && command -v systemctl >/dev/null 2>&1; then

  if systemctl is-active --quiet "$UNIT"; then
    ok "the service is running"
  else
    bad "the service is not running"
    note "systemctl status $UNIT"
  fi

  # ready is the real signal. ok is a constant; ready is state !== null, so it stays false
  # until the first poll finishes. A few seconds of this right after a restart is normal.
  health="$(curl -fsS --max-time 10 "$LOCAL/health" 2>/dev/null || true)"
  if printf '%s' "$health" | grep -q '"ready":true'; then
    ok "the first poll finished"
  else
    bad "the first poll has not finished"
    note "got: ${health:-no answer at all}"
    note "right after a restart this needs a few seconds - wait and re-run"
  fi

  # THE SILENT ONE. At zero mods the service is up, /manifest answers 200, and the manifest
  # is empty: the catalog fetch failed and every launcher quietly receives nothing.
  poll="$(journalctl -u "$UNIT" -n 200 --no-pager 2>/dev/null | grep '\[poll\] manifest rebuilt' | tail -1 || true)"
  if [ -z "$poll" ]; then
    bad "no poll has completed yet"
    note "journalctl -u $UNIT -n 200 --no-pager"
  else
    count="$(printf '%s' "$poll" | sed -n 's/.*rebuilt: \([0-9]*\) mods.*/\1/p')"
    if [ "${count:-0}" -gt 0 ]; then
      ok "the last poll returned $count mods"
    else
      bad "the last poll returned 0 mods - the catalog fetch is failing"
      note "$poll"
    fi
  fi
fi

# ---------------------------------------------------------------- from anywhere
body="$(curl -fsS --max-time 20 "$HOST/manifest" 2>/dev/null || true)"
head="$(curl -fsSI --max-time 20 "$HOST/manifest" 2>/dev/null || true)"

if [ -z "$body" ]; then
  bad "$HOST/manifest did not answer"
  note "nginx, the certificate, DNS or the service - try $LOCAL/health on the VM to tell which"
else
  ok "the public URL answers"

  printf '%s' "$head" | grep -qi '^etag:' \
    && ok "it sends an ETag (launchers get cheap 304s)" \
    || bad "no ETag header - every launcher will re-download the manifest every time"

  # WHITESPACE-TOLERANT, and that is the whole point of the character classes. The first
  # version of this matched "latestVersion":"" literally and passed against production purely
  # because Fastify emits compact JSON - one space after a colon and both counts below would
  # have reported success while saying nothing. grep -o counts OCCURRENCES rather than lines,
  # so it does not care that the manifest arrives as a single line either.
  total="$(printf '%s' "$body" | grep -o '"latestVersion"[[:space:]]*:' | wc -l | tr -d '[:space:]')"
  empty="$(printf '%s' "$body" | grep -o '"latestVersion"[[:space:]]*:[[:space:]]*""' | wc -l | tr -d '[:space:]')"

  if [ "${total:-0}" -eq 0 ]; then
    bad "the manifest carries no mods at all"
    note "the catalog fetch failed - the service is up and saying nothing"
  elif [ "${empty:-0}" -gt 0 ]; then
    bad "$empty of $total mods have an empty version"
    note "a version that would not resolve - check the log for that mod"
  else
    ok "all $total mods have a version"
  fi

  # generatedAt proves the POLL LOOP is alive, not just the web server: a crashed poller
  # keeps serving the last good manifest forever, and every other check here would pass.
  gen="$(printf '%s' "$body" | sed -n 's/.*"generatedAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [ -z "$gen" ]; then
    bad "the manifest has no generatedAt"
  else
    now=$(date -u +%s)
    then_=$(date -u -d "$gen" +%s 2>/dev/null || echo 0)
    if [ "$then_" -eq 0 ]; then
      ok "built at $gen"
      note "could not read that date on this machine, so its age was not checked"
    else
      age=$(( (now - then_) / 60 ))
      # The poll interval is 10 minutes; 30 gives it two missed turns before complaining.
      if [ "$age" -le 30 ]; then
        ok "built $age min ago"
      else
        bad "built $age min ago - the poll loop looks stuck"
        note "the web server can keep serving a stale manifest forever"
      fi
    fi
  fi
fi

echo
if [ "$fails" -eq 0 ]; then
  printf '  \033[32mDEPLOY OK\033[0m\n\n'
  exit 0
fi
printf '  \033[31mNOT OK - %d check(s) failed\033[0m\n\n' "$fails"
exit 1
