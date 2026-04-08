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

If you discover a security vulnerability, please email **support@screentinker.com** instead of opening a public issue.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
