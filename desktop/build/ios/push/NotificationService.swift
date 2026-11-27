// Boson's Notification Service Extension (docs/push.md §3.3): APNs hands it
// the relay's notification — a generic "New message" plus the server's
// encrypted Web Push body — before showing it. It decrypts the body with the
// key the app keeps for that server (desktop/push_ios.m stores it in the
// keychain shared through the App Group), reads the IRC line, applies the
// notification settings (push-prefs.json in the App Group) and shows
// "<nick> in #channel" / "<nick>" with the server's name. The app's tap
// handling (notify_ios.m) opens that conversation from userInfo["boson"].
import Foundation
import Security
import UserNotifications

enum PushStore {
    static var appGroup: String {
        (Bundle.main.object(forInfoDictionaryKey: "BosonAppGroup") as? String) ?? "group.chat.boson.app"
    }
    static let service = "chat.boson.push"

    struct Record {
        let serverId: String
        let serverName: String
        let mailbox: String
        let keys: PushKeys
    }

    static func b64url(_ s: String) -> Data? {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t.append("=") }
        return Data(base64Encoded: t)
    }

    static func records() -> [Record] {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccessGroup as String: appGroup,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnData as String: true,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let items = out as? [Data] else { return [] }
        return items.compactMap { d in
            guard let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let id = j["serverId"] as? String,
                  let priv = (j["private"] as? String).flatMap(b64url),
                  let auth = (j["auth"] as? String).flatMap(b64url),
                  let keys = try? PushKeys(privateRaw: priv, auth: auth) else { return nil }
            return Record(serverId: id, serverName: j["serverName"] as? String ?? "", mailbox: j["mailbox"] as? String ?? "", keys: keys)
        }
    }

    static func prefs() -> [String: Any]? {
        guard let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup),
              let d = try? Data(contentsOf: dir.appendingPathComponent("push-prefs.json")) else { return nil }
        return try? JSONSerialization.jsonObject(with: d) as? [String: Any]
    }
}

enum PushReceiver {
    // What the relay puts next to "aps": {"boson": {"v": 1, "mailbox": id,
    // "payload": base64}} (boson-chat/pushrelay, "What the app receives").
    // Top-level fields are read too.
    static func field(_ info: [AnyHashable: Any], _ names: [String]) -> String? {
        let boson = info["boson"] as? [AnyHashable: Any] ?? [:]
        for d in [boson, info] {
            for n in names { if let v = d[n] as? String, !v.isEmpty { return v } }
        }
        return nil
    }

    static func body(_ info: [AnyHashable: Any]) -> Data? {
        guard let s = field(info, ["payload", "p", "body"]) else { return nil }
        return Data(base64Encoded: s) ?? PushStore.b64url(s)
    }

    enum Outcome {
        case show(PushText, serverId: String, conversation: String)
        case read(tag: String, time: String?)
        // Decrypts but isn't to be shown (a ping, muted, …), or nothing of
        // ours: nothing.
        case drop
        // Ours (a known mailbox) but undecryptable: the generic text, and a
        // tap opens that server.
        case fallback(serverId: String)
    }

    static func decide(_ info: [AnyHashable: Any], records: [PushStore.Record], prefs: [String: Any]?) -> Outcome {
        guard let data = body(info) else { return .drop }
        let mailbox = field(info, ["mailbox", "m", "id"])
        // The mailbox's record first; else every one (the wrong key fails
        // the AES-GCM tag).
        let ordered = records.filter { $0.mailbox == mailbox } + records.filter { $0.mailbox != mailbox }
        for r in ordered {
            guard let plain = try? PushCrypto.decrypt(data, keys: r.keys),
                  let line = String(data: plain, encoding: .utf8) else { continue }
            let m = PushLine.message(line)
            switch m {
            case let .read(target, time):
                return .read(tag: PushLine.tag(serverId: r.serverId, conversation: target), time: time)
            case let .message(_, _, conversation, _, _, _):
                guard PushLine.shouldShow(m, serverId: r.serverId, prefs: prefs),
                      let t = PushLine.text(m, serverId: r.serverId, serverName: r.serverName) else { return .drop }
                return .show(t, serverId: r.serverId, conversation: conversation)
            default:
                return .drop
            }
        }
        if let r = records.first(where: { $0.mailbox == mailbox && mailbox != nil }) { return .fallback(serverId: r.serverId) }
        return .drop
    }
}

@objc(BosonNotificationService)
final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var fallback: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        handler = contentHandler
        fallback = request.content
        let info = request.content.userInfo
        switch PushReceiver.decide(info, records: PushStore.records(), prefs: PushStore.prefs()) {
        case let .show(t, serverId, conversation):
            let c = UNMutableNotificationContent()
            c.title = t.title
            c.subtitle = t.subtitle
            c.body = t.body
            c.threadIdentifier = t.tag
            c.sound = .default
            c.userInfo = ["boson": ["server": serverId, "conversation": conversation]]
            finish(c)
        case let .read(tag, _):
            // Read elsewhere: take that conversation's notifications down.
            let center = UNUserNotificationCenter.current()
            center.getDeliveredNotifications { delivered in
                let ids = delivered.filter { $0.request.content.threadIdentifier == tag }.map { $0.request.identifier }
                center.removeDeliveredNotifications(withIdentifiers: ids)
                self.finish(UNNotificationContent())
            }
        case let .fallback(serverId):
            let c = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
            c.userInfo = ["boson": ["server": serverId, "conversation": ""]]
            finish(c)
        case .drop:
            // Without Apple's notification-filtering entitlement an
            // extension can't drop a push; empty content shows nothing.
            finish(UNNotificationContent())
        }
    }

    override func serviceExtensionTimeWillExpire() {
        finish(fallback ?? UNNotificationContent())
    }

    private func finish(_ c: UNNotificationContent) {
        guard let h = handler else { return }
        handler = nil
        h(c)
    }
}
