#!/usr/bin/env bash
# Generic HTTP checker. Reads "label|url" lines from LIST_A and LIST_B,
# prints only labels and states, notifies on state changes.
# No -x, no URL or body is ever printed.
set +x
set -u

LIST_A="${LIST_A:-}"
LIST_B="${LIST_B:-}"
TG_TOKEN="${TG_TOKEN:-}"
TG_CHAT="${TG_CHAT:-}"
TG_API="${TG_API:-https://api.telegram.org}"
TG_WAIT="${TG_WAIT:-5}"
PING="${PING:-}"
QUIET="${QUIET:-}"
ATTEMPTS="${ATTEMPTS:-3}"
WAIT="${WAIT:-30}"
TIMEOUT="${TIMEOUT:-10}"
STATE="${STATE:-.state/state.txt}"
NOW_HOUR="${NOW_HOUR:-}"

fail() { echo "error: $1" >&2; exit 1; }

for v in ATTEMPTS WAIT TIMEOUT TG_WAIT; do
  [[ "${!v}" =~ ^[0-9]+$ ]] || fail "$v must be a number"
done
(( ATTEMPTS >= 1 )) || fail "ATTEMPTS must be at least 1"
(( TIMEOUT >= 1 )) || fail "TIMEOUT must be at least 1"

