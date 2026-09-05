# Security Policy

## Reporting a vulnerability

Please report privately through
[GitHub Security Advisories](https://github.com/patbaumgartner/manage-tabgroups-chrome-extension/security/advisories/new)
rather than opening a public issue.

Include what an attacker would gain, how to reproduce it, and the browser and
extension version. A first response should arrive within seven days.

Do not attach an export file to a report: it contains your browsing history.

## Supported versions

Only the most recent release is supported. There is no auto-update path for an
extension loaded unpacked, so please pull the latest tag before reporting.

## Threat model

The extension holds a list of URLs and titles, and it can open and close tabs.
The interesting question is therefore not "can it be attacked over the
network" — it makes no network requests — but "what happens when the data it
trusts turns out to be hostile".

### What it defends against

| Threat                                                            | Defence                                                                                                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A stored or imported session restores a `javascript:` URL          | `normalizeUrl` allows only `http` and `https`, and it is applied on write, on read **and** again immediately before the tab is created |
| A crafted export file drives the extension into an unsafe state    | `parseExport` requires the exact format marker, rejects a newer schema version, caps the file at 8 MB and 100 sessions, and drops every entry it cannot make safe |
| A crafted export file quietly evicts the user's real backups       | Timestamps from the future are clamped, oversized sessions are refused, and the import reports how many entries were kept, skipped and pushed out |
| A hostile page title spoofs the popup with bidi or zero-width text | `sanitizeText` strips control, bidi and zero-width characters; all UI text is set through `textContent`                |
| Untrusted JSON pollutes `Object.prototype`                         | Parsed data is only ever read field by field; no `Object.assign`, no recursive merge, covered by a regression test    |
| A URL with embedded credentials is silently replayed               | URLs carrying a username or password are rejected outright                                                            |
| Another extension or a web page drives the service worker          | No `externally_connectable`, no content script, and every message is checked against `sender.id` and a type allowlist |
| Remote code execution inside the extension                         | `script-src 'self'`, no `eval`, no `new Function`, no `innerHTML`, no remote script; asserted by `npm run validate`   |
| Data exfiltration                                                  | **No host permissions**, which is what actually stops the service worker reaching any origin (the page CSP does not gate service-worker `fetch`). Extension pages are separately pinned by `default-src 'none'` with `connect-src 'none'`. No `fetch`, `XMLHttpRequest`, `WebSocket` or `sendBeacon` appears in the bundle, and remote images, stylesheets and CSS `url()` references are rejected by the validator |
| Storage exhaustion                                                 | Hard caps on groups, tabs and bytes per session, plus a bounded number of stored sessions                             |
| Losing tabs the extension cannot represent                         | Only tabs that were successfully written into a session are closed, and only while they still hold the URL that was stored for them |
| Losing tabs to a storage failure                                   | The session is read back from storage and confirmed present before a single tab is closed                            |
| Losing a session to a concurrent action                            | Every read-modify-write on storage runs through a mutation queue, so two actions cannot overwrite each other          |
| Overwriting data written by a newer version                        | Writes refuse to proceed when the profile carries a higher schema version                                             |

### What it does not defend against

- **A compromised browser profile.** Anything that can read
  `chrome.storage.local` can read your saved sessions. That is the same
  exposure as your browser history.
- **Export files.** They are plain, unencrypted JSON by design, so they can be
  inspected and edited. Store them accordingly.
- **A malicious build.** Verify the release checksum, or load the folder
  straight from a clone you have read.
- **Physical access to an unlocked machine.**

## Verifying a release

```bash
sha256sum -c manage-tabgroups-<version>.zip.sha256
```

The archive is built deterministically by
[`scripts/build.mjs`](scripts/build.mjs) — same input, same bytes — so you can
reproduce the published checksum locally with `npm run build`.

## Automated guarantees

`npm run validate` runs in CI and fails the build if the extension ever gains a
host permission, a content script, a web-accessible resource, an
`externally_connectable` entry, an unexpected permission, an inline script or
event handler, `eval`, `innerHTML`, a network API, or `chrome.storage.sync`.
CodeQL analyses every push with the `security-and-quality` query suite.
