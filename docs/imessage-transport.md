# iMessage Transport Spec — macOS 15, no Homebrew

Target: Intel Mac mini, macOS 15.8.3 (24H241), user `agent23`, Node v26.12.1, `/usr/bin/sqlite3` 3.43.2.
Purpose: pluggable transport for sending one text to a configured recipient and receiving replies
(`CLAIM <token>` / `SKIP <token>`).

Every claim below is marked:

- **VERIFIED** — reproduced on this machine, command + output quoted.
- **DOCUMENTED** — from primary source (Apple sdef, vendor docs, vendor source), not reproduced here.
- **NOT EXECUTED** — would have sent a real message or modified state; deliberately not run.
- **UNCERTAIN** — plausible but not confirmed; do not build on it without testing.

---

## 1. Sending: AppleScript through `osascript`

### 1.1 What macOS 15 actually exposes

**VERIFIED.** The scripting dictionary is at
`/System/Applications/Messages.app/Contents/Resources/Messages.sdef` (8,859 bytes). Its classes are:

```
account, chat, participant, file transfer
```

There is **no `message` class** and no received-message collection. `participant` carries
`<synonym name="buddy"/>` and `account` carries `<synonym name="service"/>`, so the legacy terms
`buddy` and `service` still compile — but they are aliases, not modern nouns.

The `send` command takes a `file` or `text` direct parameter and a `to` parameter accepting
`participant` or `chat`.

### 1.2 Which reference forms resolve on macOS 15

**VERIFIED** (`osascript` probe, `probe_target.applescript`):

| Reference | Result |
|---|---|
| `participant "+324…8004"` (app-level) | OK |
| `participant "+324…8004" of (1st account whose service type = iMessage)` | OK |
| `participant "agent23.dev@gmail.com" of (1st account whose service type = iMessage)` | OK |
| `chat id "SMS;-;+324…8004"` | **FAILS, error -1728** |