# ---- quiet hours -----------------------------------------------------------
quiet_now() {
  [[ -z "$QUIET" ]] && return 1
  if ! [[ "$QUIET" =~ ^([0-9]{1,2})-([0-9]{1,2})$ ]]; then
    fail "QUIET must look like 23-08"
  fi
  local s=$((10#${BASH_REMATCH[1]})) e=$((10#${BASH_REMATCH[2]})) h
  (( s <= 24 && e <= 24 )) || fail "QUIET hours must be 0-24"
  if [[ -n "$NOW_HOUR" ]]; then h=$((10#$NOW_HOUR)); else h=$((10#$(TZ=Europe/Madrid date +%H))); fi
  (( s == e )) && return 1
  if (( s < e )); then (( h >= s && h < e )); else (( h >= s || h < e )); fi
}

# ---- parse lists, mask everything before any network call ------------------
declare -a labels=() urls=()
declare -A seen=()
n=0
while IFS= read -r line || [[ -n "$line" ]]; do
  n=$((n + 1))
  line="${line//$'\r'/}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ -z "$line" || "$line" == \#* ]] && continue
  [[ "$line" == *"|"* ]] || fail "list entry $n has no label"
  label="${line%%|*}"
  url="${line#*|}"
  [[ "$label" =~ ^[A-Za-z0-9_.-]{1,24}$ ]] || fail "list entry $n has an invalid label"
  [[ "$url" =~ ^https?://[^[:space:]]+$ ]] || fail "label $label has an invalid address"
  [[ -z "${seen[$label]:-}" ]] || fail "label $label is repeated"
  seen[$label]=1
  rest="${url#*://}"
  hostport="${rest%%/*}"
  hostport="${hostport##*@}"
  host="${hostport%%:*}"
  for m in "$url" "$rest" "$hostport" "$host"; do
    [[ -n "$m" ]] && echo "::add-mask::$m"
  done
  labels+=("$label")
  urls+=("$url")
done < <(printf '%s\n%s\n' "$LIST_A" "$LIST_B")

[[ -n "$TG_TOKEN" ]] && echo "::add-mask::$TG_TOKEN"
[[ -n "$TG_CHAT" ]] && echo "::add-mask::$TG_CHAT"
[[ -n "$PING" ]] && echo "::add-mask::$PING"

(( ${#labels[@]} > 0 )) || fail "no entries configured"

# ---- one probe: prints only the HTTP code ----------------------------------
probe() {
  curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" \
    --proto '=http,https' -- "$1" 2>/dev/null || true
}
is_up() { [[ "$1" =~ ^[23][0-9][0-9]$ ]]; }

# ---- checks: retry only the failing ones, inside the same run --------------
declare -A res=()
pending=("${!labels[@]}")
for ((a = 1; a <= ATTEMPTS; a++)); do
  next=()
  for i in "${pending[@]}"; do
    code="$(probe "${urls[$i]}")"
    if is_up "$code"; then
      res[${labels[$i]}]=up
      echo "[${labels[$i]}] attempt $a/$ATTEMPTS: ok"
    else
      echo "[${labels[$i]}] attempt $a/$ATTEMPTS: fail (${code:-000})"
      next+=("$i")
    fi
  done
  pending=("${next[@]}")
  (( ${#pending[@]} == 0 )) && break
  (( a < ATTEMPTS )) && sleep "$WAIT"
done
for i in "${pending[@]}"; do res[${labels[$i]}]=down; done

# ---- previous state --------------------------------------------------------
declare -A old=()
old_content=""
if [[ -f "$STATE" ]]; then
  old_content="$(cat "$STATE")"
  while IFS='=' read -r k v; do
    [[ -n "$k" ]] && old[$k]="$v"
  done < "$STATE"
fi

if quiet_now; then silent=true; else silent=false; fi

# ---- decide: only changes are announced ------------------------------------
declare -A new=()
declare -a msg=() changed=()
for l in "${labels[@]}"; do
  prev="${old[$l]:-up}"
  cur="${res[$l]}"
  new[$l]="$prev"
  if [[ "$cur" == up ]]; then
    if [[ "$prev" != up ]]; then msg+=("🟢 $l recuperado"); changed+=("$l"); new[$l]=up; fi
  else
    if [[ "$prev" == up ]]; then
      msg+=("🔴 $l caído"); changed+=("$l")
      if [[ "$silent" == true ]]; then new[$l]=downq; else new[$l]=down; fi
    elif [[ "$prev" == downq && "$silent" == false ]]; then
      msg+=("🔴 $l sigue caído"); changed+=("$l"); new[$l]=down
    fi
  fi
done

# ---- notify ----------------------------------------------------------------
exit_code=0
if (( ${#msg[@]} > 0 )); then
  text="$(printf '%s\n' "${msg[@]}")"
  if [[ -z "$TG_TOKEN" || -z "$TG_CHAT" ]]; then
    echo "::warning::notifications are in dry-run mode (no credentials)"
    for l in "${changed[@]}"; do echo "dry-run: $l -> ${new[$l]}"; done
  else
    sent=""
    for ((t = 1; t <= 2; t++)); do
      sent="$(printf 'url = "%s/bot%s/sendMessage"\n' "$TG_API" "$TG_TOKEN" |
        curl -s -o /dev/null -w '%{http_code}' --max-time 15 -K - \
          --data-urlencode "chat_id=$TG_CHAT" \
          --data-urlencode "text=$text" \
          --data-urlencode "disable_notification=$silent" 2>/dev/null || true)"
      [[ "$sent" == 200 ]] && break
      (( t < 2 )) && sleep "$TG_WAIT"
    done
    if [[ "$sent" == 200 ]]; then
      echo "notification sent (${#changed[@]} change(s), silent=$silent)"
    else
      echo "error: notification failed (code ${sent:-000}); state kept to retry" >&2
      for l in "${changed[@]}"; do new[$l]="${old[$l]:-up}"; done
      exit_code=1
    fi
  fi
fi

# ---- save state ------------------------------------------------------------
mkdir -p "$(dirname "$STATE")"
new_content="$(for l in "${labels[@]}"; do echo "$l=${new[$l]}"; done)"
printf '%s\n' "$new_content" > "$STATE"
if [[ "$new_content" != "$old_content" ]]; then ch=true; else ch=false; fi
[[ -n "${GITHUB_OUTPUT:-}" ]] && echo "changed=$ch" >> "$GITHUB_OUTPUT"

# ---- heartbeat (optional) --------------------------------------------------
if [[ -n "$PING" ]]; then
  curl -s -o /dev/null --max-time 10 --proto '=http,https' -- "$PING" >/dev/null 2>&1 || true
fi

exit "$exit_code"
