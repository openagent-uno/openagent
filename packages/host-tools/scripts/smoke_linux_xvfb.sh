#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <bundle-directory> [smoke-bundle options]" >&2
  exit 2
fi

bundle="$1"
shift
python_bin="${PYTHON:-python}"
script_dir="$(cd "$(dirname "$0")" && pwd)"

# xcap reads the EWMH window inventory maintained by a window manager.
# Xvfb alone has no _NET_CLIENT_LIST_STACKING root property.
wm_log="$(mktemp)"
openbox --sm-disable >"$wm_log" 2>&1 &
wm_pid=$!
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q '^_NET_SUPPORTING_WM_CHECK(WINDOW)'; then
    break
  fi
  sleep 0.2
done
xmessage -center 'OpenAgent native tool smoke' >/dev/null 2>&1 &
client_pid=$!
trap 'kill "$client_pid" "$wm_pid" 2>/dev/null || true; rm -f "$wm_log"' EXIT
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if xprop -root _NET_CLIENT_LIST_STACKING 2>/dev/null | grep -q '^_NET_CLIENT_LIST_STACKING(WINDOW)'; then
    break
  fi
  sleep 0.2
done
if ! xprop -root _NET_CLIENT_LIST_STACKING | grep -q '^_NET_CLIENT_LIST_STACKING(WINDOW)'; then
  cat "$wm_log" >&2
  xprop -root _NET_SUPPORTING_WM_CHECK _NET_CLIENT_LIST_STACKING >&2
  exit 1
fi

# enigo/x11rb needs an unused X11 keycode when constructing its input
# connection.  Hosted Xvfb images commonly ship with every keycode mapped,
# so reserve the final keycode explicitly before starting the real sidecar.
xdpyinfo >/dev/null
xmodmap -e 'keycode 255 ='

"$python_bin" "$script_dir/smoke_bundle.py" "$bundle" \
  --computer-control expect-granted "$@"
