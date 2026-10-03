# Webhook

POST JSON to an HTTPS URL when a display goes offline or online, when a playlist is published, when content is uploaded, or when a plugin zip is submitted / approved / rejected.

Enable plugins, restart, platform admin → **Plugins** → enable **Webhook**, restart again. Then open the plugin's settings on that same Admin page and paste the URL. Settings apply immediately — no third restart. Tick **When someone submits a plugin zip** if you want the webhook when an editor queues a package; it is off by default so an existing URL does not start firing a new event.

Body:

```json
{ "event": "device.offline", "at": "2026-09-15T04:00:00.000Z", "device_id": "…", "reason": "heartbeat_timeout" }
```

Playlist publishes send `id`, `name`, `workspace_id`. Content uploads send `content_id`, `workspace_id`, `mime`. Plugin review events send `submission_id`, `plugin_id`, and who submitted or decided — never zip bytes. Optional bearer token is sent as `Authorization` and never returned by the API.

The POST is SSRF-guarded the same way iCal is: loopback, RFC1918, and cloud-metadata targets are refused. Point it at Slack, Discord, ntfy, or a public HTTPS receiver — not at a box on your LAN unless that box is reachable on a public address.

Failures are logged. They never stall heartbeat, publish, or an upload.
