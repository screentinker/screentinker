# Automation: hooks, Zapier, and mass notification systems

Other systems can change what your screens show. A fire panel, Alertus, Singlewire InformaCast,
Zapier, Make, n8n, or a script can all do it.

There are two ways in:

- **Hooks.** A secret web address that does one thing when called. It needs no account and no
  token, so anything that can send an HTTP request can use it. Hooks are on the **Automation**
  page.
- **The Zapier API.** Uses an API token. It lets Zapier start Zaps when something happens here,
  and run actions from a Zap.

## Hooks

**Automation → New hook**, then choose what it does:

| Kind | What a call does |
| --- | --- |
| **Emergency alert** | Raises or clears an emergency alert on the screens you choose. |
| **Mass notification** | The same, for Alertus, InformaCast and anything that sends CAP 1.2. The fields are found automatically. |
| **Fire a trigger** | Fires or clears one of your triggers on the screens it is assigned to. |
| **Update a table** | Writes the rows it receives into a Table data source. |
| **Switch to a playlist** | Shows a playlist on screens for some minutes, then they go back. Can also switch them back early. |

Saving shows the hook's address:

```
https://<your server>/api/hooks/in/<hook id>/<secret>
```

**Copy it then. It is shown only once.** The server keeps a fingerprint of the secret, never the
secret itself. If the address is lost, use **New address** to make another; the old one stops
working at once.

A hook accepts `POST` (JSON, XML or a form), up to 256 KB. It answers `200` with
`{ "ok": true, "result": "raised 1 on 12 screen(s)" }`. Every call goes into the hook's **Calls**
list and the activity log.

**`GET` is off by default.** Chat apps that preview links, email security scanners and browser
prefetch all open any address they see with `GET`, so a hook address pasted into a chat or an email
would call the hook. For a sender that can't `POST`, switch on **Also accept GET requests** on the
hook; it then takes the query parameters as its body. A `GET` to a hook without it answers the same
`404` as a wrong address.

### Security

- **A wrong address answers `404`.** An unknown hook, a wrong secret and a disabled hook all get
  the same answer, so the address is the only way in.
- **Signing (optional).** Add a signing secret and every request must carry an HMAC-SHA256 of its
  exact body, or it is refused with `401`. The signature header can be any of these:
  - `X-ScreenTinker-Signature`
  - `X-Signature`
  - `X-Hub-Signature-256`

  Its value can take any of these forms:
  - `t=<unix seconds>,v1=<hex of HMAC("t.body")>`. **Use this one if your sender can.** It is
    refused when more than 5 minutes old, so a captured request can't be replayed later.
  - `sha256=<hex>`
  - `<hex>`

  The last two sign the body only. They prove who sent it, but **a captured request stays valid**:
  anyone who records one signed call can send it again at any time. They are accepted for senders
  that can't add a timestamp (GitHub-style webhooks, for example). With them, keep the hook address
  private and rotate it if it may have leaked.
- **Rate limits.** 30 calls a minute per hook. Each sending address also has a limit of 240 calls a
  minute across all hooks.
- **Who can do it.** Only a workspace admin can create, change, test or delete hooks.
- **Mesh replication.** Hooks aren't available in a workspace replicated over the mesh.

### Templates

Fields like the headline can be plain text, or can take values from the request:

```
{{body.alert.title}}     {{body.items[0].name}}     {{query.site}}
```

A template only looks values up; it never runs anything. A missing value is empty text. Values
are shown as text, never as HTML.

### Emergency alert hooks

- **Raise.** The alert appears on screens in scope, the same way an emergency feed alert does: the
  alert card, or the playlist you chose. Head office emergency alerts still come first.
- **Same alert id, same alert.** Sending the same `{{body.id}}` twice while it is showing raises
  one alert. A clear with that id ends it, and a second clear changes nothing.
