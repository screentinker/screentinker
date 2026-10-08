# BI dashboards on screens: Grafana, Power BI and Tableau

The **BI Dashboard** widget puts a live dashboard on a screen. There are two ways to set one up:

- **A connection.** Your organization's own credentials, added once in **Settings → BI dashboards**
  by an organization owner or admin. Editors then choose a dashboard from it.
- **A public link.** Nothing to sign in to: a Grafana public dashboard, a Power BI "Publish to web"
  link, or a Tableau Public view. Anyone with the link can see it.

**Credentials stay on the ScreenTinker server.** They're encrypted at rest, never shown again after
you save them, and never sent to a screen. What a screen receives depends on the service:

| Service | What the screen gets |
|---|---|
| Grafana | A PNG the server rendered. The screen never talks to Grafana. |
| Power BI | A view-only embed token for one report, which expires within the hour. The screen fetches a new one before it does. |
| Tableau | A five-minute connected-app token that can only embed views. |

A widget can only use a connection that belongs to its own organization.

---

## Grafana

**In Grafana:**

1. Install the **Grafana Image Renderer**, either as the plugin or as the remote rendering service.
   It turns dashboards into images, and without it nothing renders. **Test** shows whether the
   plugin is there.
2. Create a **service account** with the **Viewer** role and add a token.

**In ScreenTinker:**

1. **Settings → BI dashboards → Add a connection → Grafana.** Enter the Grafana address (for
   example `https://grafana.example.com`, or `https://example.com/grafana` if it's served under a
   path) and the token.
2. **Test** it.
3. In **Widgets → BI Dashboard**, choose the connection and a dashboard. **Browse** lists the
   dashboards the token can see. You can also enter a dashboard's UID, the part after `/d/` in its
   address. Optional settings:
   - **Single panel ID:** show one panel instead of the whole dashboard.
   - **Time range:** `now-6h` to `now`, for example.
   - **Template variables:** `var-host=web1&var-env=prod`. Only `var-…` keys are accepted.
   - **Theme:** light or dark.

**How refreshing works:**

- Images refresh every 5 minutes by default. You can set any interval down to 30 seconds.
- Screens of the same size share one render, so ten lobby screens don't mean ten renders.
- If Grafana stops answering, screens keep showing the last image and a small "Showing the last
  image" note.

### Grafana on your own network

The server connects to the Grafana address. On a hosted ScreenTinker instance, private addresses
(10.x, 192.168.x, `localhost` and so on) are refused, so a tenant can't make the server reach into
networks it shouldn't.

On a **self-hosted** server, or for a **platform administrator**, the connection has an extra
option: **Allow a private network address**. Cloud metadata and link-local addresses stay refused
even with it on. On a hosted instance the option belongs to the address it was granted for: if an
organization admin changes the connection's address, it switches off again until a platform
administrator turns it back on.

---

## Power BI

This uses Power BI's "App owns data" embedding with your own Entra ID app, a service principal.

**In Entra ID:** register an application and add a client secret. It needs no Microsoft Graph or
Power BI API permissions.

**In the Power BI admin portal:**

