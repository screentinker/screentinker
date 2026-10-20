# Outbound requests and private addresses

Many features fetch a URL that someone typed in:
- calendar (iCal) and HTTP data sources;
- alert-channel and automation webhooks;
- single sign-on (OIDC);
- Canva;
- embedded renders and the media proxy;
- plugin egress;
- hosted AI endpoints.

Every one of those requests goes through one guard (`server/lib/ssrf-guard.js`). The guard allows
only http(s), resolves the host, refuses any **private, loopback or link-local** address, and pins the
connection to the address it vetted, so DNS rebinding cannot get round it. Redirects are re-checked
hop by hop.

That is the right default for a hosted instance, where anyone who can type a URL could otherwise make
the server fetch its own internal network. On a self-hosted instance the calendar, Home Assistant or
identity provider often *is* on the LAN, and the request is refused with **"The address is not
allowed"**.

## Allowing it

Set one of these in the server's environment and restart:

```bash
# Only what you name: hosts, *.suffixes, IPs and CIDRs (comma-separated)
OUTBOUND_ALLOW_HOSTS=calendar.lan,*.home.arpa,192.168.1.0/24,10.0.0.5

# Or every private-network range at once
OUTBOUND_ALLOW_PRIVATE=true
```

How the two settings decide:
- **A name**, exact or `*.suffix`, may resolve to a private address.
- **An IP or CIDR** opens that range, whatever name was used to reach it.
- **`OUTBOUND_ALLOW_PRIVATE`** opens the private-network ranges: RFC 1918 (`10/8`, `172.16/12`,
  `192.168/16`), loopback (`127/8`, `::1`), CGNAT (`100.64/10`), IPv6 unique-local (`fc00::/7`) and
  link-local.
- **Not opened:** `0.0.0.0`, multicast and the documentation ranges stay blocked.

⚠️ Prefer `OUTBOUND_ALLOW_HOSTS`. With `OUTBOUND_ALLOW_PRIVATE`, **any member who can enter a URL**
(a data source, a webhook) reaches every address on your network, including this server's own
loopback ports. That is fine for a single-household install and not for a shared one.

⚠️ **Cloud metadata is never opened**, whatever is set: `169.254.169.254`, `169.254.170.2`/`.23`,
`fd00:ec2::254`/`::23` and `100.100.100.200`. No calendar needs it, and its answer is credentials.

## Notes

- Both settings are off unless set, so a hosted instance is unchanged.
- **Storage backends** (S3, MinIO and the like) keep their own per-profile "allow private" switch,
  and honour these settings too.
- **A local AI server** (Ollama, LM Studio, …) can be allowed for AI requests only, one exact host for
  one organization, by a platform administrator: see [private-ai.md](private-ai.md).
- **The template catalog** has its own `TEMPLATE_CATALOG_ALLOW_PRIVATE` for a LAN mirror (see
  [templates.md](templates.md)).
- On a self-hosted instance, the "not allowed" message names these settings, so the next person
  finds this page.

- Every outbound request is also counted, host only, in the outbound connections ledger: see
  [trust.md](trust.md) (Platform → Data & privacy).
- ONVIF cameras ([onvif-cameras.md](onvif-cameras.md)): with `OUTBOUND_ALLOW_PRIVATE` the server can search the LAN for cameras and talk to them itself; with an `OUTBOUND_ALLOW_HOSTS` list it can reach those cameras by address but won't search. Without either, cameras are reached through a screen on their network.
