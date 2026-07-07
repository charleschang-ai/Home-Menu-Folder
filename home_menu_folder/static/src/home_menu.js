/**
 * Patch the enterprise HomeMenu component to support iOS-style app folders.
 *
 * Interactions:
 *  - Drag an app onto the CENTER of another app/folder -> merge (create folder
 *    or add to it). The target highlights, tiles do NOT move away.
 *  - Drag over the EDGES of a tile -> reorder mode: a placeholder slot moves
 *    to show the insertion point (tiles shift, like a phone).
 *  - Click a folder                -> open an enlarged panel of its apps.
 *  - Inside the panel: reorder apps, or drag an app out to unpack it.
 *  - Rename a folder via its title input.
 *
 * The main grid uses the low-level `useDraggable` (NOT `useSortable`): the
 * sortable hook automatically shuffles siblings on hover, which makes hovering
 * a merge target impossible (the target dodges away). We do our own geometry
 * hit-testing instead — `document.elementFromPoint` is not an option because
 * the drag builder puts `pointer-events: none` on the whole body while
 * dragging.
 */
import { patch } from "@web/core/utils/patch";
import { HomeMenu } from "@web_enterprise/webclient/home_menu/home_menu";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { _t } from "@web/core/l10n/translation";
import { hasTouch, isIosApp } from "@web/core/browser/feature_detection";
import { useHotkey } from "@web/core/hotkeys/hotkey_hook";
import { useService } from "@web/core/utils/hooks";
import { useDraggable } from "@web/core/utils/draggable";
import { makeFolderId } from "./config";
import {
    onMounted,
    onWillUpdateProps,
    useEffect,
    useExternalListener,
    useRef,
    useState,
} from "@odoo/owl";

// Swap the template and relax the props to our folder-aware shape.
HomeMenu.template = "home_menu_folder.HomeMenu";
HomeMenu.props = {
    items: { type: Array },
    apps: { type: Array, optional: true },
    persist: { type: Function },
};

// Fraction of a tile (centered) that counts as the "merge" zone.
const MERGE_ZONE = 0.5;
// Hovering a dragged app over a folder for this long auto-opens it (iOS
// "spring loading"), so the app can be dropped at a precise position inside.
const SPRING_DELAY = 1000;
// Must match the o_folder_zoom_out animation duration in the SCSS.
const CLOSE_ANIMATION_MS = 180;

