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
openbox --sm-disable >/dev/null 2>&1 &
wm_pid=$!
trap 'kill "$wm_pid" 2>/dev/null || true' EXIT
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if xprop -root _NET_CLIENT_LIST_STACKING 2>/dev/null | grep -q '^_NET_CLIENT_LIST_STACKING(WINDOW)'; then
    break
  fi
  sleep 0.2
done
xprop -root _NET_CLIENT_LIST_STACKING | grep -q '^_NET_CLIENT_LIST_STACKING(WINDOW)'

# enigo/x11rb needs an unused X11 keycode when constructing its input
# connection.  Hosted Xvfb images commonly ship with every keycode mapped,
# so reserve the final keycode explicitly before starting the real sidecar.
xdpyinfo >/dev/null
xmodmap -e 'keycode 255 ='

"$python_bin" "$script_dir/smoke_bundle.py" "$bundle" \
  --computer-control expect-granted "$@"
