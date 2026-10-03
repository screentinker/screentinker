'use strict';

/*
 * Skills we publish for agents (Agent Skills Discovery RFC v0.2.0).
 *
 * ⚠️ THE DIGEST IS COMPUTED FROM THE BYTES WE SERVE, never stored beside them. The index publishes a
 * sha256 an agent may verify before trusting the artifact; a digest maintained by hand is wrong the
 * first time anybody edits the prose, and a mismatch reads as tampering rather than as staleness.
 *
 * ⚠️ These describe what this product ACTUALLY does. A skill is read by something that will then go
 * and act, so a plausible-sounding instruction that does not match the API is worse than no skill:
 * the agent follows it, fails, and has no way to tell that the DOCUMENT was wrong.
 */

const crypto = require('node:crypto');

const SKILLS = [
  {
    name: 'manage-digital-signage',
    description: 'Inspect and control ScreenTinker screens: which are online, what they are playing, '
      + 'and send them commands.',
    body: (base) => `# Manage digital signage with ScreenTinker

Inspect and control a ScreenTinker screen estate — which displays are online, what each is playing,
and the commands a display accepts.

## Connect

ScreenTinker serves a Model Context Protocol endpoint at \`${base}/mcp\`. Point an MCP client at it
with a ScreenTinker API token:

    Authorization: Bearer st_...

⚠️ **You cannot obtain a token yourself.** A human creates one in the dashboard under
Settings → API tokens. There is no registration endpoint. If you do not have a token, stop and ask
for one rather than probing for a way to mint it. Full details: ${base}/auth.md

The same operations are available as a REST API described at \`${base}/openapi.yaml\`, if you would
rather call it directly than speak MCP.

## What you can see

- \`fleet_status\` — the one call worth making first: totals, and every offline display with the
  reason it is considered offline.
- \`list_displays\` / \`get_display\` — a display's status, resolution, what it is playing now.
- \`uptime_report\` / \`play_report\` — proof of play and availability over a date range.

## What you can change

- \`create_playlist\`, \`add_to_playlist\`, \`remove_from_playlist\`
- \`publish_playlist\`
- \`assign_playlist_to_display\`, \`assign_playlist_to_group\`
- \`send_command\`, \`send_group_command\` — \`refresh\`, \`screen_on\`, \`screen_off\`,
  \`set_volume\`, \`set_brightness\`.

## Two things that will catch you out

⚠️ **A playlist edit is a DRAFT.** Screens keep playing the last published version until you call
\`publish_playlist\`. A change you did not publish has changed nothing anybody can see, and the
dashboard will agree with you that the edit was saved.

⚠️ **The tool list depends on your token.** A read-only token is shown ten tools and is never told
the write tools exist. If a tool you expected is absent, your token's scope is the reason — asking
again will not reveal it.

## Failure

- \`401\` — the token is missing, revoked, or you are calling a surface tokens cannot reach at all.
  Retrying does not help; re-read ${base}/auth.md.
- \`403\` — the token is valid but its scope does not permit this method.
`,
  },
  {
    name: 'screentinker-player-setup',
    description: 'Choose hardware for a ScreenTinker screen and get the right player onto it.',
    body: (base) => `# Set up a ScreenTinker player

Getting a screen playing: which device to use, and which player it needs.

## Pick the hardware first

${base}/certified-hardware.html lists what has actually been tested, what each device really does,
and what to avoid. ⚠️ It distinguishes **Certified** (tested, supported) from **Community reported**
(someone got it working, no support commitment) and **Not supported**. Read it before recommending a
purchase — several popular devices are on the third list for concrete reasons.

Known-not-supported, so do not suggest them:

- **Apple TV** — tvOS ships no web view and an app may not carry its own engine.
- **Fire TV Stick 4K Select / HD (2026)** — these run Vega OS, not Android; the APK will not install.

## Get the player onto it

${base}/download lists every player **this instance can actually hand out**, already pointed at it.
⚠️ Use that page rather than a GitHub release: the BrightSign archive has the server URL written into
its bytes when it is built, so a release asset points a new screen at the wrong server — which
presents as a pairing failure, not as a packaging one.

Eleven platforms have a setup guide, linked from ${base}/download.

## Pair it

The player shows a pairing code. A human enters it in the dashboard under Add Display. There is no
API that pairs a screen on your behalf.
`,
  },
];

/** The exact bytes we serve for a skill, so the digest describes them. */
function skillMarkdown(skill, base) {
  return skill.body(base);
}

function digestOf(text) {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function skillsIndex(base) {
  return {
    $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
    skills: SKILLS.map((s) => {
      const text = skillMarkdown(s, base);
      return {
        name: s.name,
        type: 'skill-md',
        description: s.description,
        url: `${base}/.well-known/agent-skills/${s.name}/SKILL.md`,
        digest: digestOf(text),
      };
    }),
  };
}

function byName(name) {
  return SKILLS.find((s) => s.name === name) || null;
}

module.exports = { SKILLS, skillsIndex, skillMarkdown, digestOf, byName };