patch(HomeMenu.prototype, {
    setup() {
        this.command = useService("command");
        this.menus = useService("menu");
        this.homeMenuService = useService("home_menu");
        this.subscription = useService("enterprise_subscription");
        this.ui = useService("ui");
        this.orm = useService("orm");
        this.dialog = useService("dialog");
        this.notification = useService("notification");
        this._undoSnapshot = null; // one-shot undo for auto-organize
        this.state = useState({
            focusedIndex: null,
            isIosApp: isIosApp(),
            openFolder: null, // the folder item currently expanded in the panel
            folderClosing: false, // true while the close animation plays
        });
        this._zoomOrigin = null; // screen point the folder panel zooms from
        this.inputRef = useRef("input");
        this.rootRef = useRef("root");
        this.folderGridRef = useRef("folderGrid");
        this.folderPanelRef = useRef("folderPanel");

        // Live pointer position (used by the folder panel drag-out check, whose
        // onDrop does not expose coordinates).
        this._pointer = { x: 0, y: 0 };
        this._drag = null; // grid drag state

        if (!this.env.isSmall) {
            this._registerHotkeys();
        }

        useExternalListener(window, "pointermove", (ev) => {
            this._pointer.x = ev.clientX;
            this._pointer.y = ev.clientY;
        });

        // Anchor the folder panel's zoom animation on the tile that was
        // clicked (or spring-opened): set transform-origin right after render.
        useEffect(
            () => {
                const panel = this.folderPanelRef.el;
                if (panel && this._zoomOrigin) {
                    const rect = panel.getBoundingClientRect();
                    panel.style.transformOrigin = `${this._zoomOrigin.x - rect.left}px ${
                        this._zoomOrigin.y - rect.top
                    }px`;
                    this._zoomOrigin = null;
                }
            },
            () => [this.state.openFolder]
        );

        // Main grid: custom drag with merge/reorder zones.
        useDraggable({
            enable: () => !this.state.openFolder,
            ref: this.rootRef,
            elements: ".o_draggable",
            cursor: "move",
            delay: 500,
            tolerance: 10,
            onDragStart: (params) => this._gridDragStart(params),
            onDrag: (params) => this._gridDragMove(params),
            onDrop: () => this._gridDrop(),
            onDragEnd: () => this._gridDragEnd(),
        });

        // Folder panel: custom drag to reorder inside, or drag OUT of the
        // panel to unpack the app. NB: useSortable cannot do the latter — its
        // onDrop only fires when the placeholder moved between siblings, which
        // never happens when dragging straight out of the panel.
        this._folderDrag = null;
        useDraggable({
            enable: () => !!this.state.openFolder,
            ref: this.folderGridRef,
            elements: ".o_folder_draggable",
            cursor: "move",
            delay: 300,
            tolerance: 10,
            onDragStart: (params) => this._folderDragStart(params),
            onDrag: (params) => this._folderDragMove(params),
            onDrop: () => this._folderDrop(),
            onDragEnd: () => this._folderDragEnd(),
        });

        onWillUpdateProps(() => {
            this.state.focusedIndex = null;
        });
        onMounted(() => {
            if (!hasTouch()) {
                this._focusInput();
            }
        });
    },

    //--------------------------------------------------------------------------
    // Getters
    //--------------------------------------------------------------------------

    get displayedItems() {
        return this.props.items;
    },

    // Keep the command palette / keyboard logic working on the flat app list.
    get displayedApps() {
        return this.props.items.filter((i) => i.type === "app").map((i) => i.app);
    },

    get defaultFolderName() {
        return _t("Folder");
    },

    /** Apps shown in the 2x2 preview; leaves the 4th cell for "+N" if needed. */
    folderPreviewApps(item) {
        return item.apps.length > 4 ? item.apps.slice(0, 3) : item.apps;
    },

    //--------------------------------------------------------------------------
    // Template helpers
    //--------------------------------------------------------------------------

    itemKey(item) {
        return item.type === "folder" ? "f_" + item.id : "a_" + item.app.xmlid;
    },

    itemId(item) {
        return item.type === "folder" ? item.id : item.app.xmlid;
    },

    _matchId(item, id) {
        return item.type === "folder" ? item.id === id : item.app.xmlid === id;
    },

    _save() {
        this.props.persist(this.props.items);
    },

    //--------------------------------------------------------------------------
    // Click handlers
    //--------------------------------------------------------------------------

    onItemClick(item, ev) {
        if (item.type === "folder") {
            const rect = ev?.currentTarget?.getBoundingClientRect();
            if (rect) {
                this._zoomOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            }
            this.state.openFolder = item;
        } else {
            this._openMenu(item.app);
        }
    },

    onFolderAppClick(app) {
        // No close animation: we are navigating away anyway.
        this.state.openFolder = null;
        this.state.folderClosing = false;
        this._openMenu(app);
    },

    closeFolder() {
        if (!this.state.openFolder || this.state.folderClosing) {
            return;
        }
        this.state.folderClosing = true;
        setTimeout(() => {
            this.state.openFolder = null;
            this.state.folderClosing = false;
        }, CLOSE_ANIMATION_MS);
    },

    onRenameFolder(ev) {
        if (this.state.openFolder) {
            this.state.openFolder.name = ev.target.value;
            this._save();
        }
    },

    //--------------------------------------------------------------------------
    // Hotkeys
    //--------------------------------------------------------------------------

    /**
     * Same as the native registration, except Escape: with a folder panel
     * open it closes the panel first instead of leaving the home menu.
     */
    _registerHotkeys() {
        const hotkeys = [
            ["ArrowDown", () => this._updateFocusedIndex("nextLine")],
            ["ArrowRight", () => this._updateFocusedIndex("nextColumn")],
            ["ArrowUp", () => this._updateFocusedIndex("previousLine")],
            ["ArrowLeft", () => this._updateFocusedIndex("previousColumn")],
            ["Tab", () => this._updateFocusedIndex("nextElem")],
            ["shift+Tab", () => this._updateFocusedIndex("previousElem")],
            [
                "Enter",
                () => {
                    const menu = this.displayedApps[this.state.focusedIndex];
                    if (menu) {
                        this._openMenu(menu);
                    }
                },
            ],
            [
                "Escape",
                () => {
                    if (this.state.openFolder) {
                        this.closeFolder();
                    } else {
                        this.homeMenuService.toggle(false);
                    }
                },
            ],
        ];
        hotkeys.forEach((hotkey) => {
            useHotkey(...hotkey, {
                allowRepeat: true,
            });
        });
        useExternalListener(window, "keydown", this._onKeydownFocusInput);
    },

    //--------------------------------------------------------------------------
    // Auto-organize by official module category
    //--------------------------------------------------------------------------

    onAutoOrganizeClick() {
        this.dialog.add(ConfirmationDialog, {
            title: _t("Organize by category"),
            body: _t(
                "Group all apps into folders based on Odoo's official app categories? Existing folders will be rearranged."
            ),
            confirmLabel: _t("Organize"),
            confirm: () => this._autoOrganize(),
            cancel: () => {},
        });
    },

    async _autoOrganize() {
        const items = this.props.items;
        // Flatten everything (existing folders are rebuilt from scratch).
        const apps = items.flatMap((i) => (i.type === "folder" ? i.apps : [i.app]));
        const moduleOf = (app) => app.xmlid.split(".")[0];
        const moduleNames = [...new Set(apps.map(moduleOf))];
        const categoryByModule = await this.orm.call(
            "res.users.settings",
            "get_home_menu_app_categories",
            [moduleNames]
        );

        this._undoSnapshot = items.slice();

        const groups = new Map(); // category label -> apps, in first-seen order
        const loose = [];
        for (const app of apps) {
            const category = categoryByModule[moduleOf(app)];
            if (category) {
                if (!groups.has(category)) {
                    groups.set(category, []);
                }
                groups.get(category).push(app);
            } else {
                loose.push(app);
            }
        }

        const newItems = [];
        for (const [name, categoryApps] of groups) {
            if (categoryApps.length >= 2) {
                newItems.push({ type: "folder", id: makeFolderId(), name, apps: categoryApps });
            } else {
                loose.push(categoryApps[0]);
            }
        }
        // Loose apps keep their previous relative order, after the folders.
        const originalIndex = new Map(apps.map((a, i) => [a.xmlid, i]));
        loose.sort((a, b) => originalIndex.get(a.xmlid) - originalIndex.get(b.xmlid));
        newItems.push(...loose.map((app) => ({ type: "app", app })));

        items.splice(0, items.length, ...newItems);
        this._save();

        this.notification.add(_t("Apps organized by category."), {
            type: "success",
            sticky: true,
            buttons: [
                {
                    name: _t("Undo"),
                    primary: true,
                    onClick: () => this._restoreSnapshot(),
                },
            ],
        });
    },

    onUnpackAllClick() {
        this.dialog.add(ConfirmationDialog, {
            title: _t("Dissolve all folders"),
            body: _t("Remove all folders and put every app back on the grid?"),
            confirmLabel: _t("Dissolve"),
            confirm: () => this._unpackAll(),
            cancel: () => {},
        });
    },

    _unpackAll() {
        const items = this.props.items;
        if (!items.some((i) => i.type === "folder")) {
            return;
        }
        this._undoSnapshot = items.slice();
        const flat = items.flatMap((i) =>
            i.type === "folder" ? i.apps.map((app) => ({ type: "app", app })) : [i]
        );
        items.splice(0, items.length, ...flat);
        this._save();

        this.notification.add(_t("All folders dissolved."), {
            type: "success",
            sticky: true,
            buttons: [
                {
                    name: _t("Undo"),
                    primary: true,
                    onClick: () => this._restoreSnapshot(),
                },
            ],
        });
    },

    _restoreSnapshot() {
        if (!this._undoSnapshot) {
            return;
        }
        this.props.items.splice(0, this.props.items.length, ...this._undoSnapshot);
        this._undoSnapshot = null;
        this._save();
    },

    //--------------------------------------------------------------------------
    // Grid drag (merge or reorder)
    //--------------------------------------------------------------------------

    _gridDragStart({ element }) {
        element.children[0]?.classList.add("o_dragged_app");
        // Invisible placeholder keeps the grid layout stable (the dragged
        // element is position:fixed, i.e. out of flow) and doubles as the
        // insertion-point indicator in reorder mode.
        const placeholder = document.createElement("div");
        placeholder.className = element.className + " o_hm_placeholder";
        placeholder.style.visibility = "hidden";
        element.after(placeholder);
        this._drag = {
            element,
            placeholder,
            id: element.dataset.itemId,
            type: element.dataset.itemType,
            mergeEl: null,
        };
    },

    /** All grid tiles except the dragged one and the placeholder. */
    _gridTiles() {
        const { element, placeholder } = this._drag;
        return [...this.rootRef.el.querySelectorAll(".o_apps > .o_draggable")].filter(
            (el) => el !== element && el !== placeholder
        );
    },

    _gridDragMove({ x, y }) {
        const drag = this._drag;
        if (!drag) {
            return;
        }
        // A folder was spring-opened mid-drag: the panel is now the drop zone.
        if (this.state.openFolder) {
            this._panelDragMove(x, y);
            return;
        }
        let hovered = null;
        for (const tile of this._gridTiles()) {
            const r = tile.getBoundingClientRect();
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
                hovered = { tile, rect: r };
                break;
            }
        }
        if (!hovered) {
            this._setMergeTarget(null);
            return;
        }
        const { tile, rect } = hovered;
        const mx = (rect.width * (1 - MERGE_ZONE)) / 2;
        const my = (rect.height * (1 - MERGE_ZONE)) / 2;
        const inCenter =
            x >= rect.left + mx && x <= rect.right - mx &&
            y >= rect.top + my && y <= rect.bottom - my;

        // Only apps can be merged (folders never nest).
        if (inCenter && drag.type === "app") {
            this._setMergeTarget(tile);
        } else {
            this._setMergeTarget(null);
            // Reorder mode: move the placeholder slot next to the hovered tile.
            const before = x < rect.left + rect.width / 2;
            const target = before ? tile.previousElementSibling : tile;
            if (target !== drag.placeholder && tile !== drag.placeholder) {
                if (before) {
                    tile.before(drag.placeholder);
                } else {
                    tile.after(drag.placeholder);
                }
            }
        }
    },

    _setMergeTarget(tile) {
        const drag = this._drag;
        if (!drag || drag.mergeEl === tile) {
            return;
        }
        drag.mergeEl?.querySelector(".o_menuitem")?.classList.remove("o_folder_merge_target");
        drag.mergeEl = tile;
        tile?.querySelector(".o_menuitem")?.classList.add("o_folder_merge_target");

        // Spring loading: dwelling on a folder auto-opens it.
        clearTimeout(drag.springTimer);
        drag.springTimer = null;
        if (tile && tile.dataset.itemType === "folder" && drag.type === "app") {
            drag.springTimer = setTimeout(() => this._springOpen(tile), SPRING_DELAY);
        }
    },

    _springOpen(tile) {
        const drag = this._drag;
        const folder = this.props.items.find(
            (i) => i.type === "folder" && i.id === tile.dataset.itemId
        );
        if (!drag || !folder) {
            return;
        }
        const rect = tile.getBoundingClientRect();
        this._zoomOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        this._setMergeTarget(null);
        this.state.openFolder = folder;
    },

    /** While dragging over the spring-opened panel: move a placeholder slot
     *  through the folder grid to show where the app would land. */
    _panelDragMove(x, y) {
        const drag = this._drag;
        const grid = this.folderGridRef.el;
        if (!grid || drag.type !== "app") {
            return;
        }
        if (!drag.folderPlaceholder) {
            const ph = document.createElement("div");
            ph.className = "col-3 mb-3 px-0 o_hm_placeholder";
            drag.folderPlaceholder = ph;
            grid.appendChild(ph);
        }
        for (const tile of grid.querySelectorAll(".o_folder_draggable")) {
            const r = tile.getBoundingClientRect();
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
                if (x < r.left + r.width / 2) {
                    tile.before(drag.folderPlaceholder);
                } else {
                    tile.after(drag.folderPlaceholder);
                }
                return;
            }
        }
    },

    /** Drop after a spring-open: insert into the open folder at the
     *  placeholder position, or cancel when released outside the panel. */
    _dropIntoOpenFolder() {
        const drag = this._drag;
        const folder = this.state.openFolder;
        const panel = this.folderPanelRef.el;
        if (drag.type !== "app" || !panel) {
            return;
        }
        const rect = panel.getBoundingClientRect();
        const { x, y } = this._pointer;
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
            // Released outside: cancel, app stays on the grid.
            this.closeFolder();
            return;
        }
        const items = this.props.items;
        const idx = items.findIndex((i) => i.type === "app" && i.app.xmlid === drag.id);
        if (idx === -1) {
            return;
        }
        // Insertion index = number of app tiles before the placeholder.
        let insertAt = folder.apps.length;
        const ph = drag.folderPlaceholder;
        if (ph && ph.parentElement) {
            insertAt = 0;
            for (let sib = ph.previousElementSibling; sib; sib = sib.previousElementSibling) {
                if (sib.classList.contains("o_folder_draggable")) {
                    insertAt++;
                }
            }
        }
        const [moved] = items.splice(idx, 1);
        folder.apps.splice(insertAt, 0, moved.app);
        this._save();
    },

    _gridDrop() {
        const drag = this._drag;
        if (!drag) {
            return;
        }
        if (this.state.openFolder) {
            this._dropIntoOpenFolder();
            return;
        }
        if (drag.mergeEl) {
            this._merge(drag.id, drag.mergeEl.dataset.itemId, drag.mergeEl.dataset.itemType);
            return;
        }
        // Reorder: the placeholder marks the new slot. Find the previous real
        // tile (skipping the dragged element itself, which is still in the DOM
        // at its original position).
        let prev = drag.placeholder.previousElementSibling;
        while (prev && (prev === drag.element || !prev.dataset.itemId)) {
            prev = prev.previousElementSibling;
        }
        this._reorderGrid(drag.id, prev ? prev.dataset.itemId : null);
    },

    _gridDragEnd() {
        const drag = this._drag;
        if (!drag) {
            return;
        }
        this._setMergeTarget(null);
        clearTimeout(drag.springTimer);
        drag.folderPlaceholder?.remove();
        drag.placeholder.remove();
        drag.element.children[0]?.classList.remove("o_dragged_app");
        this._drag = null;
    },

    _merge(draggedXmlid, targetId, targetType) {
        const items = this.props.items;
        const dragIdx = items.findIndex(
            (i) => i.type === "app" && i.app.xmlid === draggedXmlid
        );
        if (dragIdx === -1) {
            return;
        }
        const draggedApp = items[dragIdx].app;

        if (targetType === "folder") {
            const folder = items.find((i) => i.type === "folder" && i.id === targetId);
            if (!folder) {
                return;
            }
            items.splice(dragIdx, 1);
            folder.apps.push(draggedApp);
        } else {
            const targetApp = items.find(
                (i) => i.type === "app" && i.app.xmlid === targetId
            )?.app;
            if (!targetApp) {
                return;
            }
            const folder = {
                type: "folder",
                id: makeFolderId(),
                name: "",
                apps: [targetApp, draggedApp],
            };
            // Remove the dragged app first, then replace the target tile in place.
            items.splice(dragIdx, 1);
            const tgtIdx = items.findIndex(
                (i) => i.type === "app" && i.app.xmlid === targetId
            );
            items.splice(tgtIdx, 1, folder);
        }
        this._save();
    },

    _reorderGrid(draggedId, previousId) {
        const items = this.props.items;
        const idx = items.findIndex((i) => this._matchId(i, draggedId));
        if (idx === -1) {
            return;
        }
        const [moved] = items.splice(idx, 1);
        if (previousId) {
            const pIdx = items.findIndex((i) => this._matchId(i, previousId));
            items.splice(pIdx + 1, 0, moved);
        } else {
            items.unshift(moved);
        }
        this._save();
    },

    //--------------------------------------------------------------------------
    // Folder panel drop (reorder inside or unpack out)
    //--------------------------------------------------------------------------

    _folderDragStart({ element }) {
        element.children[0]?.classList.add("o_dragged_app");
        // Invisible placeholder: keeps the panel layout stable and marks the
        // insertion slot while reordering.
        const placeholder = document.createElement("div");
        placeholder.className = element.className + " o_hm_placeholder";
        placeholder.style.visibility = "hidden";
        element.after(placeholder);
        this._folderDrag = {
            element,
            placeholder,
            xmlid: element.dataset.menuXmlid,
            outside: false,
        };
    },

    _folderDragMove({ x, y }) {
        const drag = this._folderDrag;
        const panel = this.folderPanelRef.el;
        if (!drag || !panel) {
            return;
        }
        const rect = panel.getBoundingClientRect();
        drag.outside = x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
        panel.classList.toggle("o_drop_out", drag.outside);
        if (drag.outside) {
            return;
        }
        for (const tile of this.folderGridRef.el.querySelectorAll(".o_folder_draggable")) {
            if (tile === drag.element) {
                continue;
            }
            const r = tile.getBoundingClientRect();
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
                if (x < r.left + r.width / 2) {
                    tile.before(drag.placeholder);
                } else {
                    tile.after(drag.placeholder);
                }
                return;
            }
        }
    },

    _folderDrop() {
        const drag = this._folderDrag;
        const folder = this.state.openFolder;
        if (!drag || !folder) {
            return;
        }
        if (drag.outside) {
            this._removeFromFolder(folder, drag.xmlid);
            return;
        }
        // Reorder inside: the new index is the number of app tiles before the
        // placeholder (the dragged tile itself doesn't count — it is out of
        // flow but still in the DOM).
        let index = 0;
        for (
            let sib = drag.placeholder.previousElementSibling;
            sib;
            sib = sib.previousElementSibling
        ) {
            if (sib.classList.contains("o_folder_draggable") && sib !== drag.element) {
                index++;
            }
        }
        const from = folder.apps.findIndex((a) => a.xmlid === drag.xmlid);
        if (from === -1) {
            return;
        }
        const [moved] = folder.apps.splice(from, 1);
        folder.apps.splice(index, 0, moved);
        this._save();
    },

    _folderDragEnd() {
        const drag = this._folderDrag;
        if (!drag) {
            return;
        }
        this.folderPanelRef.el?.classList.remove("o_drop_out");
        drag.placeholder.remove();
        drag.element.children[0]?.classList.remove("o_dragged_app");
        this._folderDrag = null;
    },

    _removeFromFolder(folder, xmlid) {
        const items = this.props.items;
        const idx = folder.apps.findIndex((a) => a.xmlid === xmlid);
        if (idx === -1) {
            return;
        }
        const [app] = folder.apps.splice(idx, 1);
        // Drop the app back onto the grid, right after its former folder.
        const fIdx = items.findIndex((i) => i.type === "folder" && i.id === folder.id);
        items.splice(fIdx + 1, 0, { type: "app", app });

        // A folder with a single app left is dissolved (like a phone).
        if (folder.apps.length <= 1) {
            this._dissolveFolder(folder);
        }
        this._save();
    },

    _dissolveFolder(folder) {
        const items = this.props.items;
        const fIdx = items.findIndex((i) => i.type === "folder" && i.id === folder.id);
        if (fIdx === -1) {
            return;
        }
        const remaining = folder.apps.map((app) => ({ type: "app", app }));
        items.splice(fIdx, 1, ...remaining);
        if (this.state.openFolder && this.state.openFolder.id === folder.id) {
            this.state.openFolder = null;
        }
    },
});
