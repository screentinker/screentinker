'use strict';

// Security: never return a device's WebSocket auth secret to API/dashboard
// clients. `device_token` is the credential the device proves with (validated
// via crypto.timingSafeEqual on the /device socket); leaking it to any
// workspace user enables device impersonation. Strip it from every device row
// before it leaves the server.
function stripDeviceSecrets(d) {
  if (!d || typeof d !== 'object') return d;
  delete d.device_token;
  return d;
}

// List responses additionally drop `settings_pin`.
//
// The PIN unlocks the player's on-device settings menu (2x Back), i.e. physical control of
// the panel. The dashboard genuinely needs it — but only on ONE screen, the device detail
// page, which fetches a single device via GET /api/devices/:id. The collection endpoint was
// handing out the PIN for EVERY device in the workspace on every load, to every member,
// with no consumer for it. Same data, far wider blast radius, for nothing.
//
// So: detail keeps it (the feature is unchanged), the list does not. If a future list view
// needs the PIN, fetch the device rather than widening this.
function stripDeviceSecretsForList(d) {
  const row = stripDeviceSecrets(d);
  if (row && typeof row === 'object') {
    delete row.settings_pin;
    // Same reasoning as the PIN: the trigger secret has exactly one consumer, the device detail
    // page, and handing it out for every device in the workspace on every list load is the same
    // data with a far wider blast radius for nothing.
    delete row.trigger_secret;
    // And the local API secret, for the same reason a fourth time — this one authorises reload,
    // screen on/off, volume and brightness from the LAN, so it outranks the trigger secret.
    delete row.local_api_secret;
    /*
     * #313: same reasoning a third time. The enrolment key names a display and proves you may be
     * it — anything holding it can become that screen. Its only consumer is the device detail
     * page, which shows the operator the player URL to paste into vMix. Handing it out for every
     * display in the workspace, on every dashboard load, to every member, is the same data with a
     * far wider blast radius for nothing.
     */
    delete row.enrol_key;
  }
  return row;
}

/*
 * ⚠️ NONE OF THESE REMOTE CREDENTIALS IS EVER GIVEN TO AN API TOKEN, even a full-scope one, and
 * this is a stronger rule than the one applied to settings_pin.
 *
 * The PIN unlocks a menu for someone already standing at the panel. These are remote credentials,
 * and each converts a read into a write that no scope on that token ever granted:
 *
 *   trigger_secret — makes an unauthenticated LAN datagram change what a screen displays, so a
 *     READ-scoped integration token would become "may put content on any of them".
 *   local_api_secret — Goal B part 3. Turns a LAN HTTP request into "reload this screen, blank it,
 *     change its volume". Withheld on the same reasoning as trigger_secret and more firmly: the
 *     trigger secret can only show what the workspace already assigned to that screen, while this
 *     one can stop the screen showing anything at all.
 *   enrol_key      — is strictly MORE than that. It does not push content to a screen; it lets the
 *     holder BE the screen: register as that display, receive its playlist and its commands, and
 *     report as it. It was withheld from the device LIST for blast radius (the reasoning that
 *     governs settings_pin) and that is where the first version stopped — the detail endpoint has
 *     no scope gate, so a read-scoped token could read it. Same class of escalation as the trigger
 *     secret, on a credential that outranks it.
 *
 * A dashboard session keeps all of them, because a human configuring a Crestron panel has to type
 * the secret somewhere, and the operator pasting a player URL into vMix has to be able to read it —
 * those screens are the only place either exists. The key is opt-in and only ever set on a display
 * somebody asked to make a web player, so this narrows an exposure rather than removing a feature.
 */
function stripSecretsForTokens(d, viaToken) {
  if (viaToken && d && typeof d === 'object') {
    delete d.trigger_secret;
    delete d.local_api_secret;
    delete d.enrol_key;
  }
  return d;
}

/** @deprecated the name predates the enrolment key; kept so no call site silently keeps the old,
 *  narrower behaviour. Both names do the same, complete thing. */
const stripTriggerSecretForTokens = stripSecretsForTokens;

module.exports = {
  stripDeviceSecrets, stripDeviceSecretsForList, stripSecretsForTokens, stripTriggerSecretForTokens,
};
