//
//  EpicClaimsNotifier — frozen, generic UserNotifications transport.
//
//  Deliberately dumb: it posts whatever title/subtitle/body it is told, shows
//  Claim/Skip buttons when asked, and reports clicks by POSTing the single-use
//  approval token back to the local Epic Claims API. All behaviour (which games,
//  which templates, whether to claim at all) lives in Node.
//
//  That matters on macOS: an ad-hoc signature's designated requirement is just
//  the cdhash, and the notification authorization is keyed to the bundle
//  identifier *plus* that requirement — so every rebuild can cost the user a
//  re-prompt. Never changing this binary is the cheapest way to keep the grant.
//
//  Protocol (newline-delimited JSON over an AF_UNIX socket):
//    -> {"cmd":"status"}                     <- {"ok":true,"authorizationStatus":n,…}
//    -> {"cmd":"authorize"}                  <- {"ok":true,"granted":bool,…}   (may block)
//    -> {"cmd":"post", "id","title","subtitle","body","sound",
//        "actions":[{"id":"claim","title":"Claim"}],
//        "approvalToken","approvalBase"}     <- {"ok":true,"id":"…"}
//    -> {"cmd":"ping"}                       <- {"ok":true}
//  Clicks are appended to --actions-log before the HTTP callback runs, so a Node
//  restart can never lose a decision.
//

import AppKit
import Foundation
import UserNotifications

// MARK: - small helpers

let categoryWithActions = "EPIC_CLAIMS_ACTIONS"

func jsonLine(_ object: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: []),
          let text = String(data: data, encoding: .utf8) else {
        return "{\"ok\":false,\"error\":\"encoding failed\"}\n"
    }
    return text + "\n"
}

func writeLine(_ fd: Int32, _ object: [String: Any]) {
    // Writing to a socket whose peer has gone raises SIGPIPE, whose default
    // action terminates the process. A client that times out or disconnects must
    // never be able to kill the helper, so SIGPIPE is ignored process-wide (see
    // main) and a failed write simply closes the descriptor.
    let text = jsonLine(object)
    text.withCString { ptr in
        var written = 0
        let length = strlen(ptr)
        while written < length {
            let n = write(fd, ptr + written, length - written)
            if n <= 0 { break }
            written += n
        }
    }
}

func appendLine(path: String, object: [String: Any]) {
    let manager = FileManager.default
    let dir = (path as NSString).deletingLastPathComponent
    if !manager.fileExists(atPath: dir) {
        try? manager.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                     attributes: [.posixPermissions: 0o700])
    }
    if !manager.fileExists(atPath: path) {
        manager.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    guard let handle = FileHandle(forWritingAtPath: path) else { return }
    defer { try? handle.close() }
    handle.seekToEndOfFile()
    if let data = (jsonLine(object)).data(using: .utf8) {
        handle.write(data)
    }
}

/// POSTs the approval decision. A loopback literal IP needs no ATS exception,
/// but NSAllowsLocalNetworking is set in Info.plist as a belt-and-braces measure.
func postApproval(base: String, token: String, decision: String, log: String) {
    guard !base.isEmpty, !token.isEmpty, let url = URL(string: base + "/api/public/approval") else { return }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.timeoutInterval = 15
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token, "decision": decision])

    let semaphore = DispatchSemaphore(value: 0)
    var resultLine: [String: Any] = ["event": "callback", "ok": false]
    URLSession.shared.dataTask(with: request) { data, response, error in
        defer { semaphore.signal() }
        if let http = response as? HTTPURLResponse {
            resultLine["status"] = http.statusCode
            resultLine["ok"] = (200..<300).contains(http.statusCode)
        }
        if let error = error { resultLine["error"] = error.localizedDescription }
        if let data = data, let text = String(data: data, encoding: .utf8) {
            resultLine["body"] = String(text.prefix(400))
        }
    }.resume()
    _ = semaphore.wait(timeout: .now() + 20)
    appendLine(path: log, object: resultLine)
}

