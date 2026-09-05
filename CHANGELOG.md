# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-09-05

First release.

### Added

- Save and close every tab group at once, in the current window or across all
  windows. The session is written to local storage before a single tab is
  closed, and only the tabs that were successfully saved are closed.
- Restore the most recent session — or any stored one — in a single click, with
  the original group names, colours, collapsed state and tab order.
- Automatic backups on a configurable interval (1–240 minutes, default 5),
  skipped when nothing changed since the previous snapshot.
- Keyboard commands for closing and restoring, assignable at
  `chrome://extensions/shortcuts`, with badge feedback.
- Options page with settings, full session management, and JSON export/import.
- Runtime detection of browsers without the `chrome.tabGroups` API, with a
  clear message instead of a silent failure.

### Security

- The session is read back from storage and confirmed present before a single
  tab is closed, so a storage failure or a retention limit can never turn
  "save and close" into data loss.
- Only the tabs that were saved are closed, and only while they still hold the
  URL that was stored for them, so a tab that navigated while the snapshot was
  being written stays open.
- Every read-modify-write on local storage runs through a mutation queue, so a
  backup alarm, a keyboard shortcut and the popup cannot overwrite each other.
- Writes refuse to proceed when the profile carries a newer schema version, and
  imports refuse a file written by a newer version, rather than silently
  normalising data away.
- Imported sessions cannot carry a timestamp from the future, cannot exceed the
  per-session size limit, and the result reports how many entries were kept,
  skipped and pushed out.
- Only `http` and `https` URLs are ever stored or restored. `javascript:`,
  `data:`, `blob:`, `file:` and browser-internal URLs are rejected, as are URLs
  carrying embedded credentials. The check runs on write, on read, and again
  immediately before a tab is created.
- Titles are stripped of control, bidirectional and zero-width characters, and
  all UI text is set through `textContent`.
- Imports require the exact format marker and are capped at 8 MB and 100
  sessions; anything that cannot be made safe is dropped and counted.
- Four permissions, no host permissions, no content scripts, no web-accessible
  resources, no `externally_connectable`, and a content security policy that
  starts from `default-src 'none'` and blocks `connect-src` entirely.
- `npm run validate` fails the build if any of the above regresses, including a
  remote image, stylesheet or CSS `url()` reference, and runs on every push
  together with CodeQL.

[Unreleased]: https://github.com/patbaumgartner/manage-tabgroups-chrome-extension/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/patbaumgartner/manage-tabgroups-chrome-extension/releases/tag/v1.0.0
