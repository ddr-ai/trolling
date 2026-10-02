/*
 * Infinite Tiling — KWin script
 *
 * Tiles all normal windows on an infinite 2D canvas. The viewport (your
 * screen) is a window onto that canvas and can be panned infinitely in both
 * axes with keyboard shortcuts (and, on X11, with the companion wheel
 * bridge helper).
 *
 * Coordinate model
 *   canvas units  = screen pixels at zoom 1.0
 *   apply:   screen = (canvas - scroll) * zoom
 *   record:  canvas = scroll + screen / zoom
 *
 * Windows scrolled out of view simply land off-screen; they return when
 * scrolled back. No parking logic is required.
 *
 * Configuration keys (written via the script's config, see README):
 *   cellWidthFraction   default 0.5   (cell = 50% of virtual screen width)
 *   cellHeightFraction  default 1.0   (cell = full virtual screen height)
 *   autoPan             default true  (pan viewport to the focused window)
 *   autoPanMode         "minimal"|"center"  default "minimal"
 *   scrollStep          default 1     (cells per scroll keypress)
 *
 * Requires KWin 5.20+ / Plasma 6 (tested against the documented scripting
 * API; property names are probed defensively for Plasma 5 vs 6 differences).
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function readConfigValue(key, def) {
    try {
        var v = readConfig(key, def);
        return (v === undefined || v === null) ? def : v;
    } catch (e) {
        return def;
    }
}

function readBool(key, def) {
    var v = readConfigValue(key, def);
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v === "true";
    return def;
}

function readNumber(key, def) {
    var v = Number(readConfigValue(key, def));
    return isNaN(v) ? def : v;
}

var config = {
    cellWidthFraction: readNumber("cellWidthFraction", 0.5),
    cellHeightFraction: readNumber("cellHeightFraction", 1.0),
    autoPan: readBool("autoPan", true),
    autoPanMode: readConfigValue("autoPanMode", "minimal"),
    scrollStep: Math.max(1, Math.round(readNumber("scrollStep", 1))),
    zoomMin: 0.1,
    zoomMax: 2.0,
    zoomStep: 1.25
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// canvas: array of {client, col, row, x, y, w, h}
//   col/row = reserved grid slot (used for chain placement and swapping)
//   x/y/w/h = free-form canvas rect (diverges from the slot after a drag/resize)
var canvas = [];

// scroll offset in canvas units; unbounded => infinite scrolling, negative ok
var scroll = { x: 0, y: 0 };

// uniform zoom factor applied to the whole canvas mapping
var zoom = 1.0;

// chainHead: the highest cell ever handed out; the chain only moves forward
var chainHead = { col: -1, row: 0 };

// pre-tiling geometries, for restore when tiling is disabled
var originals = [];

// clients currently floating (maximized / fullscreen / minimized)
var floating = [];

// guard flag: true while the script itself sets a geometry, so that the
// frameGeometryChanged handler can tell script-driven changes from user drags
var applying = false;

var enabled = true;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function findEntry(client) {
    for (var i = 0; i < canvas.length; i++) {
        if (canvas[i].client === client) return canvas[i];
    }
    return null;
}

function findEntryAt(col, row) {
    for (var i = 0; i < canvas.length; i++) {
        if (canvas[i].col === col && canvas[i].row === row) return canvas[i];
    }
    return null;
}

function removeEntry(client) {
    for (var i = 0; i < canvas.length; i++) {
        if (canvas[i].client === client) {
            canvas.splice(i, 1);
            return true;
        }
    }
    return false;
}

function findOriginal(client) {
    for (var i = 0; i < originals.length; i++) {
        if (originals[i].client === client) return originals[i];
    }
    return null;
}

function removeOriginal(client) {
    for (var i = 0; i < originals.length; i++) {
        if (originals[i].client === client) {
            originals.splice(i, 1);
            return true;
        }
    }
    return false;
}

function isFloating(client) {
    return floating.indexOf(client) !== -1;
}

function setFloating(client, value) {
    var i = floating.indexOf(client);
    if (value && i === -1) floating.push(client);
    if (!value && i !== -1) floating.splice(i, 1);
}

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------------------
// KWin API compatibility shims
//
// Property names differ between Plasma 5 and Plasma 6 and are probed
// defensively so the script degrades gracefully instead of throwing.
// ---------------------------------------------------------------------------

function virtualScreenGeometry() {
    try {
        if (workspace.virtualScreenGeometry) return workspace.virtualScreenGeometry;
    } catch (e) { /* not available */ }
    try {
        var c = workspace.activeClient;
        if (!c && workspace.clients.length > 0) c = workspace.clients[0];
        if (c) return workspace.clientArea(KWin.MaximizeArea, c);
    } catch (e) { /* not available */ }
    return { x: 0, y: 0, width: 1920, height: 1080 };
}