`get id of every chat` returns `SMS;-;+324…8004`, but the same string is **not** usable as a `chat id`
reference — it throws `-1728` ("can't get chat id"). This matters: the chat-id send path (used as
BlueBubbles' primary script) fails here, and their `sendMessageFallback` (participant-of-account) is the
form that works.

Note the native chat id uses the concrete service prefix (`SMS;-;…`), not `any;-;…`; `any;-;` is
BlueBubbles' own normalization.

### 1.3 Account enumeration is unsafe in bulk

**VERIFIED.** This machine has 5 accounts, two of which are orphaned and throw `-10000` on any property read:

```
accounts=5
  [1] id=0BDDB7CE-… svc=SMS      status=connected enabled=true
  [2] id=183179FF-… svc FAILED(-10000) status=connected enabled=true
  [3] id=D8668EBD-… svc FAILED(-10000) status=connected enabled=true
  [4] id=A18C7FCD-… svc=iMessage status=connected enabled=true
  [5] id=38F0B6D7-… svc=RCS      status=disconnected enabled=false
```

Consequence: `get service type of every account` and `repeat with a in accounts` both abort with
`-10000`. Enumerate **by index** inside `try`/`on error`. iMessage *is* signed in and connected here.

### 1.4 Cold-start race

**VERIFIED.** The first AppleScript call right after Messages is launched can fail:

```
5: count of accounts => execution error: … (-10000)
(after ~3 s)        => 5
```

Any transport must retry once after a short delay when it sees `-10000`, and should treat
Messages-not-running as a launch, not an error.

### 1.5 The send script

`send.applescript` (in this directory) — argv: handle, service, text.

```applescript
on run argv
	set theHandle to item 1 of argv
	set theService to item 2 of argv
	set theText to item 3 of argv

	if theHandle is "" then error "empty recipient handle" number -1700
	if theText is "" then error "empty message text" number -1700

	tell application id "com.apple.MobileSMS"
		if theService is "iMessage" then
			set targetAccount to 1st account whose service type = iMessage
		else if theService is "SMS" then
			set targetAccount to 1st account whose service type = SMS
		else
			error "unsupported service: " & theService number -1700
		end if
		set targetParticipant to participant theHandle of targetAccount
		send theText to targetParticipant
	end tell
	return "sent"
end run
```

Invocation:

```bash
/usr/bin/osascript /path/to/send.applescript "+324XXXXXXXX" "iMessage" "CLAIM 9f2c1b"
```

Targeting `application id "com.apple.MobileSMS"` (not `application "Messages"`) avoids name/version
ambiguity. Resolving `targetParticipant` before `send` makes a bad handle fail as `-1728` instead of a
generic AppleEvent failure.

**NOT EXECUTED:** the `send` line was never run — the script was syntax-validated with
`osacompile` (exit 0) and every reference in it was resolved read-only (section 1.2). End-to-end
delivery is unproven on this machine.

### 1.6 Exit code and error text contract

**VERIFIED.**

```bash
osascript -e 'tell application id "com.apple.MobileSMS" to get id of chat "nope;-;+100"'
# exit=1, stdout empty, stderr:
# 49:51: execution error: Erreur dans Messages : Il est impossible d’obtenir chat "nope;-;+100". (-1728)

osascript -e 'tell application id "com.apple.MobileSMS" to get name'
# exit=0, stdout="Messages", stderr empty
```

Contract for Node: **exit 0 = accepted, non-zero = failed, error text on stderr in the shape
`LINE:COL: execution error: <localized message> (<code>)`.** Parse only the trailing `(-NNNN)` code;
the prose is localized (this machine returns French). `osascript` exits **1** for AppleScript runtime
errors (verified above) and also for a script that fails to compile. Timeouts are not an `osascript`
concept — enforce them in the caller (SIGTERM the child). A hung `send` is the known "AppleEvent timed
out" case; BlueBubbles' source treats a `timed out` message or code `1002` as retryable and restarts
Messages before retrying once.

### 1.7 TCC requirement: Automation → Messages

**VERIFIED** from `~/Library/Application Support/com.apple.TCC/TCC.db`:

```
service=kTCCServiceAppleEvents  client=/usr/bin/osascript  client_type=1
indirect_object_identifier=com.apple.MobileSMS  auth_value=2  auth_reason=3
```

- Service: `kTCCServiceAppleEvents`, and it is a **sender→target pair** (`indirect_object_identifier`),
  not a blanket permission. One row per target app; this machine has rows for Messages, Music,
  Terminal, Finder, Mail, Reminders, System Events.
- `auth_value=2` = allowed, `auth_value=0` = denied (confirmed by the FDA rows below).
- **System Events is not required** to send to Messages. `com.apple.systemevents` appears separately
  only because other automation used it. You need System Events only if you script keystrokes or menus.

The user sees a standard consent dialog — *"<process> wants to control Messages"* with
**Don't Allow / Allow**. **UNCERTAIN:** exact wording and whether it is shown in every non-interactive
context; the string was not captured here (the grant already existed).

### 1.8 launchd behaviour

**VERIFIED** locally:

- `launchctl print gui/502` reports `type = login` and `session = Aqua`; `/dev/console` owner is
  `agent23`. A **LaunchAgent in `gui/$UID` runs inside the Aqua session**, so LaunchServices can launch
  Messages and TCC *can* present a prompt.
- The existing `~/Library/LaunchAgents/ai.hermes.gateway.plist` already uses the working pattern:
  `ProgramArguments = ["/usr/bin/osascript", "-l", "JavaScript", "-e", "…$.system(\"exec … node …\")"]`
  with `LimitLoadToSessionType = ["Aqua","Background"]`. This is *why* `/usr/bin/osascript` holds the
  AppleEvents grants on this machine.

Implications:

1. **`gui/$UID` LaunchAgent: viable.** It has the Aqua session and can both launch Messages and show
   the prompt. `Background`-only session types lose the GUI connection.
2. **LaunchDaemon (system domain): not viable.** No GUI session, no LaunchServices, no prompt surface.
   `tell application "Messages"` fails to connect and the AppleEvent request is denied silently.
   **UNCERTAIN:** exact error code in that context (`-600`/`-1728` are the usual candidates); not tested
   because creating a daemon needs root and would modify the system.
3. **Responsible-process attribution is the trap.** TCC grants attach to the *responsible process*, so
   a Node script spawned directly by launchd is judged as `node`, not as Terminal. Granting Automation
   to your terminal does **not** grant it to the LaunchAgent. Either approve the prompt that names the
   agent's own binary, or adopt the osascript wrapper (then the grant belongs to `/usr/bin/osascript`).
4. **Security note on the wrapper:** because the grant is keyed to `/usr/bin/osascript`, *any* script run
   through osascript on this machine inherits the ability to control Messages without prompting. It is
   convenient and upgrade-stable, but it is a broad grant.

`node` on this machine is Developer ID signed (`Identifier=node`, Team `HX7739G8FX`, hardened runtime).
A grant to it is path+signature scoped; **UNCERTAIN:** whether replacing the Node toolchain re-prompts,
since the signature changes per version. Expect re-prompts; the osascript wrapper avoids this.

---

## 2. Receiving: `chat.db`

### 2.1 AppleScript cannot read replies

**VERIFIED.** `Messages.sdef` on macOS 15.8.3 exposes `account`, `chat`, `participant`, `file transfer`
only. There is no message class, no `received messages` collection, and `file transfer` covers
attachments, not message bodies.

**Conclusion: AppleScript is a send-only transport. Receiving requires reading `~/Library/Messages/chat.db`.**

### 2.2 What the DB requires

- Path: `~/Library/Messages/chat.db`; also live `chat.db-wal` and `chat.db-shm`.
- `journal_mode` is **`wal`** (**VERIFIED** via `pragma journal_mode;`). Recent messages live in the WAL
  until checkpoint, so a reader must see `chat.db` **plus** `-wal`. Do **not** open with
  `?immutable=1` — it ignores the WAL and silently returns stale/missing messages.
- Access control: `kTCCServiceSystemPolicyAllFiles` (**Full Disk Access**) for the **calling binary**.
  For a launchd agent that means the agent's own binary / responsible process — again, granting FDA to
  Terminal does not help the agent.
- **WAL + read-only caveat:** `mode=ro` needs the `-shm` readable/attachable; if it is not, SQLite can
  return `attempt to write a readonly database` even for a `SELECT`. Do not copy `chat.db` alone.

### 2.3 The situation on *this* machine — read this before trusting it

**VERIFIED, and not representative:**

```
csrutil status → System Integrity Protection status: unknown (Custom Configuration)
                 Filesystem Protections: disabled
TCC system db: kTCCServiceSystemPolicyAllFiles | /usr/bin/osascript | auth_value=0   ← DENIED
```

FDA for `osascript` is explicitly **denied**, yet `sqlite3` reads `chat.db` successfully. That works only
because **SIP filesystem protections are disabled** on this box (an unsupported configuration). On a
stock Mac with SIP enabled, the same read **fails**. Do not conclude "FDA is unnecessary" from this host.

### 2.4 Schema needed by a poller

**VERIFIED** from `.schema`:

```
message(ROWID INTEGER PRIMARY KEY, guid TEXT UNIQUE NOT NULL, text TEXT, handle_id INTEGER,
        service TEXT, date INTEGER, is_from_me INTEGER DEFAULT 0, attributedBody BLOB,
        item_type INTEGER, associated_message_type INTEGER, associated_message_guid TEXT,
        cache_roomnames TEXT, date_read INTEGER, is_read INTEGER, is_sent INTEGER, error INTEGER, …)
handle(ROWID INTEGER PRIMARY KEY, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL,
       uncanonicalized_id TEXT, person_centric_id TEXT, UNIQUE(id, service))
chat(ROWID INTEGER PRIMARY KEY, guid TEXT UNIQUE NOT NULL, style INTEGER, chat_identifier TEXT,
     service_name TEXT, display_name TEXT, room_name TEXT, group_id TEXT, …)
chat_message_join(chat_id → chat.ROWID, message_id → message.ROWID, message_date INTEGER,
                  PRIMARY KEY(chat_id, message_id))
```

Semantics:

- **`date`** — **Apple epoch**, 2001-01-01T00:00:00Z, stored in **nanoseconds** on modern macOS.
  Convert: `date/1000000000 + 978307200` as Unix seconds. **VERIFIED:** `814848602116619008` →
  `2026-10-28 02:50:02` UTC, matching an independent Node computation. The naive `date + 978307200`
  yields NULL (out of range), so the divisor is not optional.
  Threshold rule for mixed-age DBs: values `> 1e12` are nanoseconds; smaller values are legacy seconds.
- **`text`** — may be `NULL` on Ventura+. **VERIFIED:** the one message in this DB has `text` NULL and a
  176-byte `attributedBody`.
- **`attributedBody`** — `streamtyped`-encoded `NSAttributedString` (header bytes `04 0B "streamtyped"`).
  After the `NSString` class name comes the `0x2B` string marker, a typedstream length, then UTF-8.
  **VERIFIED** decode: that message's blob decodes to `"G"`; the length-prefixed reader round-trips
  `CLAIM 9f2c1b`, `SKIP 9f2c1b`, `hello world`, `a`, and a 200-byte string (uint16 path). A printable-run
  scan (the common shortcut) returns junk on that same real blob — use the length-prefixed read.
- **`is_from_me`** — 0 = inbound, 1 = outbound. Filter inbound with `= 0`.
- **`guid`** — stable unique message id; the correct idempotency/dedupe key (unique index exists).
- **`service`** — `'iMessage'`, `'SMS'`, `'RCS'`. **VERIFIED** the single row here is `'SMS'`; SMS
  messages downgrade silently, so never assume iMessage delivery.
- Filter `associated_message_type = 0` (tapbacks/reactions) and `item_type = 0` (non-message items).

### 2.5 Working poll SQL

Inbound messages for one handle, newer than a cursor (**VERIFIED** against a fixture DB: returned the
expected rows, filtered a tapback, decoded a NULL-text row):

```sql
SELECT m.ROWID                AS rowid,
       m.guid                 AS guid,
       h.id                   AS sender,
       m.text                 AS text,
       m.attributedBody       AS attributedBody,
       m.service              AS service,
       m.date                 AS date,
       m.is_from_me           AS isFromMe,
       datetime(m.date/1000000000 + 978307200, 'unixepoch') AS tsUtc
FROM message m
JOIN handle h ON h.ROWID = m.handle_id
WHERE m.ROWID > :sinceRowid
  AND m.is_from_me = 0
  AND m.associated_message_type = 0
  AND m.item_type = 0
  AND h.id = :handle
ORDER BY m.ROWID ASC
LIMIT :limit;
```

Cursor: `SELECT COALESCE(MAX(ROWID),0) FROM message;` at startup, advance to `max(rowid)` after each poll.
`ROWID` is monotonic (AUTOINCREMENT) and is a safer cursor than `date` (clock skew, WAL visibility).
For group context add
`LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID LEFT JOIN chat c ON c.ROWID = cmj.chat_id`
and read `c.guid` / `c.display_name`; a DM row may have **no** `chat_message_join` row yet.

Run it with the CLI (no Node SQLite driver needed):

```bash
/usr/bin/sqlite3 -json "file:$HOME/Library/Messages/chat.db?mode=ro" "<sql>"
```

### 2.6 Failure without FDA

**VERIFIED (error shape, via an unreadable file as the EPERM proxy):**

```
Error: unable to open database "/tmp/noperm.db": unable to open database file   # exit 1
```

A TCC denial returns `EPERM` from `open()`, so `sqlite3` surfaces the same
`Error: unable to open database …: unable to open database file`, exit 1.
**UNCERTAIN:** the exact TCC-denial string on a stock Mac (would be `Operation not permitted` from some
tools); not reproducible here because SIP filesystem protections are disabled. Treat "unable to open
database file" on `chat.db` as "missing Full Disk Access" first, permissions second.

### 2.7 Read-only from a launchd agent

**VERIFIED (mechanism):** the agent runs in `gui/$UID`, so `sqlite3` runs as the same user and inherits the
same TCC judgement; there is nothing special about launchd for file access — only the **responsible
process** changes. So it works if and only if FDA is granted to the agent's own binary (or FDA is moot,
as on this box with SIP fs protections off). Reading is side-effect free: `mode=ro` issues no writes and
does not checkpoint the WAL, so it does not disturb Messages.

