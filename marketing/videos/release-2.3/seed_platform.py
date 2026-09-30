#!/usr/bin/env python3
"""
2.3 seed, OFFLINE part — run ONLY with the server STOPPED (see rebuild.sh; a bulk write under the
live server's WAL checkpointer is what corrupted the 2.0 instance).

Makes the Platform area look like a real hosted server: ~40 invented customer accounts across
paying / trial / inactive / stale / unverified, a second workspace and teammates in the demo org
(Members -> Whole organization), screens in other organizations (some dark for days), one stale
account already sent its deletion notice, and one limited-time sale.

⚠️ EVERYTHING IS INVENTED. Addresses are @example.test; the sale's Stripe coupon id is a fake
   string — the capture server's Stripe key is a dummy and nothing here reaches Stripe.
"""
import sqlite3, os, uuid, time, random, json

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "instance", "db", "remote_display.db")
random.seed(2300)
NOW = int(time.time()); DAY = 86400
c = sqlite3.connect(DB)
c.execute("PRAGMA foreign_keys=OFF")

def cols(t): return {r[1]: r for r in c.execute(f"PRAGMA table_info({t})")}
COLS = {t: cols(t) for t in ["users", "organizations", "organization_members", "workspaces",
                              "workspace_members", "devices", "promotions", "activity_log"]}

def ins(table, row):
    have = COLS[table]
    row = {k: v for k, v in row.items() if k in have}
    missing = [n for n, r in have.items() if r[3] and r[4] is None and not r[5] and n not in row]
    if missing: raise SystemExit(f"!! {table}: NOT NULL columns without a value: {missing}")
    c.execute(f"INSERT INTO {table} ({','.join(row)}) VALUES ({','.join('?'*len(row))})", list(row.values()))

PW = c.execute("SELECT password_hash FROM users ORDER BY created_at LIMIT 1").fetchone()[0]  # never logged into

def account(name, email, org, *, created, last_login, plan="free", trial=None, paying=False,
            verified=1, screens=0, dark_days=None, warned=False):
    uid = str(uuid.uuid4()); oid = str(uuid.uuid4()); wid = str(uuid.uuid4())
    ins("users", dict(id=uid, email=email, name=name, password_hash=PW, auth_provider="local", role="user",
                      plan_id=plan, created_at=created, last_login=last_login,
                      trial_started=trial, trial_plan="pro" if trial else None, email_verified=verified,
                      stripe_customer_id=f"cus_demo_{uid[:8]}" if paying else None,
                      stripe_subscription_id=f"sub_demo_{uid[:8]}" if paying else None,
                      subscription_status="active",
                      cleanup_warned_at=NOW - 5*DAY if warned else None,
                      cleanup_delete_after=NOW + 9*DAY if warned else None))
    ins("organizations", dict(id=oid, name=org, owner_user_id=uid, plan_id=plan, subscription_status="active",
                              created_at=created))
    ins("organization_members", dict(organization_id=oid, user_id=uid, role="org_owner"))
    ins("workspaces", dict(id=wid, organization_id=oid, name="Default", created_by=uid, created_at=created))
    ins("workspace_members", dict(workspace_id=wid, user_id=uid, role="workspace_admin", joined_at=created))
    for i in range(screens):
        hb = NOW - (dark_days * DAY if (dark_days and i == 0) else random.randint(20, 90))
        ins("devices", dict(id=str(uuid.uuid4()), name=f"{org.split()[0]} screen {i+1}", workspace_id=wid,
                            user_id=uid, status="online" if hb > NOW - 300 else "offline",
                            last_heartbeat=hb, created_at=created, pairing_code=None,
                            device_token=uuid.uuid4().hex))
    return uid

# ---- paying customers, with screens (a couple dark for days)
paying = [("Priya Raman","priya@harborview-dental.example.test","Harborview Dental Group",4,None),
          ("Marcus Lindahl","marcus@northgate-fitness.example.test","Northgate Fitness",6,3),
          ("Aiko Tanaka","aiko@kestrel-hotels.example.test","Kestrel Hotels",12,None),
          ("Daniel Okoro","daniel@brightwater-school.example.test","Brightwater Primary School",3,None),
          ("Sofia Alvarez","sofia@lumen-coworking.example.test","Lumen Coworking",5,2),
          ("Tomás Lindqvist","tomas@copperleaf-cafe.example.test","Copperleaf Café",2,None),
          ("Grace Whitfield","grace@meridian-clinic.example.test","Meridian Family Clinic",4,None),
          ("Hamid Farouk","hamid@summit-motors.example.test","Summit Motors",8,4),
          ("Lena Kowalski","lena@oakline-library.example.test","Oakline Public Library",3,None),
          ("Ben Achterberg","ben@riverside-arena.example.test","Riverside Arena",10,None)]
for i, (n, e, o, s, dark) in enumerate(paying):
    created = NOW - random.randint(60, 400) * DAY
    account(n, e, o, created=created, last_login=NOW - random.randint(0, 6) * DAY,
            plan=random.choice(["starter", "pro", "pro", "enterprise"]), paying=True, screens=s, dark_days=dark)

# ---- on a trial right now (two ending within two days)
trials = [("Nadia Petrova","nadia@fernhill-works.example.test","Fernhill Works",12),
          ("Owen Murphy","owen@tidewater-bakery.example.test","Tidewater Bakery",13),
          ("Chloe Dubois","chloe@atelier-nord.example.test","Atelier Nord",5),
          ("Ravi Menon","ravi@pinecrest-dental.example.test","Pinecrest Dental",3),
          ("Isla Grant","isla@saltmarsh-yoga.example.test","Saltmarsh Yoga",8),
          ("Kenji Mori","kenji@lantern-ramen.example.test","Lantern Ramen",1)]
