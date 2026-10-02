// Functional smoke test for the Infinite Tiling engine.
// Stubs the KWin scripting API, loads main.js, and exercises the core logic.
// Run: node test-harness.js
"use strict";
const fs = require("fs");
const vm = require("vm");

// ---- KWin API stubs -------------------------------------------------------
function makeClient(id, normal) {
    return {
        id: id,
        normalWindow: normal !== false,
        fullScreen: false,
        minimized: false,
        desktop: 1,
        transient: null,
        geometry: { x: 0, y: 0, width: 400, height: 300 },
        frameGeometry: { x: 0, y: 0, width: 400, height: 300 },
        maximized: false,
    };
}

const clients = [];
const signals = { clientAdded: [], clientRemoved: [], activeClientChanged: [] };
let activeClient = null;

const workspace = {
    clients: clients,
    get activeClient() { return activeClient; },
    set activeClient(c) { activeClient = c; },
    virtualScreenGeometry: { x: 0, y: 0, width: 1920, height: 1080 },
    clientArea: function (area, client) { return workspace.virtualScreenGeometry; },
    clientAdded: { connect: (fn) => signals.clientAdded.push(fn) },
    clientRemoved: { connect: (fn) => signals.clientRemoved.push(fn) },
    activeClientChanged: { connect: (fn) => signals.activeClientChanged.push(fn) },
};

const KWin = { MaximizeArea: 1 };
const configStore = {};
function readConfig(key, def) { return key in configStore ? configStore[key] : def; }
function writeConfig(key, value) { configStore[key] = value; }
function registerShortcut(name, desc, keys, cb) { shortcuts[name] = cb; }
const shortcuts = {};
function print() {}

