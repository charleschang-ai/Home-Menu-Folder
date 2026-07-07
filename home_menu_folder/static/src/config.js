/**
 * Home menu folder configuration helpers.
 *
 * The layout is persisted in `res.users.settings.homemenu_config` (a JSON
 * field). We upgrade the stored shape from the legacy flat array of xmlids to:
 *
 *   { "version": 2, "items": [
 *       { "type": "app",    "xmlid": "sale.menu_root" },
 *       { "type": "folder", "id": "f123", "name": "Finance",
 *         "apps": ["account.menu_root", "purchase.menu_root"] }
 *   ]}
 *
 * We only ever store xmlids (stable across databases/upgrades), never db ids.
 */

/**
 * Normalize whatever is stored in `homemenu_config` into `{ version, items }`.
 * Accepts: null, a JSON string, a legacy array of xmlids, or the v2 object.
 */
export function parseConfig(raw) {
    let data = raw;
    if (typeof raw === "string") {
        try {
            data = JSON.parse(raw);
        } catch {
            data = null;
        }
    }
    // Legacy format: a flat, ordered list of app xmlids.
    if (Array.isArray(data)) {
        return { version: 2, items: data.map((xmlid) => ({ type: "app", xmlid })) };
    }
    if (data && Array.isArray(data.items)) {
        return { version: 2, items: data.items };
    }
    return { version: 2, items: [] };
}

/**
 * Build the ordered render list from the live app objects and the stored
 * config. Each returned entry is either:
 *   { type: "app", app }                       (app object from menu tree)
 *   { type: "folder", id, name, apps: [app] }  (resolved app objects)
 *
 * Apps referenced by the config but no longer installed are skipped; apps that
 * exist but are absent from the config are appended as loose tiles (matching
 * the native behaviour for freshly installed apps).
 */
export function buildItems(apps, config) {
    const byXmlid = new Map(apps.map((a) => [a.xmlid, a]));
    const used = new Set();
    const items = [];

    for (const entry of config.items) {
        if (entry.type === "folder") {
            const folderApps = [];
            for (const xmlid of entry.apps || []) {
                const app = byXmlid.get(xmlid);
                if (app && !used.has(xmlid)) {
                    folderApps.push(app);
                    used.add(xmlid);
                }
            }
            // Drop folders that became empty (all their apps were uninstalled).
            if (folderApps.length) {
                items.push({
                    type: "folder",
                    id: entry.id || makeFolderId(),
                    name: entry.name || "",
                    apps: folderApps,
                });
            }
        } else {
            const app = byXmlid.get(entry.xmlid);
            if (app && !used.has(entry.xmlid)) {
                items.push({ type: "app", app });
                used.add(entry.xmlid);
            }
        }
    }

    // Append any installed app not yet placed anywhere, in its natural order.
    for (const app of apps) {
        if (!used.has(app.xmlid)) {
            items.push({ type: "app", app });
            used.add(app.xmlid);
        }
    }
    return items;
}

/** Serialize the live render list back into a storable v2 config object. */
export function serializeItems(items) {
    return {
        version: 2,
        items: items.map((it) =>
            it.type === "folder"
                ? {
                      type: "folder",
                      id: it.id,
                      name: it.name || "",
                      apps: it.apps.map((a) => a.xmlid),
                  }
                : { type: "app", xmlid: it.app.xmlid }
        ),
    };
}

/** Generate a stable-enough unique folder id (browser context). */
export function makeFolderId() {
    return "f" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
}
