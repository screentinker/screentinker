#!/usr/bin/env python3
"""
2.3 seed, API part (server UP): data sources, the signed template library, template widgets.

Talks only to :3014 (DATA_DIR=<this folder>/instance). Every value is invented; the
only outside URLs are ScreenTinker's OWN (the template catalog, the project's release feed and an
example CSV from the project's repository) — no third-party content.
"""
import json, urllib.request, urllib.error, os, sys, time

BASE = "http://localhost:3014"
HERE = os.path.dirname(os.path.abspath(__file__))
TOK = open(os.path.join(HERE, ".token")).read().strip()
BUNDLE = os.environ.get("CATALOG_BUNDLE", "")   # an offline bundle zip from a screentinker/templates release

def call(method, path, body=None, raw=None, ctype="application/json"):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + "/api" + path, data=data, method=method,
                                 headers={"Authorization": f"Bearer {TOK}", "Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            s = r.read().decode()
            return json.loads(s) if s else {}
    except urllib.error.HTTPError as e:
        print(f"  !! {method} {path} -> {e.code}: {e.read().decode()[:300]}")
        return None

# The café menu the hook edits. Key column = Item, so {{ds:menu.latte_price}} survives a sort.
MENU_COLS = ["Item", "Price", "Description", "Category", "Tag"]
def menu_rows(latte="4.20"):
    return [
        ["Espresso",        "2.80", "Double shot, chocolate and cherry notes", "Coffee", ""],
        ["Latte",           latte,  "Steamed milk, house espresso",             "Coffee", "Popular"],
        ["Flat White",      "3.60", "Velvet milk over a double ristretto",      "Coffee", ""],
        ["Cold Brew",       "4.20", "Steeped for 18 hours, served over ice",    "Coffee", "New"],
        ["Chai Latte",      "3.80", "House spice blend, steamed milk",          "Tea",    ""],
        ["Earl Grey",       "3.00", "Bergamot, loose leaf",                     "Tea",    ""],
        ["Butter Croissant","3.20", "Laminated for three days",                 "Pastries",""],
        ["Cinnamon Knot",   "3.40", "Cardamom sugar, brown butter",             "Pastries","Popular"],
        ["Avocado Toast",   "8.50", "Sourdough, chilli, lime",                  "Specials",""],
    ]

def ensure_ds(name, slug, typ, cfg):
    have = call("GET", "/data-sources") or []
    if isinstance(have, dict): have = have.get("data_sources", have.get("items", []))
    for d in have:
        if d.get("slug") == slug: print(f"  {slug:10s} exists"); return d
    r = call("POST", "/data-sources", {"name": name, "slug": slug, "type": typ, "config": cfg})
    print(f"  {slug:10s} {typ:6s} {'created' if r else 'FAILED'}")
    return r

if __name__ == "__main__":
    print("== data sources ==")
    menu = ensure_ds("Café menu", "menu", "table",
                     {"columns": MENU_COLS, "rows": menu_rows(), "key_column": "Item"})
    # ScreenTinker's own public endpoints only.
    ensure_ds("Template catalog", "catalog", "rest",
              {"url": "https://screentinker.github.io/templates/index.json", "method": "GET",
               "auth_type": "none", "response_format": "json", "shape": "table", "json_path": "templates"})
    ensure_ds("Release notes", "releases", "rss",
              {"url": "https://github.com/screentinker/screentinker/releases.atom", "max_items": 8})
    ensure_ds("Welcome board", "welcome", "csv",
              {"url": "https://raw.githubusercontent.com/screentinker/screentinker/main/Examples/PIP-Welcome-Board/people.example.csv",
               "key_column": "name"})

    # Optional: an offline bundle (CATALOG_BUNDLE=...zip) for a capture machine without internet.
    # Without it, switching the library on below fetches the live signed catalog instead.
    if BUNDLE:
        print("== template library: signed offline bundle ==")
        r = call("POST", "/templates/import?kind=bundle", raw=open(BUNDLE, "rb").read(), ctype="application/zip")
        print("  bundle:", r)

    # The normal hosted setup: the community library ON (it fetches ScreenTinker's own catalog only).
    print("  library on:", call("PUT", "/templates/settings", {"network_enabled": True}))
    r = call("POST", "/templates/catalogs/official/refresh", {})
    print("  live catalog check:", "ok" if r is not None else "FAILED (offline bundle still installed)")

    print("== install ==")
    for tid in ["menu-board", "uptime-3036", "meeting-room", "kpi-dashboard", "world-clocks", "lobby-welcome"]:
        r = call("POST", "/templates/install", {"catalog": "official", "id": tid})
        print(f"  {tid:16s} {(r or {}).get('trust', 'FAILED')} {(r or {}).get('version', '')}")

    print("== widgets from templates ==")
    ws = call("POST", "/templates/installed/official/menu-board/use",
              {"name": "Cafeteria menu board", "values": {"menu": "menu", "title": "Fairview Café",
                                                            "subtitle": "Level 1 · Open 7am–7pm"}})
    print("  menu-board widget:", (ws or {}).get("id"))
    wg = call("POST", "/templates/installed/official/uptime-3036/use", {"name": "UPTIME 3036 — lobby arcade", "values": {}})
    print("  uptime-3036 widget:", (wg or {}).get("id"))
    json.dump({"menu_ds": (menu or {}).get("id"), "menu_widget": (ws or {}).get("id"),
               "game_widget": (wg or {}).get("id")}, open(os.path.join(HERE, "seed23.json"), "w"))
