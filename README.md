# Epic Claims

Autonomous claimer for the Epic Games Store's weekly free games on macOS.
Runs as a `launchd` agent, discovers what is free, and either claims it, asks you
first, or applies your own rules — then verifies the entitlement actually landed
in your account.

No AI, no LLM, no external service at runtime. Every decision is explicit
application logic driven by configuration.

```
epic-claims auth login      # one-time Epic sign-in (opens a browser)
epic-claims service install # run in the background, every day at 17:30
epic-claims status          # what is happening right now
epic-claims update          # download, verify, install, restart — data untouched
```

## Why it is built the way it is

- **Ownership is verified, never assumed.** A claim is only "done" when Epic's
  entitlement endpoint says you own the item. A confirmed order without a
  verified entitlement is recorded as a failure, not a success.
- **The first scan claims nothing.** A fresh install records what is on offer
  (`baseline.completed_at`) and sends one summary. You then claim everything
  (`epic-claims claim --all`), one game from the dashboard, or let the configured
  mode take over from the next scan onward.
- **Updates replace binaries only.** Executables live in
  `…/install/versions/<version>` behind a `current` symlink; configuration,
  SQLite history and Keychain items live elsewhere and are never rewritten by an
  update.
- **Notification channels are adapters.** The claim engine emits typed events;
  adapters render and deliver them. Disabling or breaking iMessage cannot affect
  claiming, and a channel being down is never read as approval.

## Schedule — anchored to the publish instant, not to a local clock

Epic publishes at **11:00 America/New_York**: 16:00 UTC in winter (17:00 CET,
08:00 PST) and 15:00 UTC in summer (17:00 CEST). That is an *instant*, so the
only correct rule for "30 minutes after the games go live" is expressed in the
publisher's zone and then applied everywhere:

```json
"scheduling": {
  "mode": "release",
  "releaseTime": "11:00",
  "releaseTimeZone": "America/New_York",
  "scanOffsetMinutes": 30
}
```

The scan runs **every day at (publish instant + 30 min)**, whatever the machine's
own zone is:

| Machine zone | Winter (publish 16:00Z) | Summer (publish 15:00Z) |
|---|---|---|
| Brussels | 17:30 | 17:30 |
| London | 16:30 | 16:30 |
| New York | 11:30 | 11:30 |
| Tokyo | 01:30 (Fri) | 00:30 (Fri) |
| Sydney | 03:30 (Fri) | 02:30 (Fri) |

No per-machine tuning is needed, and no time zone has to be configured. During
the two-to-three weeks each year when the US and EU switch DST on different
dates the Brussels clock reads 16:30 or 18:30 for the scan — correct, because
the release instant is the thing being followed, not a local hour.

A missed scan is recovered: if the Mac was asleep or off at that moment, the
check runs as soon as the agent starts, once, then returns to the daily rule.
Two other modes exist for people who want them — `daily` (fixed local wall-clock
time, e.g. `"dailyTime": "17:30"` with `"timeZone"` empty for "this machine") and
`interval` (every N hours).

## Claiming modes

| Mode | Behaviour |
|---|---|
| `approval` (default) | Each new eligible offer creates one approval request. Nothing is claimed without an explicit decision. |
| `auto` | Claims every eligible free offer. |
| `hybrid` | Your rules decide; the first matching rule wins, and anything unmatched asks for approval. |

```bash
epic-claims config set claiming.mode approval
```

Hybrid rules match on `kind` (game / dlc), `publisher`, `title`, `price` or
`discount_percent`, with `is`, `is_not`, `contains`, `not_contains`, `matches`,
`gte`, `lte`. They are editable in the dashboard (Settings → Hybrid rules).

Approvals expire after `claiming.approvalExpiryHours` (default 72 h) and then
follow `claiming.approvalExpiryAction` (`skip` or `keep_pending`). A notification
that fails to arrive is never treated as consent.

## Architecture

```
src/
  shared/      paths, logging (secret redaction), semver, retry/backoff, http, clock, typed events
  db/          SQLite (node:sqlite — no native modules), migrations, repositories
  config/      zod schema, atomic config.json store, validation
  auth/        macOS Keychain, Epic OAuth (browser exchange-code → refresh token)
  providers/   StoreProvider interface + Epic client, parser, provider
  claim/       deterministic policy, idempotent claim engine
  scheduler/   wall-clock daily scheduler + missed-run recovery
  notify/      adapter interface, manager, macOS + iMessage adapters, templates
  api/         Fastify REST + dashboard, single-use approval links
  update/      GitHub releases, checksum + ed25519 verification, atomic install, rollback
  service/     launchd user agent
native/        Swift UserNotifications helper (LSUIElement, generic transport)
web/           React + TypeScript dashboard
```

**Identifiers are kept distinct** throughout: `offerId` (purchase), `catalogItemId`
(ownership/entitlements) and `entitlementName` (entitlement records). Conflating
them is the usual bug in free-game claimers.

**Adding a store** means implementing `StoreProvider`; the engine, database,
scheduler and notifications are unchanged. **Adding a notification channel** means
implementing `NotificationAdapter` and registering it; the claim engine is
unchanged. Both are covered by tests.

## Requirements