// MARK: - app delegate

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    var server: SocketServer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Rule 1: the delegate must be set before launch completes, otherwise
        // actions that launched the app are dropped.
        let center = UNUserNotificationCenter.current()
        center.delegate = self

        // Rule 2: categories are looked up at delivery time, so they must exist
        // on every launch — including a launch caused by an action click.
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: categoryWithActions,
                actions: [
                    UNNotificationAction(identifier: "claim", title: "Claim", options: []),
                    UNNotificationAction(identifier: "skip", title: "Skip", options: []),
                ],
                intentIdentifiers: [],
                options: [.customDismissAction]
            )
        ])

        if let server = server {
            do {
                try server.start()
            } catch {
                FileHandle.standardError.write(Data("socket start failed: \(error)\n".utf8))
            }
        }
        print("{\"event\":\"ready\"}")
        fflush(stdout)
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let identifier = response.actionIdentifier
        let decision: String?
        switch identifier {
        case "claim": decision = "claim"
        case "skip": decision = "skip"
        default: decision = nil
        }
        let record: [String: Any] = [
            "event": "action",
            "id": response.notification.request.identifier,
            "action": decision ?? (identifier == UNNotificationDismissActionIdentifier ? "dismiss" : "default"),
            "token": (info["token"] as? String) ?? "",
            "ts": Int(Date().timeIntervalSince1970),
        ]
        // Durability first: the click must survive whatever happens next.
        appendLine(path: ServerConfig.actionsLog, object: record)
        if let decision = decision {
            postApproval(base: (info["base"] as? String) ?? "",
                         token: (info["token"] as? String) ?? "",
                         decision: decision,
                         log: ServerConfig.actionsLog)
        }
        // Rule 3: complete only after the durable write.
        completionHandler()
    }
}

// MARK: - unix socket server

enum ServerConfig {
    static var socketPath = NSHomeDirectory() + "/Library/Application Support/Epic Claims/notifier/helper.sock"
    static var actionsLog = NSHomeDirectory() + "/Library/Application Support/Epic Claims/notifier/actions.log"
}

final class SocketServer {
    private var listenFd: Int32 = -1
    private var source: DispatchSourceRead?
    private let queue = DispatchQueue(label: "com.diy23.epic-claims.notifier.socket")

    func start() throws {
        let path = ServerConfig.socketPath
        let dir = (path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        unlink(path)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw NSError(domain: "socket", code: Int(errno)) }
        listenFd = fd

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLength = MemoryLayout.size(ofValue: addr.sun_path)
        guard path.utf8.count < maxLength else {
            throw NSError(domain: "socket", code: -1, userInfo: [NSLocalizedDescriptionKey: "socket path too long"])
        }
        path.withCString { cString in
            withUnsafeMutablePointer(to: &addr.sun_path) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: maxLength) { destination in
                    _ = strncpy(destination, cString, maxLength - 1)
                }
            }
        }

        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) }
        }
        guard bound == 0 else { throw NSError(domain: "bind", code: Int(errno)) }
        chmod(path, 0o600)
        guard listen(fd, 8) == 0 else { throw NSError(domain: "listen", code: Int(errno)) }

        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        src.setEventHandler { [weak self] in self?.acceptPending() }
        src.resume()
        source = src
    }

    private func acceptPending() {
        for _ in 0..<8 {
            let client = accept(listenFd, nil, nil)
            if client < 0 { return }
            handle(client: client)
        }
    }

    private func handle(client: Int32) {
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            let n = read(client, &chunk, chunk.count)
            if n <= 0 { break }
            buffer.append(contentsOf: chunk[0..<n])
            if buffer.contains(UInt8(ascii: "\n")) { break }
        }

        // The reply is always written by the closure below, then the fd is closed
        // exactly once. Closing here instead would race every asynchronous reply.
        let reply: ([String: Any]) -> Void = { object in
            writeLine(client, object)
            close(client)
        }

        guard let newline = buffer.firstIndex(of: UInt8(ascii: "\n")),
              let object = try? JSONSerialization.jsonObject(with: buffer[0..<newline]) as? [String: Any],
              let command = object["cmd"] as? String else {
            reply(["ok": false, "error": "malformed request"])
            return
        }
        dispatch(command: command, payload: object, reply: reply)
    }

    private func dispatch(command: String, payload: [String: Any], reply: @escaping ([String: Any]) -> Void) {
        switch command {
        case "ping":
            reply(["ok": true])
        case "status":
            NotificationBridge.status(reply)
        case "authorize":
            NotificationBridge.authorize(reply)
        case "post":
            NotificationBridge.post(payload: payload, reply)
        case "quit":
            reply(["ok": true])
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { exit(0) }
        default:
            reply(["ok": false, "error": "unknown command \(command)"])
        }
    }
}

