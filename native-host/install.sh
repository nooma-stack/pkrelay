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

# --- Build browser host directories ---
declare -a BROWSER_DIRS=()
declare -a BROWSER_NAMES=()

if [ "$PLATFORM" = "macos" ]; then
  CHROME_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  ARC_DIR="$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"
  EDGE_DIR="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"

  # Check which browsers are installed by looking for parent dir
  if [ -d "$HOME/Library/Application Support/Google/Chrome" ]; then
    BROWSER_DIRS+=("$CHROME_DIR")
    BROWSER_NAMES+=("Chrome")
  fi
  if [ -d "$HOME/Library/Application Support/Arc" ]; then
    BROWSER_DIRS+=("$ARC_DIR")
    BROWSER_NAMES+=("Arc")
  fi
  if [ -d "$HOME/Library/Application Support/Microsoft Edge" ]; then
    BROWSER_DIRS+=("$EDGE_DIR")
    BROWSER_NAMES+=("Edge")
  fi
elif [ "$PLATFORM" = "linux" ]; then
  CHROME_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
  EDGE_DIR="$HOME/.config/microsoft-edge/NativeMessagingHosts"

  if [ -d "$HOME/.config/google-chrome" ]; then
    BROWSER_DIRS+=("$CHROME_DIR")
    BROWSER_NAMES+=("Chrome")
  fi
  if [ -d "$HOME/.config/microsoft-edge" ]; then
    BROWSER_DIRS+=("$EDGE_DIR")
    BROWSER_NAMES+=("Edge")
  fi
fi

if [ ${#BROWSER_DIRS[@]} -eq 0 ]; then
  echo "Error: No supported browsers detected (Chrome, Arc, Edge)."
  exit 1
fi

# --- Write manifest to each browser directory ---
CONFIGURED=()

for i in "${!BROWSER_DIRS[@]}"; do
  DIR="${BROWSER_DIRS[$i]}"
  NAME="${BROWSER_NAMES[$i]}"

  mkdir -p "$DIR"

  cat > "$DIR/$MANIFEST_FILE" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "PKRelay launcher — ensures broker daemon is running",
  "path": "${LAUNCHER_PATH}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://YOUR_EXTENSION_ID_HERE/"
  ]
}
EOF

  CONFIGURED+=("$NAME")
  echo "  Wrote manifest to $DIR/$MANIFEST_FILE"
done

echo ""
echo "Native messaging host (launcher) installed for: ${CONFIGURED[*]}"
echo "  Launcher: $LAUNCHER_PATH"
echo ""
echo "IMPORTANT: Update the 'allowed_origins' in each manifest with your"
echo "actual extension ID. Find it at chrome://extensions with developer mode on."
echo "  Format: chrome-extension://EXTENSION_ID/"