for n, e, o, age in trials:
    t = NOW - age * DAY
    account(n, e, o, created=t, last_login=NOW - random.randint(0, 2) * DAY, plan="pro", trial=t,
            screens=1 if age > 4 else 0)

# ---- signed up this week, never verified
for n, e, o in [("Jordan Blake","jordan.blake@example.test","Blake Signage"),
                ("Mira Sandoval","mira@quillhouse.example.test","Quillhouse Books"),
                ("Felix Hart","felix@hartandco.example.test","Hart & Co"),
                ("Amara Nwosu","amara@greenline-transit.example.test","Greenline Transit")]:
    t = NOW - random.randint(0, 5) * DAY
    account(n, e, o, created=t, last_login=t, plan="free", verified=0)

# ---- free accounts, inactive 30–150 days, never paired a screen
for n, e, o in [("Hugo Brandt","hugo@brandt-events.example.test","Brandt Events"),
                ("Elena Rossi","elena@villa-rossi.example.test","Villa Rossi"),
                ("Sam Carter","sam.carter@example.test","Carter Consulting"),
                ("Yusuf Demir","yusuf@anatolia-grill.example.test","Anatolia Grill"),
                ("Petra Novak","petra@novak-studio.example.test","Novak Studio"),
                ("Liam Chen","liam@chen-optometry.example.test","Chen Optometry"),
                ("Rosa Jimenez","rosa@casa-jimenez.example.test","Casa Jimenez"),
                ("Arjun Shah","arjun@shah-pharmacy.example.test","Shah Pharmacy"),
                ("Maya Okafor","maya.okafor@example.test","Okafor Media"),
                ("Noah Williams","noah@williams-auto.example.test","Williams Auto")]:
    last = NOW - random.randint(32, 150) * DAY
    account(n, e, o, created=last - random.randint(10, 60) * DAY, last_login=last, plan="free")

# ---- stale: nothing for 200+ days — the Cleanup candidates (one already sent its notice)
stale = [("Vera Lindgren","vera@lindgren-florist.example.test","Lindgren Florist",True),
         ("Oscar Pike","oscar.pike@example.test","Pike Photography",False),
         ("Hannah Voss","hannah@voss-dance.example.test","Voss Dance School",False),
         ("Theo Marsh","theo@marsh-games.example.test","Marsh Games",False),
         ("Ingrid Solberg","ingrid@solberg-design.example.test","Solberg Design",False),
         ("Carlos Mendes","carlos@mendes-imports.example.test","Mendes Imports",False)]
for n, e, o, w in stale:
    last = NOW - random.randint(210, 420) * DAY
    account(n, e, o, created=last - random.randint(1, 20) * DAY, last_login=last, plan="free", warned=w)

# ---- the demo organization: a second workspace and teammates (Members -> Whole organization)
demo = c.execute("SELECT id FROM users WHERE email='demo@screentinker.test'").fetchone()[0]
org = c.execute("SELECT id FROM organizations WHERE owner_user_id=?", (demo,)).fetchone()[0]
c.execute("UPDATE organizations SET name='Fairview Medical Center' WHERE id=?", (org,))
ws_default = c.execute("SELECT id FROM workspaces WHERE organization_id=? ORDER BY created_at LIMIT 1", (org,)).fetchone()[0]
ws_out = str(uuid.uuid4())
ins("workspaces", dict(id=ws_out, organization_id=org, name="Outpatient Clinic", created_by=demo, created_at=NOW - 40*DAY))
ins("workspace_members", dict(workspace_id=ws_out, user_id=demo, role="workspace_admin", joined_at=NOW - 40*DAY))
team = [("Rachel Kim","rachel.kim@fairview.example.test","org_admin",[(ws_default,"workspace_admin"),(ws_out,"workspace_admin")]),
        ("Dev Patel","dev.patel@fairview.example.test","org_member",[(ws_default,"workspace_editor")]),
        ("Olivia Brooks","olivia.brooks@fairview.example.test","org_member",[(ws_out,"workspace_editor")]),
        ("Sam Nguyen","sam.nguyen@fairview.example.test","org_member",[(ws_default,"workspace_viewer"),(ws_out,"workspace_viewer")])]
for n, e, orole, mems in team:
    uid = str(uuid.uuid4()); t = NOW - random.randint(20, 90) * DAY
    ins("users", dict(id=uid, email=e, name=n, password_hash=PW, auth_provider="local", role="user", plan_id="free",
                      created_at=t, last_login=NOW - random.randint(0, 10) * DAY, email_verified=1))
    ins("organization_members", dict(organization_id=org, user_id=uid, role=orole))
    for w, r in mems: ins("workspace_members", dict(workspace_id=w, user_id=uid, role=r, joined_at=t))

# ---- one limited-time sale, running now, five days left
ins("promotions", dict(id=str(uuid.uuid4()), name="Autumn sale", headline="Autumn sale — 25% off every plan",
                       percent_off=25, cycles="both", duration="repeating", duration_in_months=3, plan_ids="[]",
                       starts_at=NOW - 2*DAY, ends_at=NOW + 5*DAY + 7*3600, stripe_coupon_id="video_capture_fake_coupon",
                       created_by=demo, created_at=NOW - 2*DAY))

c.commit()
print("users:", c.execute("SELECT COUNT(*) FROM users").fetchone()[0],
      "orgs:", c.execute("SELECT COUNT(*) FROM organizations").fetchone()[0],
      "devices:", c.execute("SELECT COUNT(*) FROM devices").fetchone()[0],
      "promotions:", c.execute("SELECT COUNT(*) FROM promotions").fetchone()[0])
c.close()
