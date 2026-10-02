#!/bin/sh
# install.sh — install the Infinite Tiling KWin script, its focus-border
# effect, and (optionally) the X11 mouse-wheel bridge.
#
# Usage:
#   ./install.sh              # install everything (wheel bridge only on X11)
#   ./install.sh --no-wheel   # skip the wheel bridge
#   ./install.sh --uninstall  # remove everything
set -e

SCRIPT_SRC="infinite-tiling"
EFFECT_SRC="tiling-focus-border"
WHEEL_SRC="kwin-infinite-tiling-wheel.py"
WHEEL_DESKTOP="kwin-infinite-tiling-wheel.desktop"

KWIN_SCRIPTS_DIR="$HOME/.local/share/kwin/scripts"
KWIN_EFFECTS_DIR="$HOME/.local/share/kwin/effects"
BIN_DIR="$HOME/.local/bin"
AUTOSTART_DIR="$HOME/.config/autostart"

uninstall() {
    echo "Removing Infinite Tiling components..."
    rm -rf "$KWIN_SCRIPTS_DIR/infinite-tiling"
    rm -rf "$KWIN_EFFECTS_DIR/tiling-focus-border"
    rm -f "$BIN_DIR/kwin-infinite-tiling-wheel.py"
    rm -f "$AUTOSTART_DIR/kwin-infinite-tiling-wheel.desktop"
    echo "Done. Restart KWin (or log out/in) to fully unload the script."
    exit 0
}

[ "$1" = "--uninstall" ] && uninstall

echo "Installing Infinite Tiling KWin script..."
mkdir -p "$KWIN_SCRIPTS_DIR" "$KWIN_EFFECTS_DIR"
rm -rf "$KWIN_SCRIPTS_DIR/infinite-tiling"
cp -r "$SCRIPT_SRC" "$KWIN_SCRIPTS_DIR/infinite-tiling"

echo "Installing Tiling Focus Border effect..."
rm -rf "$KWIN_EFFECTS_DIR/tiling-focus-border"
cp -r "$EFFECT_SRC" "$KWIN_EFFECTS_DIR/tiling-focus-border"

if [ "$1" != "--no-wheel" ]; then
    if [ "$(uname -s)" = "Linux" ] && [ -n "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
        echo "Installing X11 wheel bridge..."
        mkdir -p "$BIN_DIR" "$AUTOSTART_DIR"
        cp "$WHEEL_SRC" "$BIN_DIR/kwin-infinite-tiling-wheel.py"
        chmod +x "$BIN_DIR/kwin-infinite-tiling-wheel.py"
        cp "$WHEEL_DESKTOP" "$AUTOSTART_DIR/kwin-infinite-tiling-wheel.desktop"
        if ! command -v xdotool >/dev/null 2>&1; then
            echo "WARNING: xdotool is not installed. Install it for wheel scrolling:"
            echo "  Debian/Ubuntu: sudo apt install xdotool"
            echo "  Arch:          sudo pacman -S xdotool"
        fi
        if ! python3 -c "import Xlib" >/dev/null 2>&1; then
            echo "WARNING: python-xlib is not installed. Install it for wheel scrolling:"
            echo "  Debian/Ubuntu: sudo apt install python3-xlib"
            echo "  Arch:          sudo pacman -S python-xlib"
        fi
    else
        echo "Skipping wheel bridge (Wayland or headless session): keyboard shortcuts only."
    fi
fi

echo ""
echo "Installed. Next steps:"
echo "  1. Enable the script: System Settings -> Window Management -> KWin Scripts"
echo "     -> 'Infinite Tiling' -> enable. (Or: qdbus org.kde.KWin /Scripting \\"
echo "        org.kde.kwin.Scripting.loadScript $KWIN_SCRIPTS_DIR/infinite-tiling)"
echo "  2. Enable the effect: System Settings -> Window Management -> KWin Effects"
echo "     -> 'Tiling Focus Border' -> enable."
echo "  3. Disable KWin's default Meta+Arrow quick-tile shortcuts if they conflict:"
echo "     System Settings -> Shortcuts -> KWin -> Window Quick Tile."
echo "  4. If Plasma 6.3+'s built-in tiling is enabled, disable it to avoid conflicts."
echo ""
echo "Restart KWin (log out/in, or 'kwin --replace' on X11) if the script is not picked up."