// MARK: - notifications

enum NotificationBridge {
    static func settingsDictionary(_ settings: UNNotificationSettings) -> [String: Any] {
        [
            "ok": true,
            "authorizationStatus": settings.authorizationStatus.rawValue,
            "alertSetting": settings.alertSetting.rawValue,
            "notificationCenterSetting": settings.notificationCenterSetting.rawValue,
            "soundSetting": settings.soundSetting.rawValue,
        ]
    }

    static func status(_ completion: @escaping ([String: Any]) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            completion(settingsDictionary(settings))
        }
    }

    static func authorize(_ completion: @escaping ([String: Any]) -> Void) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            center.getNotificationSettings { settings in
                var reply = settingsDictionary(settings)
                reply["granted"] = granted
                if let error = error { reply["error"] = error.localizedDescription }
                completion(reply)
            }
        }
    }

    static func post(payload: [String: Any], _ completion: @escaping ([String: Any]) -> Void) {
        let identifier = (payload["id"] as? String) ?? UUID().uuidString
        let actions = (payload["actions"] as? [[String: Any]]) ?? []
        let content = UNMutableNotificationContent()
        content.title = (payload["title"] as? String) ?? "Epic Claims"
        let subtitle = (payload["subtitle"] as? String) ?? ""
        if !subtitle.isEmpty { content.subtitle = subtitle }
        content.body = (payload["body"] as? String) ?? ""
        if (payload["sound"] as? Bool) == true { content.sound = .default }
        content.userInfo = [
            "token": (payload["approvalToken"] as? String) ?? "",
            "base": (payload["approvalBase"] as? String) ?? "",
        ]
        if !actions.isEmpty {
            content.categoryIdentifier = categoryWithActions
            content.threadIdentifier = "epic-claims"
        }
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error = error as NSError? {
                completion([
                    "ok": false,
                    "error": error.localizedDescription,
                    "code": error.code,
                    "domain": error.domain,
                ])
            } else {
                completion(["ok": true, "id": identifier])
            }
        }
    }
}

// MARK: - entry point

func parseArguments() {
    // --status / --authorize are one-shot modes used by the CLI during setup.
    let args = CommandLine.arguments
    var index = 1
    var oneShot: String? = nil
    while index < args.count {
        switch args[index] {
        case "--socket":
            if index + 1 < args.count { ServerConfig.socketPath = args[index + 1]; index += 1 }
        case "--actions-log":
            if index + 1 < args.count { ServerConfig.actionsLog = args[index + 1]; index += 1 }
        case "--status":
            oneShot = "status"
        case "--authorize":
            oneShot = "authorize"
        default:
            break
        }
        index += 1
    }
    if let oneShot = oneShot {
        runOneShot(oneShot)
    }
}

func runOneShot(_ mode: String) {
    var finished = false
    let handler: ([String: Any]) -> Void = { reply in
        print(jsonLine(reply).trimmingCharacters(in: .newlines))
        finished = true
    }
    if mode == "status" {
        NotificationBridge.status(handler)
    } else {
        NotificationBridge.authorize(handler)
    }
    let deadline = Date().addingTimeInterval(mode == "authorize" ? 120 : 10)
    while !finished && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    exit(finished ? 0 : 2)
}

// Ignore SIGPIPE for the whole process: a socket write to a peer that has gone
// must return EPIPE, not kill the helper (that was exit -13 on every click).
signal(SIGPIPE, SIG_IGN)

parseArguments()

let app = NSApplication.shared
let delegate = AppDelegate()
delegate.server = SocketServer()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