function isMaximized(client) {
    try {
        if (typeof client.maximized === "boolean") return client.maximized;
    } catch (e) { /* property not exposed */ }
    return false;
}

function isOnAllDesktops(client) {
    try {
        if (typeof client.isOnAllDesktops === "function") return client.isOnAllDesktops();
        if (typeof client.isOnAllDesktops === "boolean") return client.isOnAllDesktops;
        if (typeof client.onAllDesktops === "boolean") return client.onAllDesktops;
    } catch (e) { /* not exposed */ }
    // KWin scripting: client.desktop is 1-based and 0 means "on all desktops"
    try {
        return client.desktop === 0;
    } catch (e) {
        return false;
    }
}

function isTransientDialog(client) {
    try {
        if (client.transient) return true;
    } catch (e) { /* not exposed */ }
    try {
        if (typeof client.transientFor === "function" && client.transientFor()) return true;
    } catch (e) { /* not exposed */ }
    return false;
}

// ---------------------------------------------------------------------------
// Window classification
// ---------------------------------------------------------------------------

function isManaged(client) {
    if (!client) return false;
    try {
        if (!client.normalWindow) return false;      // excludes docks, panels, splash, toolbars
        if (client.fullScreen) return false;         // fullscreen windows float
        if (isMaximized(client)) return false;       // maximized windows float
        if (isOnAllDesktops(client)) return false;   // sticky windows would tile on every desktop
        if (isTransientDialog(client)) return false; // dialogs/popups keep default behavior
    } catch (e) {
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Geometry mapping
// ---------------------------------------------------------------------------

function cellSize() {
    var vs = virtualScreenGeometry();
    return {
        w: Math.max(50, Math.round(vs.width * config.cellWidthFraction)),
        h: Math.max(50, Math.round(vs.height * config.cellHeightFraction))
    };
}

function cellsPerRow() {
    var vs = virtualScreenGeometry();
    var cw = cellSize().w;
    return Math.max(1, Math.round(vs.width / cw));
}

function applyGeometry(client) {
    var entry = findEntry(client);
    if (!entry) return;
    try {
        if (client.fullScreen || isMaximized(client) || client.minimized) return;
    } catch (e) { /* minimized not exposed: ignore */ }
    applying = true;
    try {
        client.geometry = {
            x: Math.round((entry.x - scroll.x) * zoom),
            y: Math.round((entry.y - scroll.y) * zoom),
            width: Math.max(1, Math.round(entry.w * zoom)),
            height: Math.max(1, Math.round(entry.h * zoom))
        };
    } finally {
        applying = false;
    }
}

function recordCanvas(client) {
    var entry = findEntry(client);
    if (!entry) return;
    var g = client.geometry;
    entry.x = scroll.x + g.x / zoom;
    entry.y = scroll.y + g.y / zoom;
    entry.w = g.width / zoom;
    entry.h = g.height / zoom;
}

function layout() {
    for (var i = 0; i < canvas.length; i++) {
        applyGeometry(canvas[i].client);
    }
}

// ---------------------------------------------------------------------------
// Placement (chain: conveyor belt, no hole reuse)
// ---------------------------------------------------------------------------

function placeNewClient(client) {
    var size = cellSize();
    var perRow = cellsPerRow();
    var col = chainHead.col;
    var row = chainHead.row;
    do {
        col++;
        if (col >= perRow) { col = 0; row++; }
    } while (findEntryAt(col, row));
    canvas.push({
        client: client,
        col: col, row: row,
        x: col * size.w, y: row * size.h,
        w: size.w, h: size.h
    });
    chainHead.col = col;
    chainHead.row = row;
    applyGeometry(client);
}

// ---------------------------------------------------------------------------
// Scrolling / auto-pan / zoom
// ---------------------------------------------------------------------------

function scrollBy(dxCells, dyCells) {
    var size = cellSize();
    scroll.x += dxCells * size.w;
    scroll.y += dyCells * size.h;
    layout();
    saveState();
}

function pageScroll(dir) {
    var vs = virtualScreenGeometry();
    var size = cellSize();
    if (dir === "left")  scrollBy(-Math.max(1, Math.round(vs.width / size.w)), 0);
    if (dir === "right") scrollBy( Math.max(1, Math.round(vs.width / size.w)), 0);
    if (dir === "up")    scrollBy(0, -Math.max(1, Math.round(vs.height / size.h)));
    if (dir === "down")  scrollBy(0,  Math.max(1, Math.round(vs.height / size.h)));
}

function scrollToOrigin() {
    scroll.x = 0;
    scroll.y = 0;
    layout();
    saveState();
}

function autoPanTo(client) {
    if (!config.autoPan) return;
    var entry = findEntry(client);
    if (!entry) return;
    var vs = virtualScreenGeometry();
    var vw = vs.width / zoom;   // viewport size in canvas units
    var vh = vs.height / zoom;
    var wx = entry.x, wy = entry.y, ww = entry.w, wh = entry.h;
    var fullyVisible = wx >= scroll.x && wy >= scroll.y &&
                       wx + ww <= scroll.x + vw && wy + wh <= scroll.y + vh;
    if (fullyVisible) return;
    if (config.autoPanMode === "center") {
        scroll.x = wx + ww / 2 - vw / 2;
        scroll.y = wy + wh / 2 - vh / 2;
    } else {
        // minimal pan: bring the window fully into view, only where needed
        if (ww >= vw) scroll.x = wx + ww / 2 - vw / 2;
        else if (wx < scroll.x) scroll.x = wx;
        else if (wx + ww > scroll.x + vw) scroll.x = wx + ww - vw;
        if (wh >= vh) scroll.y = wy + wh / 2 - vh / 2;
        else if (wy < scroll.y) scroll.y = wy;
        else if (wy + wh > scroll.y + vh) scroll.y = wy + wh - vh;
    }
    layout();
}

function zoomBy(factor) {
    zoom = clamp(zoom * factor, config.zoomMin, config.zoomMax);
    layout();
    saveState();
}

function zoomFitAll() {
    if (canvas.length === 0) { zoomReset(); return; }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < canvas.length; i++) {
        var e = canvas[i];
        if (e.x < minX) minX = e.x;
        if (e.y < minY) minY = e.y;
        if (e.x + e.w > maxX) maxX = e.x + e.w;
        if (e.y + e.h > maxY) maxY = e.y + e.h;
    }
    var vs = virtualScreenGeometry();
    var bw = Math.max(1, maxX - minX);
    var bh = Math.max(1, maxY - minY);
    zoom = clamp(Math.min(1, vs.width / bw, vs.height / bh), config.zoomMin, config.zoomMax);
    // center the viewport on the bounding box of all windows
    scroll.x = minX + bw / 2 - (vs.width / zoom) / 2;
    scroll.y = minY + bh / 2 - (vs.height / zoom) / 2;
    layout();
    saveState();
}

function zoomReset() {
    zoom = 1.0;
    layout();
    saveState();
}

// ---------------------------------------------------------------------------
// Reordering
// ---------------------------------------------------------------------------

function moveActive(dir) {
    var client = workspace.activeClient;
    var entry = findEntry(client);
    if (!entry) return;
    var dcol = 0, drow = 0;
    if (dir === "left") dcol = -1;
    else if (dir === "right") dcol = 1;
    else if (dir === "up") drow = -1;
    else if (dir === "down") drow = 1;
    var other = findEntryAt(entry.col + dcol, entry.row + drow);
    if (other) {
        // swap canvas rects and reserved slots
        var tx = entry.x, ty = entry.y, tw = entry.w, th = entry.h;
        var tc = entry.col, tr = entry.row;
        entry.x = other.x; entry.y = other.y; entry.w = other.w; entry.h = other.h;
        entry.col = other.col; entry.row = other.row;
        other.x = tx; other.y = ty; other.w = tw; other.h = th;
        other.col = tc; other.row = tr;
        applyGeometry(entry.client);
        applyGeometry(other.client);
    } else {
        // empty neighbor: shift the window one cell over
        var size = cellSize();
        entry.x += dcol * size.w;
        entry.y += drow * size.h;
        entry.col += dcol;
        entry.row += drow;
        applyGeometry(entry.client);
    }
}

// ---------------------------------------------------------------------------
// Enable / disable
// ---------------------------------------------------------------------------

function enable() {
    enabled = true;
    canvas = [];
    floating = [];
    chainHead.col = -1;
    chainHead.row = 0;
    // assign cells to all currently managed windows, row-major from the origin.
    // originals are captured only once per client: a client that was already
    // tiled keeps its true pre-tiling geometry, so repeated toggles restore
    // the original positions rather than the last tiled ones.
    var clients = workspace.clients;
    var perRow = cellsPerRow();
    var col = 0, row = 0;
    var lastCol = -1, lastRow = 0;
    for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (!isManaged(client)) continue;
        if (!findOriginal(client)) {
            originals.push({ client: client, geometry: client.geometry });
        }
        var size = cellSize();
        canvas.push({
            client: client,
            col: col, row: row,
            x: col * size.w, y: row * size.h,
            w: size.w, h: size.h
        });
        wireClient(client);
        lastCol = col; lastRow = row;
        col++;
        if (col >= perRow) { col = 0; row++; }
    }
    chainHead.col = lastCol;
    chainHead.row = lastRow;
    layout();
}