1. Open **Tenant settings → Developer settings**.
2. Turn on **Service principals can use Fabric APIs** (in older tenants, "Allow service principals
   to use Power BI APIs").
3. Limit it to a security group that contains the app, if you prefer.

**In each Power BI workspace** whose reports you want on screens, add the app (or that group) as a
**Viewer** or higher.

**In ScreenTinker:**

1. **Settings → BI dashboards → Add a connection → Power BI.** Enter the directory (tenant) ID,
   the application (client) ID and the secret. **Test** signs in and counts the workspaces the app
   can see.
2. In the widget, choose the connection and **Browse** for a report.
3. To rotate through pages, list the page IDs you want (the `ReportSection…` part of a page's
   address), or tick **Rotate through all visible pages**, and set **Next page every**.

A dataset that refreshes on a schedule shows new data the next time the report reloads. Set
**Refresh every** to reload it, or leave it at 0 for DirectQuery and auto-page-refresh reports,
which update themselves.

**Capacity:** Microsoft licenses embedding with service principals for reports in a capacity: an
Embedded (A) SKU, Fabric (F), or Premium (P/EM). Embedding outside one is limited to development and
testing.

**No-credentials option:** **Publish to web** in Power BI gives a public link
(`https://app.powerbi.com/view?r=…`). Use **A public link** in the widget. The report is then
public to the internet, so only use it for data that is meant to be.

Only Microsoft's commercial cloud is supported, not GCC or sovereign clouds.

---

## Tableau (Cloud or Server)

This uses a **connected app** with direct trust.

**In Tableau** (Settings → Connected Apps):

1. Create a connected app (direct trust).
2. Generate a secret and enable the app.
3. Note the **client ID**, **secret ID** and **secret value**.
4. For **Domain allowlist**, the embedding page is your ScreenTinker server's address. If views
   refuse to load on screens, allow all domains while you check.

Choose a **dedicated Tableau user** for screens, one that can see only the dashboards meant for
screens. Anyone who can open a widget's page can get a token that embeds views as this user, so
it should have nothing else.

**In ScreenTinker:**

1. **Settings → BI dashboards → Add a connection → Tableau.** Enter:
   - the Tableau address, such as `https://prod-useast-a.online.tableau.com` or your server. On a
     hosted ScreenTinker instance this must be a Tableau Cloud address (`https://….online.tableau.com`),
     because the widget page loads Tableau's script from it; Tableau Server needs a self-hosted
     ScreenTinker (or a platform administrator to add the connection)
   - the site's content URL (empty for the default site)
   - the three connected-app values
   - the user

   **Test** signs in to Tableau's REST API with a token, which checks the app, the secret and the
   user. On Tableau Server, sign-in by connected app needs 2023.3 or later.
2. In the widget, paste the view's address (any form works, including Tableau Cloud's `#/site/…`
   addresses) or type `Workbook/Sheet`.
3. Optional: **Rotate through the workbook's sheets**, and **Refresh every** to re-query the data.

Tableau's embedding script is loaded from your Tableau host, as Tableau requires. Screens need to
reach that host.

**No-credentials option:** a **Tableau Public** view (`https://public.tableau.com/views/…`).

---

## Screens and players

- Screens show dashboards like any widget. The dashboard page is cached for offline use, but a live
  dashboard needs the network. Grafana screens keep the last image when they lose it.
- **Power BI and Tableau embed a page from Microsoft or Tableau inside the widget.** The dashboard
  page always runs with an isolated (opaque) origin, whatever **Settings → Widget sandbox isolation**
  says, and the report embedded in it inherits that isolation. It has to: the page is served by the
  ScreenTinker server, and without the isolation a script it loads (Tableau's comes from the Tableau
  host) would run with access to whoever opens the link's ScreenTinker session. Turning isolation off
  for the organization therefore does not change how a dashboard runs. Grafana images are
  unaffected.
- Very old TV browsers may not run the Power BI or Tableau embedding libraries. Grafana images work
  everywhere.

## The public endpoints

A screen's widget page fetches two things without signing in, the same way it fetches the page
itself:

- `GET /api/widgets/:id/bi-image.png`, the Grafana image
- `GET /api/widgets/:id/bi-token`, a Power BI embed token or Tableau token

Neither ever returns a connection's secret, and both answer a page with an opaque origin
(`Origin: null`), which is what a screen's widget page is.

What is limited is work, not views: a cached Grafana image or Power BI embed token is served to any
number of screens without counting. A request that would make the server render with Grafana, ask
Power BI for a token, or sign a Tableau token is counted per caller address and, more generously,
per widget. A caller over its budget still gets the last Grafana image, or the cached Power BI token
while it is valid.
