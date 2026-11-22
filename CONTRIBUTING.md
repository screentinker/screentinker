# Contributing to ScreenTinker

Thanks for your interest in contributing! Here's how to get started.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/screentinker.git`
3. Install dependencies: `cd server && npm install`
4. Start the dev server: `npm run dev`
5. Open `http://localhost:3001`

## Making Changes

1. Create a branch: `git checkout -b my-feature`
2. Make your changes
3. Test locally — make sure the server starts and the feature works
4. Commit with a clear message describing what changed and why
5. Push and open a pull request

## What to Contribute

- Bug fixes
- New widget types for the content designer
- Device platform support (e.g., new player implementations)
- Documentation improvements
- Translations (see `frontend/js/i18n.js`)
- Performance improvements

## Guidelines

- Keep PRs focused — one feature or fix per PR
- No build step for the frontend — it's vanilla JS by design
- Don't add heavy frameworks or dependencies without discussion
- Follow the existing code style
- Test on at least one device type if changing player/device code

## Reporting Issues

Open an issue on GitHub with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Browser/device/OS info if relevant

## Security

If you discover a security vulnerability, please report it privately as described in [SECURITY.md](SECURITY.md) instead of opening a public issue.

### The security scan in CI

`server/test/security-static.test.js` runs `server/scripts/security-scan.js`, a set of checks mapped to the OWASP Top 10, over the server, the player and the dashboard. It fails when a change adds a finding that is not already recorded in `server/test/security-baseline.json`. The two rules that matter most here, because past advisories were exactly these:

- **No user data into HTML without escaping.** Use `textContent`, or wrap every `${...}` in `esc()`. For anything that becomes a URL (`href`, `src`, `location`, `window.open`), escaping is not enough: allow only `http:`/`https:` or build it from a fixed path.
- **Every server-side fetch of a URL a user, tenant or upstream API supplied goes through `server/lib/ssrf-guard.js`.**

Run `cd server && node scripts/security-scan.js` to see new findings locally. If one is genuinely safe, put `// security-ok(<rule>): <why it is safe>` on or above the line. The reason is the review record, so make it specific. CI also runs `npm audit` on production dependencies and fails on high or critical.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
