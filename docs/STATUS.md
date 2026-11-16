# Project status — paused 16/11/2026

Epic Claims is **paused** at v2.3.3. This file records exactly where it stands so a
future session (or another engineer) can resume without re-deriving anything.

## What is verified working (on the real machine, against the real store)

- **Epic auth.** Session in the login Keychain, refresh works unattended. Refreshes
  are presented with the client that minted the session (`EpicSession.clientId`);
  presenting it as another client answers `invalid_client`.
- **Discovery and ownership.** Live `freeGamesPromotions` discovery; ownership via
  `/ecom/v3/.../ownership`. Correctly reported an owned title as `already_owned`.
- **Claim engine.** Deterministic, idempotent, duplicate redemption blocked by two
  partial unique indexes plus an in-flight set. Approval → decision → attempt →
  ownership verification all recorded in SQLite.
- **Interactive notifications.** Native macOS notifications through the bundled
  helper with working **Claim / Skip** buttons; three real clicks were recorded as
  genuine decisions, one of which produced a verified claim result.
- **Self-updater.** ~15 real A→B upgrades on this machine through `epic-claims
  update`: atomic symlink flip, checksum + signature verification, pre-migration
  database backup, rollback, health probe. `config.json` and the SQLite database
  survived every one byte-identically.
- **launchd service.** Starts at login, survives crashes, keeps running with the
  screen locked.
- **Tests.** 169 passing in 9 files. `tsc --noEmit` clean.

## Known defects and gaps (do these first on resume)

1. **`epic-claims approvals test` does not exit.** It creates and delivers the
   approval, prints its output, then hangs instead of returning (observed: killed
   after 5 minutes). Every other CLI command returns normally. Likely a handle left
   open by the approval path — reproduce with `timeout`/`gtimeout` absent on this
   machine, so use a background run and `process_manage`.
2. **No real redemption has ever run.** Only `already_owned` and idempotent
   short-circuits have been exercised. `order-preview` → `confirm-order` →
   entitlement verification is fixture-tested only. The first genuine test is the
   first free game the account does not own.
3. **Banners are suppressed while the display is shared.** macOS DND mutes
   notifications (`reason: display shared`); delivery still happens and the item
   lands in Notification Center. Not a bug — documented so it is not re-diagnosed.
4. **`epic-claims update` right after publishing** reports "already up to date" for
   about a minute: GitHub caches the releases list. `update check --json` is correct
   immediately. Consider a `--force` flag or a short retry.
5. **CLI throws EPIPE** when output is piped into something that exits early
   (`epic-claims version | head -1`). Add a `process.stdout.on('error')` guard.
6. **No CI run has ever been observed** on GitHub Actions; the workflow files exist
   but their status is unverified.
7. **Dashboard** is served and returns 200; there is no automated UI test.

## Epic interface notes

- Free promotions: `https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions`
  (public, no auth). Entries carry `promotionalOffers` (live) and
  `upcomingPromotionalOffers` (announced).
- Ownership: `/ecom/v3/platforms/EPIC/identities/{accountId}/ownership?nsCatalogItemId=ns:item`
  (max 100 ids per call).
- Claim chain: `purchaseToken` → `/purchase/order-preview` → `/purchase/confirm-order`
  with `x-requested-with: <purchaseToken>`; success is `confirmation: true`.
  `quickPurchase` always returns `{"quickPurchaseStatus":"CHECKOUT"}` — it cannot be
  used to redeem.
- These are **undocumented** endpoints. They are isolated in
  `src/providers/epic/` behind a provider interface; changes there never touch the
  claim engine.

## Decisions that should not be relitigated

- **Release-anchored scheduling**: daily at Epic publish (`11:00`
  `America/New_York`) + 30 minutes, so it follows DST and stays correct in any
  timezone. Twice a year the Brussels machine runs at 16:30/18:30 local — correct,
  because the games really did go live then.
- **iMessage was removed** in 2.0.0 at the owner's request. The notification adapter
  interface and event bus remain: add a channel by writing one adapter, never by
  touching the claim engine.
- **First run discovers only** (`claiming.firstRun: discover_only`); nothing is
  claimed until the owner decides.
- **Versioned install directories** + a `current` symlink; the launchd plist must
  point at `install/current/dist/cli/index.js` or every update is a silent no-op.
- **The Swift helper is effectively frozen.** Ad-hoc signing means its identity is
  the cdhash, so rebuilding it can reset the user's notification grant. Do not
  rebuild it for cosmetic reasons.

## Reinstalling from scratch

```bash
# CLI, service and dashboard
bash scripts/install.sh          # from a checkout, or download a release archive
epic-claims auth login           # opens Epic's OAuth page, stores the session in Keychain
epic-claims notifications authorize   # click Allow once
epic-claims check                # discovery + ownership, no claiming
epic-claims service install      # launchd, start at login
```

Update with `epic-claims update`; add `--beta` for prereleases.