- **Raising it again.** The same alert sent after it was cleared, or after it ended on its own,
  shows again. This includes an alert with no id, which is keyed on its exact body: "Evacuate",
  then the all-clear, then the same "Evacuate" shows the second time too.
- **Automatic end.** Alerts end on their own after the minutes you set, 60 by default.
- **One hook for both.** "Raise or clear, depending on a field" reads a field such as
  `{{body.status}}`. Values like `cleared`, `ended`, `cancelled` or `all clear` clear the alert;
  anything else raises it.
- **Clear without an id.** A clear with no id ends every alert the hook raised (an all-clear).
- **Severity.** Words like `critical`, `high` or `low` are mapped onto Extreme, Severe or Minor.
- **Testing.** **Test** runs the hook for real: the alert shows on screens until it is cleared or
  ends.

### Mass notification: Alertus, InformaCast, CAP

Point the system's webhook, or its "CAP to IP" / "HTTP POST" output, at a **Mass notification**
hook.

**CAP 1.2 XML.** Each `<alert>` is keyed on its own `sender` and `identifier`.

- **Updates and cancels.** An `Update` or `Cancel` ends the alerts its `<references>` name, so a
  cancel from the sender clears the screens. That is final: the same `identifier` sent again after
  its cancel is treated as a retry and stays off screens. A clear from the hook itself (a JSON
  all-clear, say) is not final, and the alert can be raised again.
- **Not shown.** `Exercise`, `Test` and `System` messages never take a screen.
- **Expiry.** With no `<expires>`, an alert ends after the minutes you set, 120 by default.

**JSON.** The usual field names are found by themselves, at the top level or under `data`, `alert`,
`message`, `notification`, `payload`, `event` or `incident`:

| Meaning | Field names tried, in order |
| --- | --- |
| alert id | `id`, `alertId`, `alert_id`, `messageId`, `notificationId`, `incidentId`, `uuid`, `guid`, `identifier` |
| headline | `headline`, `title`, `subject`, `alertName`, `name`, `messageTitle`, `presetName`, `alertProfile` |
| message | `message`, `body`, `text`, `description`, `alertText`, `messageBody`, `content`, `details` |
| severity | `severity`, `priority`, `level`, `urgency`, `alertLevel` |
| cleared | `status`, `state`, `action`, `alertStatus`, `eventType` reading cleared/ended/cancelled/…; or `cleared`, `isClear`, `allClear` true; or `active` false |

If your sender uses other names, set a **field mapping** on the hook, for example
`{{body.ref}}` for the id. The same alert sent twice, or retried, shows once. A clear ends it once.
A body with no id uses the exact body as its id, so a duplicate POST still counts as one alert.

> These field names cover the common Alertus and InformaCast webhook payloads. Check a real alert
> with **Test** before relying on it. Vendors' payloads differ by version and by how the action is
> set up on their side.

### Fire a trigger

The hook relays the trigger to each assigned screen, the same way the trigger's own network door
would. The screen still decides whether the trigger applies.

- **Which screens.** This works over the internet only on **Raspberry Pi and Windows** screens.
  Other players listen for triggers on their own network, and the hook's result counts them as
  "can't be fired over the internet".
- **Allowed sources.** The trigger must accept HTTP as a source.
- **Head office alerts.** Head office emergency alerts can't be fired from a hook.

### Update a table

Send a list of rows. A list of objects is matched to the table's columns by name, ignoring case. A
list of lists is matched by position. **Rows** says where they are in the request: `{{body}}`
(the default) also finds `rows`, `items`, `data`, `records` or `results`. The modes:

- **Replace all rows**
- **Update or add rows by key**, which needs a key column
- **Add rows**

A table keeps at most 200 rows.

### Switch to a playlist

Screens in scope play the playlist, full screen, for the minutes you set. The minutes can also be
taken from a field. Then the screens go back.

- **Repeats.** Calling the hook again restarts the time; it does not stack.
- **Switch back.** A "Switch screens back" hook, or deleting the hook, ends it early.
- **What it never overrides.** It never applies to a screen on a **head office playlist**, and an
  emergency alert still comes first.