function disable() {
    enabled = false;
    // restore every window to its pre-tiling geometry
    for (var i = 0; i < originals.length; i++) {
        var o = originals[i];
        applying = true;
        try {
            o.client.geometry = o.geometry;
        } finally {
            applying = false;
        }
    }
    canvas = [];
    originals = [];
    floating = [];
}

function toggle() {
    if (enabled) disable();
    else enable();
}

// ---------------------------------------------------------------------------
// Persistence (scroll offset + zoom only; window->cell assignments are
// recomputed on load because KWin window ids are per-session)
// ---------------------------------------------------------------------------

function saveState() {
    try {
        writeConfig("scrollX", scroll.x);
        writeConfig("scrollY", scroll.y);
        writeConfig("zoom", zoom);
    } catch (e) { /* config not writable */ }
}

function loadState() {
    scroll.x = Number(readConfigValue("scrollX", 0)) || 0;
    scroll.y = Number(readConfigValue("scrollY", 0)) || 0;
    zoom = clamp(Number(readConfigValue("zoom", 1)) || 1, config.zoomMin, config.zoomMax);
}

// ---------------------------------------------------------------------------
// Signal handlers
// ---------------------------------------------------------------------------

function onClientAdded(client) {
    if (!enabled || !isManaged(client)) return;
    if (!findOriginal(client)) {
        originals.push({ client: client, geometry: client.geometry });
    }
    placeNewClient(client);
    wireClient(client);
}