- macOS 12+ (developed and verified on macOS 15.8.3, Intel)
- Node.js 24 or newer (built and tested with 26.12.1)
- Google Chrome for the one-time sign-in (Playwright drives it; no browser download)
- An Epic Games account

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/DIY23/epic-claims/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
epic-claims auth login          # opens a browser; 2FA and captcha stay with you
epic-claims service install     # launchd agent, starts at login, keeps running
```

The installer verifies the release checksum, extracts into
`~/Library/Application Support/Epic Claims/install/versions/<version>` and links
`epic-claims` into `~/.local/bin`. No DMG, no manual copying, no rebuilds.

## Where things live

| What | Path |
|---|---|
| Binaries (replaced by updates) | `~/Library/Application Support/Epic Claims/install/` |
| Config, database, approval log | `~/Library/Application Support/Epic Claims/` |
| Logs | `~/Library/Logs/Epic Claims/` |
| Epic session | login Keychain, service `Epic Claims` |
| launchd agent | `~/Library/LaunchAgents/com.diy23.epic-claims.plist` |

## Dashboard

`http://127.0.0.1:8781/` once the service is running. The API requires a bearer
token (`epic-claims config token`); the dashboard asks for it once. Approval
links (`/approve/<token>`) are single-use, expiring and loopback-only, which is
what the macOS notification buttons and the iMessage replies use.

## Notifications

Two adapters, configured and toggled independently, with separate templates per
platform:

- **macOS** — the bundled `EpicClaimsNotifier.app` (UserNotifications,
  `LSUIElement`). Approval notifications carry working **Claim** / **Skip**
  buttons that can be answered from the lock screen. Authorization must be
  approved once by a human (`System Settings → Notifications → Epic Claims`).
- **iMessage** — sends through Messages.app (AppleScript) or an optional
  BlueBubbles bridge; approvals come back as `CLAIM <code>` / `SKIP <code>` from
  the configured sender, read from `chat.db` (needs Full Disk Access).

Every event has a switch per channel, and every template is editable and
previewable in the dashboard. Variables: `{game_name}`, `{publisher}`,
`{offer_start}`, `{offer_expiry}`, `{claim_status}`, `{store_name}`,
`{approval_url}`, `{approval_code}`, `{error_code}`, `{hours_left}` and others
per event. Templates are validated: unknown variables are rejected, not silently
dropped.

## Updating

```bash
epic-claims update          # install the newest stable release
epic-claims update check    # report only
epic-claims update --beta   # prerelease
epic-claims version
```

The updater downloads the release tarball, verifies its SHA-256 against the
published `SHA256SUMS` (and an ed25519 signature when `updates.publicKey` is
set), extracts into a new version directory, backs up the database, runs
migrations under the new code, flips the `current` symlink atomically, restarts
the agent and health-checks it. If anything fails it flips back and reports the
rollback. An update in progress never interrupts a redemption: it waits for
in-flight claims (`updates.drainTimeoutSeconds`) and refuses if one is still
running.

`updates.preference` is `manual`, `notify` (default) or `auto`. Prereleases are
only installed when the channel is set to `beta`.

## CLI

```
epic-claims status | check [--claim] | claim [<id>] [--all]
epic-claims history [--kind offers|claims|approvals|notifications|events|updates|logs]
epic-claims auth login|status|logout
epic-claims approvals list|approve <id|code>|skip <id|code>
epic-claims notifications list|test --adapter macos|show
epic-claims service install|start|stop|restart|status|uninstall
epic-claims update [check|status] [--beta] [--dry-run] [--version X]
epic-claims version | config path|show|set|reset|token | db migrate|backup|stats | logs
epic-claims serve            # foreground: API + scheduler + poller
```

Exit codes: `0` ok · `1` error · `2` usage · `3` authentication required ·
`4` busy (claim in progress / update blocked).

## Development

```bash
npm ci
npm run build        # tsc + dashboard bundle
npm test             # 178 tests
npm run typecheck
npm run native       # build the Swift helper (swiftc, CLT only)
npm run package      # release tarball + SHA256SUMS
npm run serve        # run locally without launchd
```

Tests use fixtures and a mock provider; no real Epic transaction is ever made.
The updater tests run a local HTTP server that serves real tarballs, so download,
verification, extraction, migration ordering and rollback are exercised
end to end — including an assertion that the data directory is byte-identical
after an update.

## Known limitations

- **Epic has no public claiming API.** Discovery uses the storefront's
  `freeGamesPromotions` endpoint; ownership uses EOS Ecom; redemption uses the
  checkout SPA endpoints (`purchaseToken` → `order-preview` → `confirm-order`).
  All are undocumented and can change without notice — they are isolated in
  `src/providers/epic/` for that reason. See `docs/epic-interface.md`.
- **Sign-in is human.** 2FA and captcha are never automated; the interactive
  window exists precisely so they stay with you. Afterwards the refresh token
  keeps the session alive (usually months).
- **Notifications need one approval click** on the machine, once. Until then the
  macOS adapter reports "not determined" and falls back to `osascript` banners
  without action buttons.
- **iMessage reading needs Full Disk Access** for the process that runs Epic
  Claims; without it approvals still work through the dashboard, the CLI and the
  notification buttons.
- **DLC**: an add-on may require its base game. The engine claims what is free
  and reports the prerequisite failure instead of guessing.
- **Re-signing the notification helper** can reset the notification permission
  (macOS keys the grant to the ad-hoc signature). The helper is therefore kept
  behaviour-free so it rarely changes.

## Licence

MIT © DIY23. See `LICENSE`.