---

## 3. Third-party transports

### 3.1 BlueBubbles — **VERIFIED local HTTP API**, usable as a pluggable transport

Self-hosted macOS server, distributed as a signed `.dmg` / `.zip` (**VERIFIED**: latest release is
`v1.9.12`, assets include `BlueBubbles-1.9.12.dmg` for x86_64 and `-arm64.dmg` — **no Homebrew needed**),
speaking REST over localhost.

- Base: `http://<host>:<port>/api/v1`
- Auth: query parameter **`guid`** (aliases `password`, `token`) = the server password set in the app.
- Envelope: `{status, message, data}`; errors add `{error:{type, error}}`.
- Send text: `POST /api/v1/message/text?password=<pw>` with JSON body
  `{ "chatGuid": "any;-;+15551234567", "tempGuid": "temp-<uuid>", "message": "CLAIM 9f2c1b" }`
- Read: `GET /api/v1/message?password=<pw>&limit=25&offset=0&sort=DESC`,
  or `GET /api/v1/chat/<chatGuid>/message?…`.
- Webhooks: new message, message update, message error, typing, chat read status, group changes.

`chatGuid` shapes: DM `any;-;{phone-or-email}`, group `any;+;{chat-id}`.

**Verified from server source** (`messageRouter.ts` → `sendText`, and `messageInterface.ts`):
the body fields are `tempGuid, message, attributedBody, method, chatGuid, effectId, subject,
selectedMessageGuid, partIndex, ddScan`; **`method` defaults to `"apple-script"`** and the other
accepted value is `"private-api"` (anything else throws `Invalid send method`). So plain text send uses
the AppleScript bridge and does **not** require the Private API helper.