function onClientRemoved(client) {
    if (!enabled) return;
    removeEntry(client);
    removeOriginal(client);
    setFloating(client, false);
    saveState();
}

function onActiveClientChanged(client) {
    if (!enabled) return;
    autoPanTo(client);
}

function onClientFrameGeometryChanged(client) {
    if (!enabled || applying) return;
    if (!findEntry(client)) return;
    if (isFloating(client)) return;          // maximized/fullscreen/minimized: leave alone
    try {
        if (client.fullScreen) return;
    } catch (e) { /* ignore */ }
    recordCanvas(client);                    // user drag/resize: remember on the canvas
}

function onClientFullScreenChanged(client) {
    if (!enabled) return;
    if (!findEntry(client)) return;
    try {
        if (client.fullScreen) setFloating(client, true);
        else {
            setFloating(client, false);
            applyGeometry(client);           // re-apply the stored canvas rect
        }
    } catch (e) { /* ignore */ }
}

function onClientMaximizedChanged(client) {
    if (!enabled || applying) return;
    if (!findEntry(client)) return;
    if (isMaximized(client)) setFloating(client, true);
    else {
        setFloating(client, false);
        applyGeometry(client);               // re-apply the stored canvas rect
    }
}

function onClientDesktopChanged(client) {
    if (!enabled) return;
    var entry = findEntry(client);
    var managed = isManaged(client);
    if (managed && !entry) {
        // became manageable (e.g. un-stuck): place it on the canvas
        if (!findOriginal(client)) {
            originals.push({ client: client, geometry: client.geometry });
        }
        placeNewClient(client);
    } else if (!managed && entry) {
        // became sticky or dialog-like: unmanage, keep its current geometry
        removeEntry(client);
        removeOriginal(client);
        setFloating(client, false);
    }
}

function onScreenGeometryChanged() {
    if (!enabled) return;
    layout();
}

// ---------------------------------------------------------------------------
// Signal wiring (defensive: missing signals are simply skipped)
// ---------------------------------------------------------------------------

