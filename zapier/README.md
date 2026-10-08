# ScreenTinker for Zapier

A [Zapier Platform CLI](https://github.com/zapier/zapier-platform/tree/main/packages/cli) app. It is a
**private** integration you push to your own Zapier account; it is not in Zapier's public directory.

```sh
cd zapier
npm install
npx zapier-platform-cli login
npx zapier-platform-cli register "ScreenTinker"   # once
npx zapier-platform-cli push
```

Then invite yourself (or your team) from the Zapier developer platform, and connect it with your
ScreenTinker address and an API token. See [docs/automation.md](../docs/automation.md) for what the
triggers and actions do, which token scope each needs, and how to use the same endpoints from Make,
n8n or any HTTP client.