Caveats: the docs warn the REST API is fully supported for browser use only behind HTTPS (ngrok,
Cloudflare, or Dynamic DNS with a valid cert); non-browser clients are expected to work over plain local
HTTP. BlueBubbles also needs Messages signed in and its own FDA/Automation grants. It sends via
AppleScript, so it inherits every caveat in section 1.

### 3.2 Photon — **no verified local HTTP API**

**VERIFIED from docs**, and explicitly reported as such:

- `@photon-ai/imessage-kit` — MIT, macOS-only, Node ≥20, "talks directly to the local Messages database
  and AppleScript bridge", **requires Full Disk Access**. It is a **library/SDK**, not an HTTP server.
  (Matches this spec's architecture; useful as a reference implementation, but adds an npm dependency
  and `better-sqlite3`.)
- `@photon-ai/advanced-imessage` — client for a Photon **gRPC** server: `createClient({address:
  "host:port", token})`, TLS default on, `im.chats.create([...])` → `chat.guid` (`any;-;{recipient}`),
  then `im.messages.sendText(chat.guid, text)`.
- **UNCERTAIN / not found:** any documented local **HTTP/REST** endpoint for Photon. Its local option is
  an in-process SDK; its server option is gRPC. Do not assume `http://localhost:PORT` exists.

