import QtQuick 2.15

/*
 * Tiling Focus Border — KWin QML effect
 *
 * Paints a thin highlight border around the active window and follows it as
 * it moves, resizes, or as the Infinite Tiling canvas scrolls.
 *
 * The active client is resolved through a fallback chain, because the set of
 * context properties available to QML effects varies between KWin versions:
 *   1. workspace.activeClient  (scripting API exposed to the effect context)
 *   2. effects.activeClient    (EffectsHandler, if it exposes the active client)
 * If neither is available the border stays hidden and the tiling script keeps
 * working unaffected.
 *
 * Configuration (edit in the effect's config, see README):
 *   borderColor  default "#3daee9"
 *   borderWidth  default 2
 */

Item {
    id: root

    property color borderColor: readConfigValue("borderColor", "#3daee9")
    property int borderWidth: Math.max(1, Math.round(readConfigValue("borderWidth", 2)))

    // The border item; positioned over the active client's frame geometry.
    Rectangle {
        id: border
        color: "transparent"
        border.color: root.borderColor
        border.width: root.borderWidth
        visible: false
    }

    // Poll the active client and its geometry. Effects have no paint callback
    // requirement here; a short interval keeps the border in sync with the
    // tiling script's geometry changes (scrolling, zooming, swapping).
    Timer {
        interval: 100
        running: true
        repeat: true
        onTriggered: updateBorder()
    }

    function readConfigValue(key, def) {
        try {
            var v = readConfig(key, def);
            return (v === undefined || v === null) ? def : v;
        } catch (e) {
            return def;
        }
    }

    function activeClient() {
        try {
            if (typeof workspace !== "undefined" && workspace.activeClient) {
                return workspace.activeClient;
            }
        } catch (e) { /* workspace not exposed to this effect */ }
        try {
            if (typeof effects !== "undefined" && effects.activeClient) {
                return effects.activeClient;
            }
        } catch (e) { /* effects handler does not expose the active client */ }
        return null;
    }

    function updateBorder() {
        var client = activeClient();
        if (!client) {
            border.visible = false;
            return;
        }
        var g = null;
        try {
            g = client.frameGeometry;
        } catch (e) {
            try { g = client.geometry; } catch (e2) { g = null; }
        }
        if (!g || g.width <= 0 || g.height <= 0) {
            border.visible = false;
            return;
        }
        border.x = g.x;
        border.y = g.y;
        border.width = g.width;
        border.height = g.height;
        border.visible = true;
    }
}