- **Tags.** A tag scope is resolved to the screens with that tag when the switch starts.

## Zapier

The integration lives in [`zapier/`](../zapier). It is a private Zapier app: push it to your own
Zapier account with the Zapier CLI, as its README describes. Connect it with:

- **ScreenTinker address**, for example `https://app.screentinker.com`
- **API token** from **Settings → API tokens**

**Triggers** are instant, through REST hooks:

- Screen went offline
- Screen came back online
- Emergency alert raised (from a feed, a hook or Zapier)
- Emergency alert cleared
- Content approved
- Playlist published

**Actions:**

- Raise or clear an emergency alert
- Switch screens to a playlist
- Fire a trigger
- Update a table

| Token scope | What it can do |
| --- | --- |
| `read` | Test the connection, read recent events, fill dropdowns |
| `write` | The above, plus update tables. Subscribing to triggers also needs a workspace admin's token. |
| `full` | Everything, including alerts, playlists and triggers. Also needs a workspace admin's token. |

Subscribing and unsubscribing send this workspace's events to an outside address, so they need a
workspace admin, the same as managing subscriptions on the Automation page.

Alerts raised from Zapier appear on the Automation page as the **Zapier: emergency alerts** hook,
where they can be seen, cleared or switched off.

- **Each alert keeps its own screens.** An alert stays on the screens its own call chose. Another
  Zap raising a different alert somewhere else doesn't move it, and a clear by alert id never
  changes which screens anything is on. Raising the same alert id again with different screens
  moves that alert.
- **Switched off means off.** While the hook is switched off, the emergency action answers `409`
  with `code: "ZAPIER_HOOK_DISABLED"`. Switch it back on, or delete it so the next call starts a
  new one.

### The API, for Make, n8n, Power Automate or your own code

Everything is under `https://<your server>/api/zapier`, with `Authorization: Bearer st_…`. The
endpoints are in the [API reference](openapi.yaml):

| Call | What it does |
| --- | --- |
| `GET /me` | Auth test. Returns the workspace. |
| `GET /events?event=emergency_raised` | Recent events, newest first, each with a stable `id` to deduplicate on. With none yet, it returns one `sample: true` event. |
| `POST /subscriptions` `{ "event", "target_url" }` | Subscribes a webhook. Returns `{ id, signing_secret }`. |
| `DELETE /subscriptions/<id>` | Unsubscribes. Safe to repeat. |
| `POST /actions/emergency` | `{ op: raise\|clear, alert_id, headline, message, severity, expires_min, group_id \| device_id \| tag }` |
| `POST /actions/playlist` | `{ op: start\|stop, playlist_id, minutes, group_id \| device_id \| tag }` |
| `POST /actions/trigger` | `{ trigger_id, op: fire\|clear }` |
| `POST /actions/data` | `{ data_source_id, mode, key_column, rows: [...] }` |

**Deliveries to a subscribed webhook:**

- **Body.** A `POST` of the event as JSON.
- **Headers:**
  - `X-ScreenTinker-Event: <event>`
  - `X-ScreenTinker-Delivery: <id>`
  - `X-ScreenTinker-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`, using the subscription's
    `signing_secret`
- **Address rules.** The target must be `https` on a public address. Redirects are not followed.
- **410 Gone.** The subscription is removed, which is Zapier's convention.
- **Other failures.** Retried after 1, 5, 30 and 120 minutes, then kept as failed. The Automation
  page shows each subscriber's deliveries.
- **Fair delivery.** Deliveries are sent several at a time, taking turns between workspaces, with a
  cap per workspace and per receiving host. A receiver that is slow or down delays only its own
  deliveries, never another workspace's.

**Make and n8n.** Use their "custom webhook" trigger with `POST /subscriptions`, or poll
`GET /events`. For actions, either call the endpoints above with an HTTP module, or call a hook
address, which needs no token.
