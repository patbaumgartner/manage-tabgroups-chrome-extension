# Contributing

Thanks for taking the time. This project is small on purpose, and the fastest
way to get a change merged is to keep it that way.

## Ground rules

The extension makes three promises that a pull request must not break:

1. **Four permissions.** `tabs`, `tabGroups`, `storage`, `alarms`. No host
   permissions, no content scripts, no web-accessible resources.
2. **No network access, ever.** No `fetch`, no `XMLHttpRequest`, no
   `WebSocket`, no `sendBeacon`, no remote script, no `chrome.storage.sync`.
3. **No build step.** `extension/` is exactly what the browser runs, so anyone
   can read the code they installed.

`npm run validate` enforces all three, and it runs in CI.

Two more, less mechanical:

4. **Untrusted data is normalized in one place.** Page titles, stored JSON and
   imported files all pass through `extension/src/model.js`, which is pure and
   heavily tested. Do not scatter validation elsewhere.
5. **Never close what you have not saved.** If the extension cannot represent a
   tab, it leaves that tab alone.

## Getting set up

```bash
npm ci
npm run check   # lint, types, tests, bundle validation
npm run e2e     # drives a real Chromium browser
```

Then load `extension/` through **Load unpacked** on `chrome://extensions` and
try your change by hand. Reload the extension from that page after every edit.

## Development notes

- The source is plain ES modules typed with JSDoc, checked by
  `tsc --noEmit --strict`. There is no TypeScript syntax and no transpiler.
- Formatting and linting are handled by Biome: `npm run lint:fix`.
- Tests use the built-in Node test runner and an in-memory `chrome` API double
  in `tests/helpers/fake-chrome.mjs`. There is no test framework dependency.
- Every mutation lives in the service worker so it survives the popup closing.
  Do not move mutations into `popup/` or `options/`.
- Build DOM with `document.createElement` and `textContent`. Assigning
  `innerHTML` fails validation.
- The README screenshots are generated from the running extension by
  `npm run screenshots`, which drives a real browser through the same harness as
  the end-to-end run. The demo data in it is invented; never commit a screenshot
  containing real browsing history. Commit the files exactly as the script
  produces them - post-processing them means regenerating no longer reproduces
  what is in the repository.
- The icons are generated from `assets/icon.svg`:

  ```bash
  for size in 16 32 48 128; do
    rsvg-convert -w $size -h $size assets/icon.svg -o extension/icons/icon-$size.png
  done
  ```

## Submitting a change

- One logical change per pull request.
- Add a test for the behaviour, including the way it fails.
- Update `README.md` and `CHANGELOG.md` when user-visible behaviour changes.
- Commit messages: a short imperative subject line, and a body explaining why
  when the reason is not obvious.
- Bump the version in **both** `package.json` and `extension/manifest.json`;
  validation fails if they drift apart.

## Cutting a release

No version has been tagged yet. When one is:

1. Move the entries under `## [Unreleased]` in `CHANGELOG.md` into a new
   `## [x.y.z] - YYYY-MM-DD` section, and add the matching link definitions at
   the bottom of the file.
2. Set the same version in **both** `package.json` and
   `extension/manifest.json`; `npm run validate` fails if they disagree.
3. Commit, then tag `vx.y.z` and push the tag.

The release workflow re-runs every gate including the browser test, refuses to
publish if the tag, the manifest version and the changelog section do not all
agree, and then attaches the reproducible archive and its checksum. The rolling
`snapshot` pre-release is separate and is never promoted to a real release.

## Reporting bugs and vulnerabilities

Bugs go in [issues](https://github.com/patbaumgartner/manage-tabgroups-chrome-extension/issues).
Vulnerabilities go through a private advisory — see [SECURITY.md](SECURITY.md).

Never attach an export file to either: it contains your browsing history.

## Code of Conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
