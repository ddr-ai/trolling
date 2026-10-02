# Infinite Tiling for KWin

Turns your KDE Plasma desktop into a **tiling and scrolling** workspace: all
normal windows are tiled on an **infinite 2D canvas** that you can scroll
**horizontally and vertically without bounds**.

- Grid layout that chains right, then wraps to the next row
- Windows start at **50% screen width × full screen height** and are resizable
- Custom sizes/positions are **remembered** on the canvas (drag/resize freely)
- **Infinite scrolling** in both axes via keyboard shortcuts (X11 + Wayland)
  and, on X11, via the mouse wheel over the desktop background
- **Zoom out** to see all windows at once (`Meta+0`)
- **Reorder** windows with shortcuts or by dragging them anywhere
- **Auto-pan** keeps the focused window comfortably in view
- Thin **focus-border highlight** around the active window (companion effect)

## Components

| Component | Path | Purpose |
|---|---|---|
| Tiling script | `infinite-tiling/` | The tiling engine (KWin script) |
| Focus-border effect | `tiling-focus-border/` | Paints the active-window border (KWin QML effect) |
| Wheel bridge | `kwin-infinite-tiling-wheel.py` | Forwards wheel-over-desktop to the script (X11 only) |
| Installer | `install.sh` | Copies everything into place |

## Installation

```sh
./install.sh              # install everything (wheel bridge only on X11)
./install.sh --no-wheel   # skip the wheel bridge
./install.sh --uninstall  # remove everything
```

Then:

1. Enable the script: **System Settings → Window Management → KWin Scripts →
   "Infinite Tiling" → enable** (or
   `qdbus org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript ~/.local/share/kwin/scripts/infinite-tiling`).
2. Enable the effect: **System Settings → Window Management → KWin Effects →
   "Tiling Focus Border" → enable**.
3. **Disable KWin's default `Meta+Arrow` quick-tile shortcuts** if they
   conflict: *System Settings → Shortcuts → KWin → Window Quick Tile*.
4. If Plasma 6.3+'s built-in tiling is enabled, disable it to avoid conflicts.
5. Restart KWin (log out/in, or `kwin --replace` on X11) if not picked up.

Wheel bridge requirements (X11 only): `python3-xlib` and `xdotool`.
On Wayland, wheel scrolling is not feasible — use the keyboard shortcuts.

## Shortcuts

All shortcuts are registered by the script and can be rebound in
*System Settings → Shortcuts*.

| Action | Default |
|---|---|
| Scroll one cell | `Meta+←/→/↑/↓` |
| Page scroll (one viewport) | `Meta+Shift+←/→/↑/↓` |
| Move/swap active window | `Meta+Ctrl+←/→/↑/↓` |
| Zoom in / out | `Meta+=` / `Meta+-` |
| Zoom to fit all windows | `Meta+0` |
| Reset zoom | `Meta+1` |
| Scroll back to origin | `Meta+Home` |
| Toggle tiling on/off | `Meta+Ctrl+T` |

## Configuration

Edit the script's config values (defaults shown). On most setups the script's
config file lives at
`~/.local/share/kwin/scripts/infinite-tiling/contents/config` — if that file
does not exist, the defaults below are used.

| Key | Default | Meaning |
|---|---|---|
| `cellWidthFraction` | `0.5` | Cell width as a fraction of the virtual screen |
| `cellHeightFraction` | `1.0` | Cell height as a fraction of the virtual screen |
| `autoPan` | `true` | Pan the viewport to the focused window |
| `autoPanMode` | `minimal` | `minimal` (bring into view) or `center` |
| `scrollStep` | `1` | Cells scrolled per scroll keypress |

Effect config: `borderColor` (default `#3daee9`), `borderWidth` (default `2`).

## How it works

- The canvas is an unbounded 2D grid. Cell = 50% virtual-screen width ×
  full virtual-screen height, so two windows sit side by side by default.
- New windows **chain after the last placed window** (conveyor belt): the
  first free cell scanning right, then wrapping to the next row. Closed
  windows leave permanent holes.
- Coordinate mapping: `screen = (canvas − scroll) × zoom`. Windows scrolled
  out of view simply land off-screen and return when scrolled back.
- Dragging or resizing a window records its new canvas position
  (`canvas = scroll + screen / zoom`); the window keeps its reserved grid
  slot for chain placement and neighbor swapping.
- Maximized/fullscreen windows float; they rejoin the grid at their stored
  canvas rect when restored.
- Scroll offset and zoom persist across script reloads. Window→cell
  assignments are recomputed on load (KWin window ids are per-session).

## Validation checklist

1. Open 6+ windows → 2-column grid chaining right, then down; new windows
   appear after the last one.
2. `Meta+Arrows` scroll in all 4 directions, including past the origin
   (negative) — scrolling is unbounded.
3. Resize a window, scroll away and back → custom size preserved.
4. Drag a window elsewhere, scroll → it stays at its new canvas position.
5. `Meta+Ctrl+Arrows` swaps windows; `Meta+-` zooms out; `Meta+0` fits all;
   `Meta+1` resets.
6. Maximize a window → it floats full-screen; unmaximize → returns to its
   canvas rect.
7. Focus an off-screen window via the taskbar or `Alt+Tab` → the viewport
   auto-pans to it.
8. `Meta+Ctrl+T` → all windows restored to their pre-tiling geometry.
9. Reload the script → scroll position and zoom restored.
10. X11: wheel over the desktop scrolls; wheel over applications is
    unaffected.
11. The focus-border effect draws a thin border around the active window and
    follows it.

## Known limitations

- KWin may clamp fully off-screen windows on some events (especially
  Wayland); the script re-applies geometry on all relevant signals, so
  windows return correctly when scrolled back to.
- Deep zoom makes windows very small; KWin enforces minimum window sizes.
- The focus-border effect needs a KWin version where the QML effect context
  exposes the active client (`workspace.activeClient` or
  `effects.activeClient`); if neither is available the border stays hidden
  and the tiling itself is unaffected.
- Multi-monitor: one canvas spans the whole virtual screen.
