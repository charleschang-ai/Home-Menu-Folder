# -*- coding: utf-8 -*-
{
    "name": "Home Menu App Folders | iOS-Style App Organizer",
    "summary": "Turn your cluttered Odoo home screen into a phone-like launcher: "
               "drag & drop apps into beautiful folders, auto-organize by official "
               "categories in one click, per-user layouts, dark mode.",
    "description": """
Home Menu App Folders — organize your Odoo Enterprise home screen like a phone
===============================================================================

Too many apps on your home menu? Group them into elegant iOS-style folders,
exactly the way you organize your phone's home screen.

Key Features
------------
* **iOS-style folders** — drag one app onto another and a folder is created
  instantly; drag more apps in, drag them back out, done.
* **Spring loading** — hold a dragged app over a folder for a second: the
  folder zooms open and you drop the app at the exact position you want.
* **Delightful animations** — folders zoom open from their tile like iOS,
  with frosted-glass previews and animated gradient borders.
* **At-a-glance info** — app count badge on every folder, "+N" overflow
  indicator in the 2x2 icon preview.
* **Folder panel** — click to enlarge: rename inline, reorder apps, or drag
  an app outside the panel to unpack it (folders dissolve automatically when
  only one app remains).
* **One-click auto-organize** — group every app by its official Odoo module
  category (Sales, Finance, HR, ...) with a single click, including a one-click
  Undo. Available to administrators in developer mode.
* **One-click dissolve** — flatten all folders back to a plain grid at any
  time, also with Undo.
* **Per-user layouts** — every user arranges their own home screen; layouts
  are stored server-side and roam across browsers and devices.
* **Dark mode ready** — dedicated dark theme styling out of the box.
* **Safe by design** — reuses Odoo's native home-menu storage; no new tables,
  uninstalling simply restores the standard home menu. Keyboard friendly
  (Escape closes the folder panel first).

Works exclusively with Odoo Enterprise (web_enterprise home menu).
Simplified Chinese translation included.
""",
    "version": "19.0.1.0.0",
    "category": "Productivity",
    "author": "Da Lei",
    "license": "LGPL-3",
    "depends": ["web_enterprise"],
    "assets": {
        "web.assets_backend": [
            "home_menu_folder/static/src/**/*",
            # Dark mode files only belong in the dark bundle.
            ("remove", "home_menu_folder/static/src/**/*.dark.scss"),
        ],
        "web.assets_web_dark": [
            "home_menu_folder/static/src/**/*.dark.scss",
        ],
    },
    'images': ['static/description/icon.png'],
    'price': 50,
    'currency': 'USD',
    'support': '18438630181@163.com',
    "installable": True,
    "application": False,
    "auto_install": False,
}
