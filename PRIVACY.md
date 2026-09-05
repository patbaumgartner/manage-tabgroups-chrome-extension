# Privacy

This extension collects nothing, sends nothing, and has no way to do either.

## What is stored

Saved sessions live in `chrome.storage.local`, on your device, inside your
browser profile. Each saved group contains:

- the group's name, colour and collapsed state
- for each tab in that group: its `http(s)` address and its page title

That is the whole data set. No cookies, no page content, no form data, no
identifiers, no timing information beyond the timestamp on each snapshot.

## What is never stored

- Tabs that are not in a group, and pinned tabs
- Browser pages, extension pages, `file://` URLs and `data:` URLs
- URLs containing a username or password, which are rejected outright

The extension does read every tab in the windows it is acting on, because that
is the only way to know which tabs belong to a group and whether closing a group
would leave a window empty. Nothing about the other tabs is written anywhere.

## Where it goes

Nowhere. There is no server, no analytics, no crash reporting, no update ping.

- The extension declares **no host permissions**, so it cannot talk to any site.
- Its content security policy sets `connect-src 'none'`, which blocks outbound
  connections from its own pages.
- The bundle contains no `fetch`, `XMLHttpRequest`, `WebSocket` or
  `navigator.sendBeacon`. CI fails if any of them is ever added.
- `chrome.storage.sync` is not used, so nothing is uploaded to a Google account.
  CI fails if it is ever used.

You can verify all of this yourself: the extension ships as readable source with
no build step, and `npm run validate` re-checks these properties.

## Export files

Exporting writes a plain JSON file containing the addresses and titles of your
saved tabs. It is not encrypted, because it is meant to be inspected and moved
between your own machines. Treat it like an export of your browser history:
keep it private, and do not attach it to a bug report.

## Deleting your data

- **One session** — delete it from the popup or the options page.
- **Everything** — *Danger zone → Delete all saved sessions* on the options page.
- **Completely** — removing the extension from your browser deletes its local
  storage with it.

## Changes

Any change to what is stored or where it goes will be recorded in
[CHANGELOG.md](CHANGELOG.md) and reflected here in the same release.