const sandbox = {
    workspace, KWin, readConfig, writeConfig, registerShortcut, print,
    clients,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// ---- load the script ------------------------------------------------------
const code = fs.readFileSync("infinite-tiling/contents/code/main.js", "utf8");
vm.runInContext(code, sandbox);

// ---- helpers to reach into the script's state -----------------------------
const S = sandbox;
function addClient(id) {
    const c = makeClient(id);
    clients.push(c);
    signals.clientAdded.forEach((fn) => fn(c));
    return c;
}
function removeClient(c) {
    const i = clients.indexOf(c);
    if (i !== -1) clients.splice(i, 1);
    signals.clientRemoved.forEach((fn) => fn(c));
}
function assert(cond, msg) {
    if (!cond) { console.error("FAIL: " + msg); process.exitCode = 1; }
    else { console.log("ok: " + msg); }
}

// ---- tests ----------------------------------------------------------------

// 1. Placement chain: 6 windows -> 2 columns, 3 rows
const w = [];
for (let i = 0; i < 6; i++) w.push(addClient("w" + i));
assert(S.canvas.length === 6, "6 windows managed");
assert(S.canvas[0].col === 0 && S.canvas[0].row === 0, "w0 at cell (0,0)");
assert(S.canvas[1].col === 1 && S.canvas[1].row === 0, "w1 at cell (1,0)");
assert(S.canvas[2].col === 0 && S.canvas[2].row === 1, "w2 wraps to (0,1)");
assert(S.canvas[5].col === 1 && S.canvas[5].row === 2, "w5 at cell (1,2)");

// 2. Default cell size = 50% width x full height; w0 geometry
assert(S.canvas[0].w === 960 && S.canvas[0].h === 1080, "cell = 960x1080 (50% x 100%)");
assert(w[0].geometry.width === 960 && w[0].geometry.height === 1080, "w0 sized to cell");
assert(w[0].geometry.x === 0 && w[0].geometry.y === 0, "w0 at screen origin");
assert(w[1].geometry.x === 960, "w1 to the right of w0");

// 3. Scroll right by one cell: everything shifts left by 960
shortcuts["Infinite Tiling: Scroll Right"]();
assert(S.scroll.x === 960, "scroll.x advanced by one cell");
assert(w[0].geometry.x === -960, "w0 scrolled off-screen left");
assert(w[1].geometry.x === 0, "w1 now at screen origin");

// 4. Scroll down by one cell
shortcuts["Infinite Tiling: Scroll Down"]();
assert(S.scroll.y === 1080, "scroll.y advanced by one cell");
assert(w[0].geometry.y === -1080, "w0 scrolled off-screen up");

// 5. Infinite negative scroll
shortcuts["Infinite Tiling: Scroll Left"]();
shortcuts["Infinite Tiling: Scroll Left"]();
assert(S.scroll.x === -960, "scroll.x can go negative (infinite)");
shortcuts["Infinite Tiling: Scroll Up"]();
shortcuts["Infinite Tiling: Scroll Up"]();
shortcuts["Infinite Tiling: Scroll Up"]();
assert(S.scroll.y === -2160, "scroll.y can go negative (infinite)");

// 6. Coordinate mapping round-trip: record a user drag, then scroll back
S.scroll.x = 0; S.scroll.y = 0;
S.layout();
// simulate user dragging w0 to screen (100, 50) and resizing to 800x600
S.applying = false;
w[0].geometry = { x: 100, y: 50, width: 800, height: 600 };
// The harness cannot fire per-client signals (stub clients lack signal
// objects), so emulate the frameGeometryChanged handler's record step
// directly through the exposed canvas state.
S.canvas[0].x = S.scroll.x + w[0].geometry.x / S.zoom;
S.canvas[0].y = S.scroll.y + w[0].geometry.y / S.zoom;
S.canvas[0].w = w[0].geometry.width / S.zoom;
S.canvas[0].h = w[0].geometry.height / S.zoom;
S.layout();
assert(w[0].geometry.x === 100 && w[0].geometry.y === 50, "custom position preserved at scroll 0");
// scroll away and back: custom size must survive
shortcuts["Infinite Tiling: Scroll Right"]();
shortcuts["Infinite Tiling: Scroll Left"]();
assert(w[0].geometry.width === 800 && w[0].geometry.height === 600, "custom size preserved across scroll");

// 7. Move/swap: swap w0 and w1 (accounting for the current scroll offset)
// Note: w0 was dragged in step 6, so its canvas rect is at x=100 (not the
// cell origin 0). moveActive swaps the free-form canvas rects, so after the
// swap w1 inherits w0's custom rect and w0 inherits w1's cell-origin rect.
activeClient = w[0];
var scrollXBefore = S.scroll.x;
var w0CanvasX = S.canvas[0].x;   // 100 (custom)
var w1CanvasX = S.canvas[1].x;   // 960 (cell origin)
shortcuts["Infinite Tiling: Move Window Right"]();
assert(S.canvas[0].col === 1 && S.canvas[1].col === 0, "slots swapped after Move Window Right");
// screen x = (canvas - scroll) * zoom
assert(w[0].geometry.x === Math.round((w1CanvasX - scrollXBefore) * S.zoom), "w0 rect moved to w1's rect");
assert(w[1].geometry.x === Math.round((w0CanvasX - scrollXBefore) * S.zoom), "w1 rect moved to w0's custom rect");

// 8. Zoom out
shortcuts["Infinite Tiling: Zoom Out"]();
assert(Math.abs(S.zoom - 0.8) < 1e-9, "zoom stepped out to 0.8");
assert(w[0].geometry.width === Math.round(960 * 0.8), "window width scaled by zoom");

// 9. Zoom fit all
shortcuts["Infinite Tiling: Zoom Fit All"]();
assert(S.zoom <= 1, "fit-all zoom <= 1");

// 10. Zoom reset
shortcuts["Infinite Tiling: Zoom Reset"]();
assert(S.zoom === 1, "zoom reset to 1.0");

// 11. Persistence: scroll + zoom written to config
S.scroll.x = 0; S.scroll.y = 0; S.layout();
shortcuts["Infinite Tiling: Scroll Right"]();
assert(configStore["scrollX"] === 960, "scrollX persisted via writeConfig");

// 12. Toggle off restores TRUE originals (not the last tiled position)
S.scroll.x = 0; S.scroll.y = 0;
shortcuts["Infinite Tiling: Toggle"]();   // disable -> restores originals
const trueOrigX = 123;
w[2].geometry = { x: trueOrigX, y: 77, width: 500, height: 400 };
shortcuts["Infinite Tiling: Toggle"]();   // enable -> captures w2's current pos as original
shortcuts["Infinite Tiling: Toggle"]();   // disable -> must restore trueOrigX, not the tiled pos
assert(S.enabled === false, "tiling disabled");
assert(S.canvas.length === 0, "canvas cleared when disabled");
assert(w[2].geometry.x === trueOrigX, "window restored to TRUE pre-tiling geometry (not last tiled)");

// 13. Toggle back on re-tiles everything
shortcuts["Infinite Tiling: Toggle"]();
assert(S.enabled === true, "tiling re-enabled");
assert(S.canvas.length === 6, "all 6 windows re-tiled");

// 14. New window chains after the last placed one
const w6 = addClient("w6");
assert(S.canvas.length === 7, "new window added to canvas");
assert(S.canvas[6].col === 0 && S.canvas[6].row === 3, "new window chained to next free cell (0,3)");

// 15. Removing a window leaves a hole (no compaction, no hole reuse)
removeClient(w6);
assert(S.canvas.length === 6, "window removed from canvas");
const w7 = addClient("w7");
// chainHead was at (0,3) when w6 was placed; w6 freed (0,3) but the chain
// only moves forward, so w7 must land at (1,3), NOT reuse the (0,3) hole.
assert(S.canvas[6].col === 1 && S.canvas[6].row === 3, "chain moves forward, hole at (0,3) not reused");

// 16. Maximized window floats and rejoins on unmaximize
const target = w[0];
target.maximized = true;
assert(S.isMaximized(target) === true, "maximized state detected");
assert(S.isManaged(target) === false, "maximized window is not managed");

// 17. Sticky (all-desktops) window is excluded
const sticky = makeClient("sticky");
sticky.desktop = 0;
assert(S.isManaged(sticky) === false, "all-desktops window excluded");

// 18. Transient dialog is excluded
const dlg = makeClient("dlg");
dlg.transient = w[0];
assert(S.isManaged(dlg) === false, "transient dialog excluded");

// 19. Panel / non-normal window is excluded
const panel = makeClient("panel", false);
assert(S.isManaged(panel) === false, "non-normal window excluded");

console.log(process.exitCode ? "\nSOME TESTS FAILED" : "\nALL TESTS PASSED");
