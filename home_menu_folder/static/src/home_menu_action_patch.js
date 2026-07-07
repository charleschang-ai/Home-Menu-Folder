/**
 * Patch the "menu" action (HomeMenuAction, a local class of web_enterprise's
 * home_menu_service). That class is registered inside `homeMenuService.start()`
 * — i.e. at service startup, not at module load — so we cannot grab it from the
 * registry at the top level. Instead we wrap `start()`: once the original has
 * run, the "menu" action exists and we patch its `homeMenuProps` getter to feed
 * <HomeMenu> a folder-aware `items` list and a `persist` callback.
 */
import { homeMenuService } from "@web_enterprise/webclient/home_menu/home_menu_service";
import { patch } from "@web/core/utils/patch";
import { registry } from "@web/core/registry";
import { user } from "@web/core/user";
import { reactive } from "@odoo/owl";
import { computeAppsAndMenuItems } from "@web/webclient/menus/menu_helpers";
import { parseConfig, buildItems, serializeItems } from "./config";

const originalStart = homeMenuService.start;
homeMenuService.start = function (...args) {
    const result = originalStart.apply(this, args);

    const HomeMenuAction = registry.category("actions").get("menu");
    patch(HomeMenuAction.prototype, {
        get homeMenuProps() {
            const apps = computeAppsAndMenuItems(this.menus.getMenuAsTree("root")).apps;
            const config = parseConfig(user.settings?.homemenu_config);
            // `items` must stay a stable reactive across HomeMenu re-renders so
            // that in-place drag mutations are not thrown away (HomeMenuAction
            // itself only re-renders on MENUS:APP-CHANGED, at which point we
            // rebuild from the stored config).
            const items = reactive(buildItems(apps, config));
            return {
                items,
                apps,
                persist: (currentItems) =>
                    user.setUserSettings("homemenu_config", serializeItems(currentItems)),
            };
        },
    });

    return result;
};
