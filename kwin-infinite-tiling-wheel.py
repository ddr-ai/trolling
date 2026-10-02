#!/usr/bin/env python3
"""
kwin-infinite-tiling-wheel.py — X11 mouse-wheel bridge for the
"Infinite Tiling" KWin script.

KWin scripts cannot grab the mouse wheel, so this helper observes wheel
events with the X11 RECORD extension (a passive tap: it never interferes
with normal event delivery) and, when the pointer is over the desktop
background (the root window), synthesizes the tiling script's scroll
shortcut with xdotool. Wheel events over applications are ignored, so
normal scrolling inside windows is untouched.

Requirements:
    python3 with python-xlib (Debian: python3-xlib, Arch: python-xlib)
    xdotool

Usage:
    python3 kwin-infinite-tiling-wheel.py            # run in foreground
    # or autostart via the provided .desktop entry

Configuration (environment variables):
    WHEEL_SCROLL_KEY      base shortcut name, default "Meta+"
                          directions are appended: Left/Right/Up/Down
    WHEEL_DEBUG           set to "1" to log events to stderr

Button mapping:
    4 = wheel up      -> scroll up
    5 = wheel down    -> scroll down
    6 = wheel left    -> scroll left
    7 = wheel right   -> scroll right
"""

import os
import subprocess
import sys

try:
    from Xlib.display import Display
    from Xlib import X
    from Xlib.ext import record
    from Xlib.protocol import rq
except ImportError:
    sys.stderr.write(
        "kwin-infinite-tiling-wheel: python-xlib is not installed.\n"
        "  Debian/Ubuntu: sudo apt install python3-xlib xdotool\n"
        "  Arch:          sudo pacman -S python-xlib xdotool\n"
        "  Fedora:        sudo dnf install python3-xlib xdotool\n"
    )
    sys.exit(1)

DEBUG = os.environ.get("WHEEL_DEBUG", "") == "1"

# Wheel button -> scroll direction
BUTTON_DIR = {
    4: "Up",
    5: "Down",
    6: "Left",
    7: "Right",
}

# Base shortcut; the direction is appended, e.g. "Meta+Left" / "Meta+Right".
# These must match the registerShortcut() names in the Infinite Tiling script.
SCROLL_KEY_BASE = os.environ.get("WHEEL_SCROLL_KEY", "Meta+")


def log(msg):
    if DEBUG:
        sys.stderr.write("kwin-infinite-tiling-wheel: %s\n" % msg)


def pointer_on_root(display):
    """True when the pointer is over the root window (desktop background)."""
    root = display.screen().root
    try:
        # XQueryPointer returns (same_screen, child, root_x, root_y,
        # win_x, win_y, mask); child is the window under the pointer,
        # or the root window itself when over the desktop background.
        reply = root.query_pointer()
        child = reply.child
        return child == root or child == 0 or child is None
    except Exception as exc:  # pragma: no cover - defensive
        log("query_pointer failed: %s" % exc)
        return False


def synthesize_key(key):
    """Synthesize a keypress via xdotool (clears modifiers so the base
    shortcut fires exactly as registered in the KWin script)."""
    try:
        subprocess.run(
            ["xdotool", "key", "--clearmodifiers", key],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        log("synthesized key: %s" % key)
    except FileNotFoundError:
        sys.stderr.write(
            "kwin-infinite-tiling-wheel: xdotool not found. "
            "Install it (e.g. 'sudo apt install xdotool').\n"
        )
        sys.exit(1)
    except subprocess.CalledProcessError as exc:
        log("xdotool failed: %s" % exc)


def main():
    display = Display()
    root = display.screen().root

    ctx = display.record_create_context(
        [record.AllClients],
        [{
            "core_requests": (0, 0),
            "core_replies": (0, 0),
            "ext_requests": (0, 0, 0, 0),
            "ext_replies": (0, 0, 0, 0),
            "delivered_events": (0, 0),
            "device_events": (X.ButtonPress, X.ButtonPress),  # ButtonPress only
            "errors": (0, 0),
            "client_started": False,
            "client_died": False,
        }],
    )

    def callback(reply):
        if reply.category != record.FromServer:
            return
        if reply.client_swapped:
            log("* received swapped protocol data, ignored")
            return
        if not len(reply.data) or reply.data[0] < 2:
            # not an event (e.g. reply data from a request)
            return
        data = reply.data
        while len(data):
            event, data = rq.EventField(None).parse_binary_value(
                data, display.display, None, None
            )
            if event.type != X.ButtonPress:
                continue
            detail = getattr(event, "detail", 0)
            direction = BUTTON_DIR.get(detail)
            if direction is None:
                continue
            if not pointer_on_root(display):
                log("wheel %s over a window, ignored" % direction)
                continue
            key = SCROLL_KEY_BASE + direction
            log("wheel %s over desktop -> %s" % (direction, key))
            synthesize_key(key)

    log("started (X11 only; wheel over the desktop background scrolls the canvas)")
    display.record_enable_context(ctx, callback)
    display.record_free_context(ctx)


if __name__ == "__main__":
    main()