function safeConnect(obj, signal, handler) {
    try {
        var s = obj[signal];
        if (s && typeof s.connect === "function") {
            s.connect(handler);
            return true;
        }
    } catch (e) { /* signal not exposed */ }
    return false;
}

function wireClient(client) {
    safeConnect(client, "frameGeometryChanged", onClientFrameGeometryChanged);
    safeConnect(client, "fullScreenChanged", onClientFullScreenChanged);
    safeConnect(client, "maximizedChanged", onClientMaximizedChanged);
    safeConnect(client, "desktopChanged", onClientDesktopChanged);
}

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

function registerShortcuts() {
    registerShortcut("Infinite Tiling: Scroll Left",
                     "Scroll the tiling canvas one cell left",
                     "Meta+Left", function () { scrollBy(-config.scrollStep, 0); });
    registerShortcut("Infinite Tiling: Scroll Right",
                     "Scroll the tiling canvas one cell right",
                     "Meta+Right", function () { scrollBy(config.scrollStep, 0); });
    registerShortcut("Infinite Tiling: Scroll Up",
                     "Scroll the tiling canvas one cell up",
                     "Meta+Up", function () { scrollBy(0, -config.scrollStep); });
    registerShortcut("Infinite Tiling: Scroll Down",
                     "Scroll the tiling canvas one cell down",
                     "Meta+Down", function () { scrollBy(0, config.scrollStep); });

    registerShortcut("Infinite Tiling: Page Scroll Left",
                     "Scroll the tiling canvas one viewport left",
                     "Meta+Shift+Left", function () { pageScroll("left"); });
    registerShortcut("Infinite Tiling: Page Scroll Right",
                     "Scroll the tiling canvas one viewport right",
                     "Meta+Shift+Right", function () { pageScroll("right"); });
    registerShortcut("Infinite Tiling: Page Scroll Up",
                     "Scroll the tiling canvas one viewport up",
                     "Meta+Shift+Up", function () { pageScroll("up"); });
    registerShortcut("Infinite Tiling: Page Scroll Down",
                     "Scroll the tiling canvas one viewport down",
                     "Meta+Shift+Down", function () { pageScroll("down"); });

    registerShortcut("Infinite Tiling: Move Window Left",
                     "Move the active window one cell left (swaps with the neighbor)",
                     "Meta+Ctrl+Left", function () { moveActive("left"); });
    registerShortcut("Infinite Tiling: Move Window Right",
                     "Move the active window one cell right (swaps with the neighbor)",
                     "Meta+Ctrl+Right", function () { moveActive("right"); });
    registerShortcut("Infinite Tiling: Move Window Up",
                     "Move the active window one cell up (swaps with the neighbor)",
                     "Meta+Ctrl+Up", function () { moveActive("up"); });
    registerShortcut("Infinite Tiling: Move Window Down",
                     "Move the active window one cell down (swaps with the neighbor)",
                     "Meta+Ctrl+Down", function () { moveActive("down"); });

    registerShortcut("Infinite Tiling: Zoom In",
                     "Zoom the tiling canvas in",
                     "Meta+=", function () { zoomBy(config.zoomStep); });
    registerShortcut("Infinite Tiling: Zoom Out",
                     "Zoom the tiling canvas out",
                     "Meta+-", function () { zoomBy(1 / config.zoomStep); });
    registerShortcut("Infinite Tiling: Zoom Fit All",
                     "Zoom out so all tiled windows are visible",
                     "Meta+0", function () { zoomFitAll(); });
    registerShortcut("Infinite Tiling: Zoom Reset",
                     "Reset the tiling canvas zoom to 100%",
                     "Meta+1", function () { zoomReset(); });

    registerShortcut("Infinite Tiling: Scroll To Origin",
                     "Scroll the tiling canvas back to the origin",
                     "Meta+Home", function () { scrollToOrigin(); });

    registerShortcut("Infinite Tiling: Toggle",
                     "Enable or disable infinite tiling (restores window positions)",
                     "Meta+Ctrl+T", function () { toggle(); });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

loadState();
registerShortcuts();

workspace.clientAdded.connect(onClientAdded);
workspace.clientRemoved.connect(onClientRemoved);
workspace.activeClientChanged.connect(onActiveClientChanged);

// re-tile when the screen layout changes (multi-monitor, resolution change)
safeConnect(workspace, "virtualScreenGeometryChanged", onScreenGeometryChanged);
safeConnect(workspace, "screenAdded", onScreenGeometryChanged);
safeConnect(workspace, "screenRemoved", onScreenGeometryChanged);

enable();