### 3.3 `imsg` CLI

Not available: no Homebrew on this host, and the task forbids installing. Irrelevant to a pure-Node
transport. *(VERIFIED: `which imsg` → no imsg; `which brew` → no brew.)*

---

## 4. Recommendation

**Default: native Node transport — `osascript` for send, `sqlite3` for receive** (`imessage-transport.js`
in this directory). Zero dependencies, no install, one process, and the only moving parts are two Apple
system binaries.

Why: it is the same mechanism BlueBubbles and Photon's local SDK use, without a server, npm tree, or
third-party update surface. Send is ~30 lines; receive is one SQL query plus a cursor.

**Fallback: BlueBubbles** — when you want push instead of polling (webhooks), group/reply/tapback
support, or send confirmation without a DB watcher. It is the only one of the two with a **verified
local HTTP API**, so it drops in behind the same interface. Rejected as default because it adds a
service, a password surface on localhost, and its own TCC footprint, while still sending via AppleScript.

**Rejected:** Photon (no verified local HTTP API; either an npm SDK or a gRPC server), `imsg`
(uninstallable without Homebrew), and AppleScript-only receive (impossible — no message class).

### Transport interface (stable seam)

```js
send(handle, text, { service })  // -> {ok, code, error?}
poll({ handle, sinceRowid })     // -> [{rowid, guid, sender, text, service, dateNs, tsUtc}]
maxRowid()                       // -> cursor seed
```

Anything implementing these three is swappable; BlueBubbles maps to
`POST /api/v1/message/text` + `GET /api/v1/message`.

### Delivery is not proven by exit code

`osascript` exiting 0 means Messages accepted the AppleEvent, nothing more. **Confirm sends by polling
`chat.db` for a new `is_from_me = 1` row matching the text/handle** (BlueBubbles does exactly this with a
10-second skew allowance). If no row appears within a few seconds, treat as failed and retry once —
including a Messages restart, which is BlueBubbles' documented remedy for `timed out` / `-1002`.

---

## 5. What the user must grant manually

