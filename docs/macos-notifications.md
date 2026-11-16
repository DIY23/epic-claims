# Interactive macOS UserNotifications from a non-Xcode, ad-hoc-signed Swift helper

**Target machine:** Intel Mac mini, macOS 15.8.3 (24H241), Command Line Tools only (swiftc 6.1.2, target `x86_64-apple-macosx15.0`), no Xcode.app, no Apple Developer identity (`security find-identity -v -p codesigning` → *0 valid identities found*), headless (WindowServer up, no one at the screen).
**Consumer:** a Node.js app running as a per-user launchd LaunchAgent, needs "Free game: X — Claim / Skip" and needs the choice back in the Node process.

Everything below marked **[MEASURED]** was executed on this machine during this research; the exact command and output is in §10. Everything marked **UNCERTAIN** could not be established without either (a) posting a real notification on the owner's screen or (b) a GUI admin prompt — both out of scope.

---

## 0. Verdict

| Question | Answer |
|---|---|
| Does `UNUserNotificationCenter` work from a bare CLI binary? | **No.** It does not return `nil` and does not return an error — it throws an `NSInternalInconsistencyException` and the process dies. **[MEASURED]** |
| Minimum viable shape? | A real `.app` bundle with `CFBundleIdentifier` + `CFBundleExecutable` + `CFBundlePackageType`, **ad-hoc signed**, ideally registered with LaunchServices. **[MEASURED]** |
| Do the buttons work? | Yes — `UNNotificationCategory` + two `UNNotificationAction`s, delegate set before launch completes. |
| Can the action get back to Node? | Yes — the delegate writes one JSON line to a unix socket. **[MEASURED]** (also HTTP POST to loopback **[MEASURED]**) |
| Does permission survive in-place binary updates with `codesign -s -`? | **No.** Ad-hoc designated requirement is literally `cdhash H"…"`; any rebuild changes it. **[MEASURED]** This is the one real design problem — see §6. |
| `osascript display notification` fallback? | Works for banners, **cannot** carry buttons or any callback. Verified from the system SDEF. **[MEASURED]** |
| Best architecture here | Resident `LSUIElement` helper app under launchd + unix-socket protocol; Node never touches UserNotifications. §9 |

---

## 1. Why a bare binary cannot do this (Q1)

**[MEASURED]** A 22 KB binary built with `swiftc -O bare.swift -o bare` (no bundle) printed:

```
mainBundle.bundleURL      = /Users/agent23/Hermes/tmp/research/probe
mainBundle.bundleIdentifier = nil
calling UNUserNotificationCenter.current() ...
Segmentation fault: 11        (exit 139)
```

Crash report (`~/Library/Logs/DiagnosticReports/bare-2026-11-16-161501.ips`) shows the exact path:

```
objc_exception_throw
-[NSAssertionHandler handleFailureInMethod:object:file:lineNumber:description:]
__53+[UNUserNotificationCenter currentNotificationCenter]_block_invoke.cold.4
+[UNUserNotificationCenter currentNotificationCenter]
main
```

and the unified log for the same PID:

```
bare: (Foundation) [com.apple.Foundation:general] *** Assertion failure in <private>, UNUserNotificationCenter.m:63
```

So: **the failure is inside `+[UNUserNotificationCenter currentNotificationCenter]`, guarded by an `NSAssertionHandler` at `UNUserNotificationCenter.m:63`, and it is not catchable** (it unwinds through a `dispatch_once` and the unwinder faults → SIGSEGV, which is why you see "Segmentation fault: 11" rather than "Terminating app due to uncaught exception"). The `<private>` redaction hides the reason string in the log on macOS 15.

