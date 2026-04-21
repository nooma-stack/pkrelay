#!/usr/bin/env bash
set -euo pipefail

HOST_NAME="com.nooma.pkrelay"
MANIFEST_FILE="${HOST_NAME}.json"

# --- Detect OS ---
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *)
    echo "Error: Unsupported OS '$OS'. This script supports macOS and Linux."
    exit 1
    ;;
esac

echo "Detected platform: $PLATFORM"

# --- Locate launcher.js (same directory as this script) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER_PATH="${SCRIPT_DIR}/launcher.js"

if [ ! -f "$LAUNCHER_PATH" ]; then
  echo "Error: launcher.js not found at $LAUNCHER_PATH"
  exit 1
fi

if [ ! -x "$LAUNCHER_PATH" ]; then
  echo "Making launcher.js executable..."
  chmod +x "$LAUNCHER_PATH"
fi

echo "Found launcher: $LAUNCHER_PATH"

# --- Check that pkrelay binary is available (launcher spawns it) ---
if ! command -v pkrelay &>/dev/null; then
  echo "Warning: 'pkrelay' binary not found in PATH — launcher will need it."
  echo "  Install it later with: npm install -g @nooma-stack/pkrelay"
else
  echo "Found pkrelay binary: $(command -v pkrelay)"
fi

# --- Detect the extension ID from the browser's Secure Preferences ---
# Chrome stores unpacked-extension metadata in <profile>/Secure Preferences
# as JSON. Walk the extensions.settings map and return the ID of the
# entry whose `path` field mentions "pkrelay". Returns empty string if
# the extension isn't loaded yet.
detect_extension_id() {
  local prefs_file="$1"
  [ -f "$prefs_file" ] || { echo ""; return; }
  python3 - "$prefs_file" <<'PY' 2>/dev/null || echo ""
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    exts = data.get("extensions", {}).get("settings", {})
    for eid, info in exts.items():
        path = (info.get("path") or "").lower()
        if "pkrelay" in path:
            print(eid)
            break
except Exception:
    pass
PY
}

# --- Build browser host directories + profile prefs paths ---
declare -a BROWSER_NAMES=()
declare -a BROWSER_DIRS=()
declare -a BROWSER_PREFS=()

add_browser() {
  local name="$1" data_root="$2"
  [ -d "$data_root" ] || return 0
  BROWSER_NAMES+=("$name")
  BROWSER_DIRS+=("$data_root/NativeMessagingHosts")
  BROWSER_PREFS+=("$data_root/Default/Secure Preferences")
}

if [ "$PLATFORM" = "macos" ]; then
  add_browser "Chrome" "$HOME/Library/Application Support/Google/Chrome"
  add_browser "Arc"    "$HOME/Library/Application Support/Arc/User Data"
  add_browser "Edge"   "$HOME/Library/Application Support/Microsoft Edge"
else
  add_browser "Chrome" "$HOME/.config/google-chrome"
  add_browser "Edge"   "$HOME/.config/microsoft-edge"
fi

if [ ${#BROWSER_DIRS[@]} -eq 0 ]; then
  echo "Error: No supported browsers detected (Chrome, Arc, Edge)."
  exit 1
fi

# --- Write manifest to each browser directory, auto-filling extension ID ---
declare -a CONFIGURED=()
declare -a PLACEHOLDERS=()

for i in "${!BROWSER_DIRS[@]}"; do
  DIR="${BROWSER_DIRS[$i]}"
  NAME="${BROWSER_NAMES[$i]}"
  PREFS="${BROWSER_PREFS[$i]}"

  EXT_ID=$(detect_extension_id "$PREFS")

  if [ -n "$EXT_ID" ]; then
    ORIGIN="chrome-extension://${EXT_ID}/"
    CONFIGURED+=("$NAME (ID: $EXT_ID)")
  else
    ORIGIN="chrome-extension://YOUR_EXTENSION_ID_HERE/"
    PLACEHOLDERS+=("$NAME")
  fi

  mkdir -p "$DIR"
  cat > "$DIR/$MANIFEST_FILE" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "PKRelay launcher — ensures broker daemon is running",
  "path": "${LAUNCHER_PATH}",
  "type": "stdio",
  "allowed_origins": [
    "${ORIGIN}"
  ]
}
EOF
  echo "  Wrote manifest to $DIR/$MANIFEST_FILE"
done

echo ""
echo "Native messaging host (launcher) installed."
echo "  Launcher: $LAUNCHER_PATH"

if [ ${#CONFIGURED[@]} -gt 0 ]; then
  echo ""
  echo "Auto-detected extension ID for: ${CONFIGURED[*]}"
fi

if [ ${#PLACEHOLDERS[@]} -gt 0 ]; then
  echo ""
  echo "Placeholder used for: ${PLACEHOLDERS[*]}"
  echo "The extension must be loaded in that browser before the ID can be"
  echo "detected. After loading the unpacked extension at:"
  echo "  ${SCRIPT_DIR%/*}/extension"
  echo "re-run this script to patch the placeholder with the real ID."
fi
