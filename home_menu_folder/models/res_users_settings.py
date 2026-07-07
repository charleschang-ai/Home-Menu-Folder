# -*- coding: utf-8 -*-
from odoo import api, models


class ResUsersSettings(models.Model):
    _inherit = "res.users.settings"

    @api.model
    def get_home_menu_app_categories(self, module_names):
        """Map module name -> top-level app category label, for the home menu
        "organize by category" feature.

        `ir.module.module` / `ir.module.category` are admin-only (see base ACLs),
        hence the sudo(); only harmless (module name -> category label) pairs
        leave this method. Modules under the "Hidden" root category are omitted
        so pseudo-apps like Settings/Apps stay loose.
        """
        if not isinstance(module_names, (list, tuple)):
            return {}
        modules = self.env["ir.module.module"].sudo().search(
            [("name", "in", [str(n) for n in module_names])]
        )
        result = {}
        for module in modules:
            root = module.category_id
            if not root:
                continue
            while root.parent_id:
                root = root.parent_id
            if root.get_external_id().get(root.id) == "base.module_category_hidden":
                continue
            result[module.name] = root.name
        return result