The reason string is `bundleProxyForCurrentProcess is nil`, which is the message the ecosystem consistently reports for this exact assertion (e.g. [go-macos/usernotifications](https://github.com/go-macos/usernotifications): *"Outside an `.app` bundle, `+[UNUserNotificationCenter currentNotificationCenter]` does not return `nil` and does not return an error. It throws NSInternalInconsistencyException"*), and it matches the mechanism: the framework resolves the calling process to a LaunchServices *bundle proxy* and asserts when there is none. **The literal wording is UNCERTAIN** (redacted here — I could not attach lldb: `attach failed`, CLT lldb has no debug entitlement on this box); the *behaviour* (assertion + death, same frame) is measured.

There is no `__NSXPCConnection…privileged` variant to worry about — that string belongs to other frameworks. The UserNotifications failure is always the bundle-proxy assertion.

**Consequence:** you cannot "just call it from Node via a helper CLI". The smallest thing that works is an `.app` bundle. Note the framework does *not* require Xcode, a storyboard, or a dock icon.

### What actually is required beyond the bundle

- **Ad-hoc signing.** `codesign -s -` is enough. **[MEASURED]** — the signed probe worked; the go-macos live suite independently reports that an unsigned bundle fails with `UNErrorCodeNotificationsNotAllowed`.
- **LaunchServices registration** — recommended. **[MEASURED]** Running `./App.app/Contents/MacOS/Binary` directly did **not** register the bundle (`lsregister -dump | grep -c notifyprobe` → `0`); `open -g -n App.app` did (count → `3`). The API worked in both cases for read-only settings, but registration is what makes "click action → system launches the app" possible, so do it explicitly (§3).
- **Location matters.** The go-macos project measured that a bundle under `/var/folders` (i.e. `mktemp -d`/`TMPDIR`) is *registered without complaint and then refused*, while the byte-identical bundle under `~/Library/Application Support` is granted immediately. **[MEASURED-WEAK]**: my copy under `mktemp -d` still answered `getNotificationSettings` fine (`.notDetermined`), so the refusal is at the *grant/delivery* stage, not the API stage — consistent with their claim but not independently re-tested here (re-testing means triggering a prompt). **Install under `~/Library/Application Support/<Name>/`, never in `%TMPDIR%`, never in `~/Downloads` (quarantine).**

---

## 2. Minimal `Info.plist` for an LSUIElement agent app

`LSUIElement` ([Apple docs](https://developer.apple.com/documentation/bundleresources/information-property-list/lsuielement)): *"A Boolean value indicating whether the app is an agent app that runs in the background and doesn't appear in the Dock."* macOS 10.0+.

Four keys are load-bearing; the rest is polish:

| Key | Required | Why |
|---|---|---|
| `CFBundleIdentifier` | **yes** | This *is* the notification identity. It is the key macOS stores in `com.apple.ncprefs` and in the `usernoted` database. Change it and you are a new app forever. |
| `CFBundleExecutable` | **yes** | File name in `Contents/MacOS/`. Without it LaunchServices cannot launch you on a notification click. |
| `CFBundlePackageType` = `APPL` | **yes** | Makes the bundle an application for LaunchServices. |
| `LSUIElement` = `true` | **yes** for this use | No dock icon, no menu bar, no app switcher entry. |
| `CFBundleName` / `CFBundleDisplayName` | strongly advised | **This is the sender name printed in the banner and in System Settings › Notifications.** If you omit it you get the executable name. |
| `CFBundleShortVersionString`, `CFBundleVersion` | advised | Shown in System Settings; also what an update check compares. |
| `LSMinimumSystemVersion` | optional | `11.0`+ is sane; UserNotifications is macOS 10.14+. |
| `NSUserNotificationUsageDescription` | **not required** | Not a documented macOS key — there is no usage-description key for notifications on macOS (the prompt text is system-generated: *""HermesNotify" would like to send you notifications."*). Harmless if present. **[MEASURED]**: my probe carried it and worked, but nothing validates it. **UNCERTAIN** whether it is ever read. |

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>          <string>com.agent23.hermes.notifyhelper</string>
    <key>CFBundleName</key>                <string>HermesNotify</string>
    <key>CFBundleDisplayName</key>         <string>HermesNotify</string>
    <key>CFBundleExecutable</key>          <string>NotifyHelper</string>
    <key>CFBundlePackageType</key>         <string>APPL</string>
    <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
    <key>CFBundleShortVersionString</key>  <string>1.0.0</string>
    <key>CFBundleVersion</key>             <string>1</string>
    <key>LSMinimumSystemVersion</key>      <string>11.0</string>
    <key>LSUIElement</key>                 <true/>
    <key>NSUserNotificationUsageDescription</key>
    <string>Shows free-game offers with Claim/Skip buttons.</string>
</dict>
</plist>
```

No entitlements file is needed. No sandbox. No `com.apple.security.*` keys. (Adding an app sandbox would break the unix socket path and is not required for local notifications.)

---

## 3. Build and install (script, no Xcode)

Verified working on this machine; `swiftc` from CLT alone is sufficient.

```bash
#!/bin/bash
set -euo pipefail

APP_NAME="HermesNotify"
BUNDLE_ID="com.agent23.hermes.notifyhelper"
INSTALL_DIR="$HOME/Library/Application Support/$APP_NAME"   # NOT /tmp, NOT /var/folders
APP="$INSTALL_DIR/$APP_NAME.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

swiftc -O -swift-version 5 NotifyHelper.swift -o "$APP/Contents/MacOS/NotifyHelper"
cp Info.plist "$APP/Contents/Info.plist"

plutil -lint "$APP/Contents/Info.plist"

# Ad-hoc sign. --identifier keeps the identity string stable; see §6 for why this is
# still not enough to survive rebuilds.
codesign --force --sign - --identifier "$BUNDLE_ID" --timestamp=none "$APP"
codesign --verify --strict --verbose=2 "$APP"

# Register with LaunchServices so a notification click can launch the app.
"$LSREGISTER" -f "$APP"

echo "installed: $APP"
```

**Launch it through `open`, not by executing the binary**, when you want it registered and running as a proper app:

```bash
open -g -n "$APP"          # -g: don't bring to foreground, -n: new instance
```

A launchd LaunchAgent (§9) is the better production answer: it keeps the helper resident so action callbacks arrive in the already-running process.

---

## 4. The Swift side (Q2)

### 4.1 API surface, from the SDK headers on this machine

`/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/System/Library/Frameworks/UserNotifications.framework/Headers/UNNotificationAction.h`:

```c
typedef NS_OPTIONS(NSUInteger, UNNotificationActionOptions) {
    UNNotificationActionOptionAuthenticationRequired = (1 << 0),  // require unlock
    UNNotificationActionOptionDestructive            = (1 << 1),  // red highlight
    UNNotificationActionOptionForeground             = (1 << 2),  // launch in foreground
};
static const UNNotificationActionOptions UNNotificationActionOptionNone
    NS_SWIFT_UNAVAILABLE("Use [] instead.") = 0;
```

For a Claim/Skip pair that must be answerable **while the screen is locked / nobody present**, use `options: []` — that is the no-options case, and it explicitly does *not* demand an unlock. `[]` is the Swift spelling of `UNNotificationActionOptionNone`.

`UNNotificationCategory.h` gives `UNNotificationCategoryOptionCustomDismissAction = (1 << 0)` — add it if you want to learn that the user swiped the notification away (it arrives as `UNNotificationDismissActionIdentifier`). Without it, dismissal is silent and your Node side never learns the offer expired.

`UNError.h` gives the error code you will actually hit in the field:

```c
UNErrorCodeNotificationsNotAllowed = 1,   // "Notifications are not allowed for this application"
```

That is what `add(_:)` returns when the bundle is unsigned/unregistered/denied. Treat `UNErrorDomain` + code `1` as "authorization or identity problem", not "bad request".

### 4.2 Ordering rules that actually matter

1. **Delegate before launch completes.** Apple, [`delegate`](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/delegate): *"To guarantee that your app responds to all actionable notifications, you must set the value of this property before your app finishes launching… Notifications that cause your app to be launched are delivered shortly after these methods finish executing."* In AppKit terms: set it in `applicationDidFinishLaunching(_:)`, or before `app.run()`.
2. **Categories at launch, too.** [`Declaring your actionable notification types`](https://developer.apple.com/documentation/usernotifications/declaring-your-actionable-notification-types): *"Because your app must handle all actions, you must declare the actions that your app supports at launch time."* Actions are looked up by category identifier **at delivery time**, so if the app is launched by the click, registration must happen during that launch — before the response is delivered.
3. **`completionHandler()` must be called** in `didReceive`: *"If you do not implement this method, your app never responds to custom actions."*
4. **Do the IPC write before calling `completionHandler()`** — a background-launched process may be terminated shortly after you complete.

### 4.3 What happens when the app is *not* running and the user clicks Claim

Apple, [`Handling notifications and notification-related actions`](https://developer.apple.com/documentation/usernotifications/handling-notifications-and-notification-related-actions):

> *"Tapping one of the buttons forwards the selected action to your app, without bringing the app to the foreground."*
> *"When the user selects an action, the system launches your app in the background and calls the delegate's `userNotificationCenter(_:didReceive:withCompletionHandler:)` method."*

So, precisely:

| Situation | What the system does |
|---|---|
| Helper already running (LaunchAgent) | Response is XPC'd into the live process → `didReceive` on the main queue. Simplest, most reliable. |
| Helper not running, action clicked | LaunchServices **launches the bundle in the background**, then delivers the response to `didReceive` shortly after `applicationDidFinishLaunching` returns. No dock icon appears, no window, no focus steal (LSUIElement). |
| Helper not running, notification *body* clicked (default action) | Same launch, but `actionIdentifier == UNNotificationDefaultActionIdentifier`. |
| Swiped away, `.customDismissAction` set | `UNNotificationDismissActionIdentifier`, delivered to a *running* app only. |
| User never responds | No callback at all. Plan for expiry on the Node side. |

**This is the key correction to a common assumption:** the action does *not* go through `NSUserNotificationCenter` (deprecated since macOS 11 and not involved at all). `NSUserNotificationCenter` is legacy; the modern path is `UNUserNotificationCenter` only.

Can an LSUIElement app be launched on demand by the action? **Yes** — that is exactly the "launch in the background" path above, and `LSUIElement` is what keeps it invisible while doing so. It does require the bundle to be known to LaunchServices (§3) since LS is the launcher. **UNCERTAIN** (untested here, needs a real click): whether macOS will background-launch a bundle that is *only* ad-hoc signed and registered from `~/Library/Application Support` — I expect yes (that is the supported layout) but I could not click a button without putting a notification on the owner's screen.

Because of that residual uncertainty, the recommended design (below) makes the app **resident**, so the launch-on-click path is a fallback rather than the primary path.

### 4.4 Working code

Complete, compiling reference implementation: `probe/NotifyHelper.swift` in this research directory (10.5 KB). **[MEASURED]** builds clean with `swiftc -O -swift-version 5` on Swift 6.1.2, no warnings, exit 0.

The notification-relevant core:

```swift
import AppKit
import UserNotifications

let categoryID = "HERMES_FREE_GAME"
let claimID    = "HERMES_CLAIM"
let skipID     = "HERMES_SKIP"

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {

    func applicationDidFinishLaunching(_ note: Notification) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self                                    // rule 1

        center.setNotificationCategories([                         // rule 2
            UNNotificationCategory(
                identifier: categoryID,
                actions: [
                    UNNotificationAction(identifier: claimID, title: "Claim", options: []),
                    UNNotificationAction(identifier: skipID,  title: "Skip",  options: []),
                ],
                intentIdentifiers: [],
                options: [.customDismissAction]                    // learn about dismissals
            )
        ])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler:
                                    @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])   // otherwise a foreground notification is silent
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let event: [String: Any] = [
            "event":  "action",
            "id":     (info["id"] as? String) ?? response.notification.request.identifier,
            "action": response.actionIdentifier,   // HERMES_CLAIM | HERMES_SKIP | default | dismiss
            "url":    (info["url"] as? String) ?? "",
            "ts":     Int(Date().timeIntervalSince1970),
        ]
        sendToNode(event)          // durable write FIRST
        completionHandler()        // then complete (rule 3)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)   // belt and braces with LSUIElement
app.run()
```

Posting:

```swift
func post(id: String, title: String, body: String, url: String) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    content.categoryIdentifier = categoryID          // without this: no buttons at all
    content.userInfo = ["id": id, "url": url]        // echoed back in didReceive
    // threadingIdentifier / targetContentIdentifier are optional; see §9 note on grouping.
    let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request) { error in
        if let e = error as NSError? {
            // domain "UNErrorDomain", code 1 == notificationsNotAllowed (auth/identity problem)
            log("add failed \(e.domain) \(e.code) \(e.localizedDescription)")
        }
    }
}
```

The **category identifier on the content** is the single most common cause of "buttons don't appear": Apple — *"The system displays actions only for notifications whose payload contains a valid category identifier string."*

Two AppKit details that cost time if missed:

- `app.setActivationPolicy(.accessory)` in addition to `LSUIElement` makes the process behave as an agent even when launched directly from a shell (useful for debugging builds).
- Do **not** call `NSApp.activate(ignoringOtherApps:)` — on a headless machine that can steal the session's focus and you will not be there to un-steal it.

---

## 5. Getting the action back into Node (Q3)

Two transports were built and executed from inside an ad-hoc signed `LSUIElement` `.app` on this machine. **[MEASURED]**

Driver: `probe/harness.py` (starts an HTTP listener on `127.0.0.1:8477` *and* an `AF_UNIX` listener, runs the client, prints what arrived). Client: `probe/clienttest.swift`.

```
--- client stdout ---
bundleIdentifier = com.agent23.hermes.notifyprobe
HTTP  -> HTTP 200 body={"ok":true}
UNIX  -> wrote 79 bytes
--- received by server ---
[http] path=/action token=test-shared-secret
   json: {'game': 'Example', 'action': 'CLAIM', 'notificationId': 'abc-123', 'ts': 1794842302}
[unix] path=/tmp/hermes-notify-test.sock token=None
   json: {'game': 'Example', 'action': 'CLAIM', 'notificationId': 'abc-123', 'ts': 1794842302}
TOTAL_RECEIVED=2 (expect 2)
```

### Findings

- **`URLSession` from an LSUIElement app works.** Plain `http://127.0.0.1:8477` was accepted with **no ATS exception**; no `NSAppTransportSecurity` key was needed. (ATS does not police literal-IP/loopback destinations in practice; adding `NSAllowsLocalNetworking` is still a harmless belt-and-braces if you ever hit a refusal on another OS version. **UNCERTAIN** whether that exemption is contractual or incidental — my test says it works on 15.8.3.)
- **Header injection works** (`X-Hermes-Token: test-shared-secret` arrived intact) — so a shared-secret header is viable.
- **AF_UNIX works** — ~40 lines of POSIX socket code, no entitlements, no sandbox. Use a path inside `~/Library/Application Support/…` (keeps it under the 104-byte `sun_path` limit and out of `TMPDIR`).
- Both run **synchronously-ish** with a `DispatchSemaphore`, which is what you want inside `didReceive`: you must not call `completionHandler()` before the bytes are on the wire.

### Recommendation: unix socket, not HTTP

| | unix socket | HTTP loopback |
|---|---|---|
| Reachable from other users on the box | no (0700 dir) | yes, any local process |
| Auth | filesystem permissions | needs the shared secret, and it's the only thing standing between a browser page and your endpoint |
| Port collisions / firewalls | none | possible; some security tooling scopes loopback listeners |
| Node client code | `net.connect` ~10 lines | `fetch` 3 lines |

Use the socket as the primary path. Keep the HTTP POST **only** as an optional secondary if Node is running in a context where the socket path is awkward — and then require the header secret, bind strictly to `127.0.0.1`, and validate `Origin` absence. A local port with no secret is a remote-claim button for any process that guesses the port.

**Durability matters** more than either transport: append every action to `~/Library/Application Support/HermesNotify/actions.log` *as well as* pushing it on the socket. If the helper handles a click while Node is restarting, the socket write silently goes nowhere — the log line does not. Node should drain that file on start (and hold a byte offset).

---

## 6. In-place binary updates vs. the permission grant (Q4) — the real risk

This is the one part of the design that will bite, and it is worth being blunt: **ad-hoc re-signing destroys your notification identity on every rebuild.**

### Measured facts

1. **The authorization record is keyed by bundle identifier, and *validated against a stored code requirement*.** From this machine's `~/Library/Preferences/com.apple.ncprefs.plist`, each entry looks like:

   ```
   "bundle-id" = "com.cmuxterm.app"
   "path"      = "/Applications/cmux.app"
   "auth"      = 7
   "flags"     = 310386702
   src = ( { flags = 0;
             path  = "/Applications/cmux.app";
             req   = <0xfade0c00 …>          # serialized CS requirement blob
             uuid  = "E8FC9727-D721-4918-9CD7-A9CD6A2ED0E6" } )
   ```

   The `req` blob is a `fade0c00` code-signing requirement. That is the anchor the system compares against the running code. (An *unsigned* app — Chrome for Testing on this box — appears with `flags = 1` and **no** `req`, i.e. path-and-identifier only.)

2. **An ad-hoc signature's designated requirement is nothing but the cdhash.** **[MEASURED]**

   ```
   $ codesign -d -r- NotifyProbe.app
   # designated => cdhash H"a5e6b6fe6b8324bd7f79fe6faebeaf84f93f114c"
   ```

   Note there is no `identifier` clause at all — despite `--identifier com.agent23.hermes.notifyprobe` being passed.

3. **Registering the bundle is enough to create the record — no prompt, no authorization.** **[MEASURED]** Simply `open -g -n`-ing the probe (and running the helper) added entries to `ncprefs` with `auth = 0`:

   ```
   { 'bundle-id': 'com.agent23.hermes.notifyhelper',
     'path': '…/build/NotifyHelper.app', 'auth': 0, 'flags': 268443662,
     'src': [{ 'req': 'fade0c0000000028…',
               'uuid': 'BC39F41E-442E-48D6-85AC-F2408EEF747A', 'flags': 0 }] }
   ```

   Two consequences: (a) your app appears in System Settings › Notifications *before* the user ever answers a prompt, so a half-installed helper is user-visible; (b) `auth` plus the `src[].uuid` is a readable, if undocumented, record of the grant and of which signature it was granted to — which is how you would prove a rebuild broke it.

4. **A trivial code change changes it.** **[MEASURED]** After editing one string and rebuilding + re-signing the same bundle:

   ```
   CDHash=c9a2795336d47c005fa378bf2b57aafdb416d7b8
   # designated => cdhash H"c9a2795336d47c005fa378bf2b57aafdb416d7b8"
   ```

   `a5e6b6fe…` → `c9a27953…`. The bundle id, path, and Info.plist were identical.

5. **A properly signed app's DR is identity-based, not hash-based.** For comparison, real apps on this machine:

   ```
   /Applications/cmux.app  => identifier "com.cmuxterm.app" and anchor apple generic and
                              certificate leaf[subject.OU] = "7WLXT3NR37"
   /Applications/Monit.app => … certificate leaf[subject.OU] = Z7D8RDKK69) and identifier Monit
   ```

   Those survive rebuilds, because the requirement names the signing certificate, not the bytes.

### What this means in practice

- With `codesign -s -`, each rebuild produces a **new identity** to `usernoted`. The stored `req` in `ncprefs` no longer matches. The observable outcomes, all widely reported and consistent with the structure above: the app drops out of (or duplicates in) System Settings › Notifications, deliveries are silently discarded, or a fresh prompt appears. **UNCERTAIN** which of these exactly happens on macOS 15.8.3 for a *path-stable, bundle-id-stable, ad-hoc* rebuild — I could not test it without putting a real prompt/notification on the owner's screen. I would plan for "grant is lost" and be pleasantly surprised otherwise.
- **Stable bundle id + stable absolute path are necessary but not sufficient.** They are what you control; the cdhash is what changes.
- The user's grant is **not** stored in TCC (`~/Library/Application Support/com.apple.TCC/TCC.db` has no notification service) — it lives in `com.apple.ncprefs` + the `usernoted` db (`~/Library/Group Containers/group.com.apple.usernoted/db2/db`, table `app(identifier)`). So the usual "TCC reset" advice does not apply; the lever is `ncprefs`.

### Options, best first

1. **Sign with a stable self-signed identity instead of `-`.** Create a code-signing certificate once (Keychain Access › Certificate Assistant › *Create a Certificate*, type *Code Signing*, self-signed), then `codesign -s "Hermes Local Signing" …`. The DR then becomes `identifier "com.…" and certificate leaf = H"<cert sha1>"` — *bytes-independent*, so rebuilds keep the grant. **UNCERTAIN, but strongly indicated**: I created such a cert here and imported it successfully (`1 identity imported`, SHA-1 `B4A93187…`), but `codesign` refused it — `error: The specified item could not be found in the keychain` — because a self-signed cert must be *trusted* for code signing, and setting trust requires an admin GUI authorization I would not trigger on this headless box. On a machine where someone can click "Always Trust" once, this is the clean fix, and it is the standard workaround for exactly this problem.
2. **Don't rebuild the helper.** Make the Swift helper a *dumb, frozen* transport: it knows only "post this JSON as a notification" and "report the click". All behaviour changes (titles, which offers, retry policy) live in Node. Then the cdhash never changes because the binary never changes. This is worth taking seriously — it costs one generic helper and buys permanent permission stability.
3. **Re-prompt gracefully.** Detect the loss (§7) and re-request authorization at the next opportunity when a human is present. Cheap, but the owner will see a prompt after each update — bad for an unattended box.
4. **Accept a new bundle id per release** (`…notifyhelper.v2`) — worst option: permission is guaranteed lost and the old entry lingers in System Settings forever.

**Recommendation:** (2) as the structural answer, (1) as the polish if someone with GUI access can trust a local cert once.

---

## 7. Authorization on a machine with nobody at the screen (Q5)

### Behaviour

Apple, [`requestAuthorization`](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/requestauthorization(options:completionhandler:)):

> *"The first time your app calls the method, the system prompts the person to authorize the requested interactions… Subsequent calls to this method don't prompt the person again."*
> *"granted: … The value is `false` when the person denies authorization **or authorization is undetermined**."*

So on a headless box:

- The prompt is a system modal owned by the notification UI. If no one is at the screen, **nobody answers**, and the completion handler does not fire (it is not a timeout — it waits for a decision). Your `authorize` call will hang for as long as the prompt is unanswered. **UNCERTAIN** whether macOS suppresses the prompt entirely while the session is locked/screen asleep and re-shows it at unlock, or shows it into the void — either way, do not block on it.
- `granted == false` is therefore ambiguous: denied, *or* still undecided. Never treat it as "denied".
- Because of this, a LaunchAgent that calls `requestAuthorization` at start-of-day on an unattended machine can sit on an unanswered prompt indefinitely. **Do not do that.** Call it once during installation, when a human is plausibly present, and poll thereafter.

### Detection (this part is fully safe — no prompt, no UI)

`getNotificationSettings` never prompts and works even un-authorized. **[MEASURED]** — from the reference helper's socket, un-authorized:

```json
{"notificationCenterSetting":2,"ok":true,"authorizationStatus":0,"alertSetting":0,"soundSetting":0}
```

`UNAuthorizationStatus` raw values (from the SDK): `0 notDetermined`, `1 denied`, `2 authorized`, `3 provisional`, `4 ephemeral`.

So the decision tree for Node is exactly:

| `authorizationStatus` | Meaning | Action |
|---|---|---|
| `0` notDetermined | Never decided (or identity reset by a rebuild — indistinguishable) | Ask a human; meanwhile fall back to `osascript` banners |
| `1` denied | Refused, or `add()` returned `UNErrorCodeNotificationsNotAllowed` | Do not retry blindly; surface it; fall back |
| `2` authorized | Usable, but still check `alertSetting`/`soundSetting` | Post normally |
| `3` provisional | Quiet delivery only | Usable, appears in Notification Center only |

Also check `alertSetting == 2` before assuming a banner will appear; `notificationCenterSetting == 2` with `alertSetting == 0` means "lands in Notification Center history, no banner". That combination is exactly what I measured pre-authorization, and it matches Apple's note that *"The system still displays alerts in Notification Center if … notificationCenterSetting is … enabled."*

The `ncprefs` view agrees: an app that has been registered but never authorized carries `auth = 0` (§6, fact 3), so `authorizationStatus == 0` and `auth == 0` are the same fact seen from two angles. Use `getNotificationSettings` — it is supported and stable; read `ncprefs` only when you need to know *which signature* the grant belongs to (`src[].uuid`).

**Pre-granting by editing `com.apple.ncprefs`** (writing an `apps` entry with `auth = 7` and a matching `src` requirement, then restarting `usernoted`) is possible in principle and is what some fleet tools do. It is unsupported, undocumented, version-fragile, requires a `cfprefsd`/`usernoted` restart, and the `req` blob must match your signature. **UNCERTAIN** and not attempted here (it would mean killing system daemons). Do not ship it as the primary path.

---

## 8. `osascript -e 'display notification'` as fallback (Q6)

Viable for a *banner*, useless for *actions*. Verified from the system's own scripting definition **[MEASURED]**:

```
$ sdef /System/Library/ScriptingAdditions/StandardAdditions.osax
<command name="display notification" code="sysonotf"
         description="Display a notification. At least one of the body text and the title must be specified.">
    <direct-parameter type="text" optional="yes" description="the body text of the notification"/>
    <parameter name="with title"  code="appr" type="text" optional="yes" .../>
    <parameter name="subtitle"    code="subt" type="text" optional="yes" .../>
    <parameter name="sound name"  code="nsou" type="text" optional="yes" .../>
</command>
```

Four inputs, all strings. **No** `actions`, no `category`, no `identifier`, no reply parameter, no completion. It is fire-and-forget by construction — there is no mechanism in the command to receive anything back.

Further limits that matter operationally:

- **The sender identity is not yours.** The notification is attributed to the *responsible* app — `Script Editor` (or the terminal running `osascript`, or `osascript` itself depending on how it's invoked). The user's allow/deny and focus/DND settings for *your* helper do not apply; they apply to Script Editor's. Turning off "Script Editor" notifications silently kills your fallback (a failure mode documented by the Python `macos` bindings, which raise `PermissionDeniedError` precisely because there is no error to detect).
- **No click-through.** Clicking does nothing; there is no default action you can intercept.
- **`osascript` costs ~100 ms+** and spawns a process per notification; fine for a handful per day, wrong for a stream.
- **No `threadIdentifier`**, so no grouping; each banner is independent.

**Use it only as:** "authorization is `notDetermined`/`denied` and something is better than silence" — a degraded banner with the text `Free game: X — open the dashboard to claim`. Never as the action path.

(Third-party `terminal-notifier` is the other common fallback and *does* support `-actions` via a deprecated private path; it is not installed here and I did not evaluate it — **UNCERTAIN**, and it would be an install, which is out of scope for this task.)

---

## 9. Recommended architecture

```
┌──────────────────────────────┐        unix socket          ┌────────────────────────────────┐
│  Node.js app                 │  ~/Library/Application      │  HermesNotify.app              │
│  (launchd LaunchAgent,       │   Support/HermesNotify/     │  (LSUIElement, ad-hoc signed,  │
│   runs as agent23)           │   helper.sock               │   under ~/Library/Application  │
│                              │                             │   Support/HermesNotify/)       │
│  • picks the free game       │ ── {"cmd":"post",...} ────► │  • UNUserNotificationCenter    │
│  • owns all retry/expiry     │ ◄── {"ok":true,"id":..} ──  │  • delegate set at launch      │
│  • drains actions.log        │                             │  • category CLAIM/SKIP         │
│                              │ ◄── {"event":"action",...}─  │  • posts, receives actions     │
└──────────────────────────────┘                             └────────────────────────────────┘
             ▲                                                             │
             └──────────── also: actions.log (append-only, durable) ◄──────┘
```

**Components**

1. **`~/Library/Application Support/HermesNotify/HermesNotify.app`** — LSUIElement, `com.agent23.hermes.notifyhelper`, ad-hoc signed today (self-signed identity later, §6), registered with `lsregister -f`.
2. **`~/Library/LaunchAgents/com.agent23.hermes.notifyhelper.plist`** — `ProgramArguments` → the binary inside the bundle; `KeepAlive` true; `RunAtLoad` true; `ProcessType` `Interactive`; `StandardErrorPath` to a log. Running it from the bundle (not `open`) is fine *provided* `lsregister -f` ran at install — but adding `open -g -n` semantics is better for click-to-launch: prefer `Program` = `/usr/bin/open` with `-g -n -a`, or simply let LaunchServices launch it and use launchd only as a supervisor. **UNCERTAIN** which handles "clicked while not running" cleanly; the resident design makes it moot.
3. **Protocol** — newline-delimited JSON, both directions, on `helper.sock` (mode 0600, dir 0700):

   | Node → helper | Reply |
   |---|---|
   | `{"cmd":"status"}` | `{"ok":true,"authorizationStatus":0,"alertSetting":0,…}` |
   | `{"cmd":"authorize"}` | `{"ok":true,"granted":false,"authorizationStatus":0,…}` (may hang — use a 30 s client timeout and *do not* treat a timeout as denial) |
   | `{"cmd":"post","id":"…","title":"Free game: X","body":"Claim / Skip","url":"…"}` | `{"ok":true,"id":"…"}` or `{"ok":false,"error":"…","code":1,"domain":"UNErrorDomain"}` |

   | Helper → Node (unsolicited) |
   |---|
   | `{"event":"action","id":"…","action":"HERMES_CLAIM","url":"…","ts":…}` |

4. **Durability** — helper appends each event to `actions.log` *before* broadcasting; Node keeps a byte offset and drains on startup. This is what makes the choice "deterministic" even across a Node restart or a helper crash.
5. **Idempotency** — notification `identifier` == your offer id. Node dedupes on `id`: the same click can be replayed from the log, and `add()` with the same identifier replaces rather than duplicates the pending request.
6. **Expiry** — no callback ever arrives if the user ignores the notification. Node should expire the offer itself (e.g. 24 h) and, if it wants to know, set `.customDismissAction` to catch explicit dismissals.
7. **The frozen-helper rule** (§6, option 2): keep the Swift binary's behaviour generic so releases never force a re-sign, and therefore never force a re-grant. This is the single highest-value architectural decision for this machine.

**What the user sees:** a banner titled *HermesNotify* (or your `CFBundleDisplayName`) reading `Free game: X`, with **Claim** and **Skip** buttons, no dock icon, no window, no focus steal — and, with `options: []`, answerable without unlocking the screen.

---

## 10. Verification log (what was actually run)

| # | Probe | Result |
|---|---|---|
| 1 | `swiftc --version` | `Apple Swift version 6.1.2`, target `x86_64-apple-macosx15.0`; `xcode-select -p` → `/Library/Developer/CommandLineTools`; no `/Applications/Xcode.app` |
| 2 | `./bare` (no bundle) | `Segmentation fault: 11`; crash report frames: `objc_exception_throw` → `NSAssertionHandler` → `+[UNUserNotificationCenter currentNotificationCenter]`; log: `Assertion failure in <private>, UNUserNotificationCenter.m:63` |
| 3 | `./NotifyProbe.app/Contents/MacOS/NotifyProbe` (bundled, ad-hoc, run directly) | OK: `center = <UNUserNotificationCenter…>`, `authorizationStatus = 0`, `alertSetting = 0`, exit 0. No prompt. |
| 4 | same bundle copied to `$(mktemp -d)` (`/var/folders/…`) | OK, `authorizationStatus = 0` — API works there; grant/delivery refused per external report (not re-tested) |
| 5 | `codesign -d -r- NotifyProbe.app` | `designated => cdhash H"a5e6b6fe…"` (no identifier clause) |
| 6 | rebuild + re-sign, same id/path | `CDHash=c9a27953…`, DR changed → identity broken |
| 7 | `codesign -d -r- /Applications/cmux.app`, `Monit.app` | `identifier … and certificate leaf[subject.OU] = …` — identity-based, survives rebuilds |
| 8 | `lsregister -dump \| grep -c notifyprobe` before/after `open -g -n` | `0` → `3` (direct exec does not register; `open` does) |
| 9 | `security find-identity -v -p codesigning` | `0 valid identities found` (ad-hoc only on this box) |
| 10 | self-signed cert import into scratch keychain | `1 identity imported`, SHA-1 `B4A93187…`; `codesign -s <sha1>` → `error: The specified item could not be found in the keychain` (needs trust settings ⇒ admin GUI) |
| 11 | `probe/harness.py` + `clienttest.swift` from inside the bundle | `HTTP 200 body={"ok":true}` and `UNIX wrote 79 bytes`; server received both JSON payloads, header secret intact |
| 12 | `swiftc -O -swift-version 5 NotifyHelper.swift` | clean build, exit 0, no warnings |
| 13 | `probe/drive_helper.py` — launch LSUIElement helper, speak the socket protocol | `running: True`, `socket exists: True`, `{"cmd":"status"}` → `{"notificationCenterSetting":2,"ok":true,"authorizationStatus":0,"alertSetting":0,"soundSetting":0}`, `{"cmd":"bogus"}` → `{"error":"unknown cmd","ok":false}`, SIGTERM → `exit -15` |
| 14 | `sdef /System/Library/ScriptingAdditions/StandardAdditions.osax` | `display notification` has exactly 4 string params, no actions/reply |
| 15 | `plutil -p com.apple.ncprefs.plist` | entries keyed by `bundle-id` with `path`, `auth`, `flags`, and `src[].req` (fade0c00 requirement blob) + `uuid` |
| 16 | `sqlite3 …/usernoted/db2/db ".tables"` | `app, categories, dbinfo, delivered, displayed, record, requests, snoozed`; `app(identifier)` |
| 17 | `ncprefs` before vs after `open -g -n` of the probe | entry absent → present with `auth = 0`, a `src[].req` blob and `src[].uuid`; no prompt, no authorization involved |

**Not verified, by design:** anything that would put a notification or permission prompt on the owner's screen. That is exactly probes "post a real notification", "click an action", "observe the prompt with nobody present", and "does the grant survive a rebuild in practice". Each is flagged **UNCERTAIN** above with the reasoning and the structural evidence that predicts its outcome.

---

## 11. Open questions worth a 5-minute test on a machine with a person at it

1. Does an ad-hoc re-signed rebuild silently keep, drop, or re-prompt the grant? (Watch `ncprefs` `src[].uuid` before/after.)
2. Does a background-launched LSUIElement app actually receive `didReceive` for a click when it was not running? (Log to `actions.log`, click once.)
3. Does the self-signed-certificate DR (`certificate leaf = H"…"`) indeed preserve the grant across rebuilds? (Trust the cert once, then rebuild twice.)
4. Does macOS show the authorization prompt while the screen is locked, or defer it to unlock?

Each is a single notification or a single click — cheap to answer with the harness in `probe/`.

---

## 12. State left behind by this research

- `probe/` — `bare.swift` (unbundled negative test), `bundled.swift`, `clienttest.swift` (transport test), `harness.py` (drives it), `NotifyHelper.swift` (the reference implementation), plus built bundles `NotifyProbe.app/` and `build/NotifyHelper.app/`. All unregistered from LaunchServices (`lsregister -u`), nothing running.
- Two **inert** rows remain in `~/Library/Preferences/com.apple.ncprefs.plist` for `com.agent23.hermes.notifyprobe` and `com.agent23.hermes.notifyhelper` (`auth = 0`, never authorized). They may appear in System Settings › Notifications. Removing them requires editing that plist and restarting `usernoted`/`cfpresfd`, which I did not do on a live user session. They disappear if you instead adopt the same bundle id for the real helper — the path in the record is simply updated.
- `~/Library/Application Support/HermesNotify/` created by the helper during probe 13 was removed.
- No notification was posted and no permission prompt was raised at any point; `requestAuthorization` and `add(_:)` were never called on this machine.

---

## References

- [UNUserNotificationCenter](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter) · [`current()`](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/current())
- [`delegate`](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/delegate) — set before launch completes
- [`requestAuthorization(options:completionHandler:)`](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/requestauthorization(options:completionhandler:))
- [Asking permission to use notifications](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications)
- [Declaring your actionable notification types](https://developer.apple.com/documentation/usernotifications/declaring-your-actionable-notification-types)
- [Handling notifications and notification-related actions](https://developer.apple.com/documentation/usernotifications/handling-notifications-and-notification-related-actions)
- [`userNotificationCenter(_:didReceive:withCompletionHandler:)`](https://developer.apple.com/documentation/usernotifications/unusernotificationcenterdelegate/usernotificationcenter(_:didreceive:withcompletionhandler:))
- [UNNotificationAction](https://developer.apple.com/documentation/usernotifications/unnotificationaction) · [UNNotificationCategory](https://developer.apple.com/documentation/usernotifications/unnotificationcategory) · [UNNotificationActionOptions](https://developer.apple.com/documentation/usernotifications/unnotificationactionoptions)
- [LSUIElement](https://developer.apple.com/documentation/bundleresources/information-property-list/lsuielement)
- Local SDK headers used as ground truth: `…/UserNotifications.framework/Headers/{UNError,UNNotificationAction,UNNotificationCategory}.h`
- Corroborating field report (measured, not documented): [go-macos/usernotifications](https://github.com/go-macos/usernotifications) — bundle requirement, ad-hoc signing, LaunchServices registration, the `/var/folders` refusal
