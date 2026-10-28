#!/bin/sh
# Raise an alert when a Hive relay unit fails (#191664). Called by hive-relay-alert@<unit>.service,
# the OnFailure= handler of hive-relay-renew.service. The renewal failed silently every day for
# three weeks before anyone looked; this makes a failure land on the IRIS bug board instead.
#
#   sh relay/alert.sh <unit>
#
# One open alert per unit: a repeat failure within RENOTIFY_DAYS (7) comments on the bug it already
# filed instead of filing another. Always also writes a crit line to the journal.
unit="${1:?usage: alert.sh <unit>}"
case "$unit" in *.*) ;; *) unit="$unit.service" ;; esac
state_dir="${HIVE_RELAY_ALERT_STATE:-$HOME/.iris/relay/alerts}"
iris="${IRIS_BIN:-$HOME/.iris/bin/iris}"
renotify=$(( ${RENOTIFY_DAYS:-7} * 86400 ))
mkdir -p "$state_dir"
state="$state_dir/$(printf '%s' "$unit" | tr -c 'a-zA-Z0-9.-' _)"

# The unit's last run only, never anything secret-shaped.
logs=$(journalctl -u "$unit" -n 25 --no-pager -o cat 2>/dev/null | grep -v -i -E 'token=[^$]|secret' | tail -n 25)
host=$(hostname)
title="Hive relay: $unit failed on $host"
desc="systemd unit $unit failed on $host at $(date -u +%FT%TZ). If this is hive-relay-renew.service, the relay certificate (relay.t.heyiris.io, serves every Hive tunnel) is not renewing or has under 21 days left — see the journal: journalctl -u $unit -n 100. Runbook: iris-daemon relay/systemd/hive-relay-renew.service (#191664)."

logger -p daemon.crit -t hive-relay-alert "$title"

now=$(date +%s); id=""; at=0
[ -f "$state" ] && read -r id at < "$state"
if [ -n "$id" ] && [ $((now - at)) -lt "$renotify" ]; then
  "$iris" bug comment "$id" "Failed again at $(date -u +%FT%TZ). Last log lines:
$logs" >/dev/null 2>&1 && { echo "alert: commented on #$id"; exit 0; }
fi
out=$("$iris" bug report "$title" --severity high --description "$desc" --error "$logs" --json 2>&1)
# `iris bug report --json` answers {"success":true,"item_id":N,...}
new=$(printf '%s' "$out" | grep -o -E '"(item_)?id"[[:space:]]*:[[:space:]]*[0-9]+' | head -1 | grep -o -E '[0-9]+$')
if [ -n "$new" ]; then
  echo "$new $now" > "$state"; echo "alert: filed bug #$new"
else
  echo "alert: could not file a bug: $out" >&2; exit 1
fi