1. **Automation → Messages** for whichever process sends. Approve the first-run dialog
   (*"… wants to control Messages"*), or pre-add under System Settings → Privacy & Security → Automation.
   **VERIFIED** already granted to `/usr/bin/osascript` on this host (`auth_value=2`).
2. **Full Disk Access** for the process that reads `chat.db` — required on a stock Mac; add the actual
   binary (or the `osascript`/wrapper the agent runs), **not** Terminal, unless the agent inherits it.
   **VERIFIED** currently *denied* for `/usr/bin/osascript` here, and reads only work because SIP
   filesystem protections are disabled — this host is not a valid model for a normal Mac.
3. **Messages signed in** to iMessage (and/or an SMS-capable iPhone via Text Message Forwarding) —
   otherwise `1st account whose service type = iMessage` throws `-10000`. iMessage is connected here.
4. If the agent is a LaunchAgent: keep it in `gui/$UID` with `LimitLoadToSessionType` including `Aqua`,
   and approve the prompt that names **the agent's own** binary — or adopt the `osascript` wrapper so the
   grant lands on `/usr/bin/osascript`.
5. **Do not** rely on `immutable=1` for `chat.db`, and do not copy `chat.db` without `-wal`/`-shm`.

---

## 6. Verification matrix

| Claim | Status |
|---|---|
| Messages.sdef classes = account/chat/participant/file transfer; no message class | VERIFIED |
| `participant "handle"` resolves (app-level and of-account) | VERIFIED |
| `chat id "SVC;-;handle"` fails `-1728` | VERIFIED |
| Bulk `service type of every account` fails `-10000` (orphan accounts) | VERIFIED |
| Cold-start `-10000` clears after ~3 s | VERIFIED |
| osascript exits 1, error on stderr, localized, `(-NNNN)` code | VERIFIED |
| `send.applescript` compiles (`osacompile` exit 0) and all refs resolve | VERIFIED |
| Actual message delivery end-to-end | **NOT EXECUTED** (no sends permitted) |
| Automation grant = `kTCCServiceAppleEvents` sender→`com.apple.MobileSMS`, `auth_value=2` | VERIFIED |
| FDA for osascript is `auth_value=0` yet reads work | VERIFIED (SIP fs protections disabled) |
| TCC prompt wording / appears in every background context | **UNCERTAIN** |
| LaunchDaemon send fails & cannot prompt | **UNCERTAIN** (not tested; needs root) |
| `journal_mode=wal`; `immutable=1` would skip WAL | VERIFIED / DOCUMENTED |
| Apple epoch ns → `2026-10-28 02:50:02Z` for `814848602116619008` | VERIFIED (SQL + Node agree) |
| `text` NULL while `attributedBody` holds payload | VERIFIED (1 real row) |
| typedstream decoder round-trips `CLAIM …`/`SKIP …` incl. uint16 length | VERIFIED |
| poll SQL filters tapbacks and decodes NULL-text rows | VERIFIED (fixture DB) |
| `sqlite3` EPERM shape = `unable to open database file`, exit 1 | VERIFIED (proxy) |
| Exact TCC-denial string on a stock Mac | **UNCERTAIN** |
| BlueBubbles `POST /api/v1/message/text`, `?password=`, `method` default `apple-script` | VERIFIED (docs + source) |
| Photon local **HTTP** API | **NOT FOUND** — SDK (local) and gRPC (server) only |

---

## 7. Files in this directory

| File | Purpose |
|---|---|
| `imessage-transport.js` | Node transport: `send`, `poll`, `maxRowid`, `dryRun`; CLI `poll`/`dryrun`/`send` |
| `send.applescript` | The send script (argv: handle, service, text) |
| `probe_target.applescript` | Read-only preflight: validates handle/service without sending |
| `probe_accounts.applescript` | Enumerates accounts index-by-index, tolerating `-10000` |
| `Messages.sdef` | Copy of the macOS 15.8.3 scripting dictionary (evidence) |
| `fixture/` | Copy of `chat.db` + WAL + SHM with synthetic rows (tests only, never the live DB) |
| `fixture_set_blob.js` | Attaches a typedstream `attributedBody` to a fixture row |
| `bb_messageRouter.ts`, `mi.ts`, `actions.ts`, `scripts.ts` | BlueBubbles source excerpts (evidence) |
