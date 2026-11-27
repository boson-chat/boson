// What a decrypted push says, and whether to show it: the same rules as the
// renderer's client/src/renderer/src/modules/push/payload.ts and filter.ts
// (kept in step with them; tests/main.swift runs the same cases).
import Foundation

enum PushMessage: Equatable {
    case ping
    case read(target: String, time: String?)
    case message(kind: Kind, nick: String, conversation: String, text: String, action: Bool, time: String?)
    case other

    enum Kind: String { case dm, mention }
}

struct PushText: Equatable {
    let title: String
    let subtitle: String
    let body: String
    let tag: String
}

enum PushLine {
    static func unescapeTag(_ v: Substring) -> String {
        var out = ""
        var it = v.makeIterator()
        while let c = it.next() {
            guard c == "\\" else { out.append(c); continue }
            guard let n = it.next() else { break }
            switch n {
            case ":": out.append(";")
            case "s": out.append(" ")
            case "\\": out.append("\\")
            case "r": out.append("\r")
            case "n": out.append("\n")
            default: out.append(n)
            }
        }
        return out
    }

    static func parse(_ raw: String) -> (tags: [String: String], source: String, command: String, params: [String])? {
        var s = Substring(raw)
        while s.last == "\n" || s.last == "\r" { s = s.dropLast() }
        var tags: [String: String] = [:]
        if s.first == "@" {
            guard let sp = s.firstIndex(of: " ") else { return nil }
            for t in s[s.index(after: s.startIndex)..<sp].split(separator: ";") {
                if let eq = t.firstIndex(of: "=") {
                    tags[String(t[..<eq])] = unescapeTag(t[t.index(after: eq)...])
                } else {
                    tags[String(t)] = ""
                }
            }
            s = s[s.index(after: sp)...].drop(while: { $0 == " " })
        }
        var source = ""
        if s.first == ":" {
            guard let sp = s.firstIndex(of: " ") else { return nil }
            source = String(s[s.index(after: s.startIndex)..<sp])
            s = s[s.index(after: sp)...].drop(while: { $0 == " " })
        }
        var command = ""
        var params: [String] = []
        while !s.isEmpty {
            if !command.isEmpty && s.first == ":" { params.append(String(s.dropFirst())); break }
            let sp = s.firstIndex(of: " ")
            let word = sp.map { s[..<$0] } ?? s
            if command.isEmpty { command = word.uppercased() } else { params.append(String(word)) }
            guard let sp else { break }
            s = s[s.index(after: sp)...].drop(while: { $0 == " " })
        }
        return command.isEmpty ? nil : (tags, source, command, params)
    }

    static func isChannel(_ t: String) -> Bool {
        guard let f = t.first else { return false }
        return "#&!+".contains(f)
    }

    static func message(_ raw: String) -> PushMessage {
        guard let l = parse(raw) else { return .other }
        if l.command == "PING" { return .ping }
        if l.command == "MARKREAD" {
            guard let target = l.params.first, !target.isEmpty else { return .other }
            var ts = l.params.count > 1 ? l.params[1] : ""
            if ts.hasPrefix("timestamp=") { ts = String(ts.dropFirst("timestamp=".count)) }
            return .read(target: target, time: ts.isEmpty || ts == "*" ? nil : ts)
        }
        guard l.command == "PRIVMSG" || l.command == "NOTICE" else { return .other }
        guard let target = l.params.first, !target.isEmpty,
              let bang = l.source.firstIndex(of: "!"), bang != l.source.startIndex else { return .other }
        let nick = String(l.source[..<bang])
        var text = l.params.count > 1 ? l.params[1] : ""
        var action = false
        if text.hasPrefix("\u{1}") {
            var inner = text.dropFirst()
            if inner.last == "\u{1}" { inner = inner.dropLast() }
            guard inner.hasPrefix("ACTION") else { return .other }
            inner = inner.dropFirst("ACTION".count)
            if inner.first == " " { inner = inner.dropFirst() }
            action = true
            text = String(inner)
        }
        let channel = isChannel(target)
        return .message(kind: channel ? .mention : .dm, nick: nick, conversation: channel ? target : nick,
                        text: text, action: action, time: l.tags["time"])
    }

    static func clean(_ s: String, max: Int = 180) -> String {
        var t = s.replacingOccurrences(of: "\u{3}(\\d{1,2}(,\\d{1,2})?)?", with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: "\u{4}([0-9a-fA-F]{6}(,[0-9a-fA-F]{6})?)?", with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: "[\u{2}\u{f}\u{11}\u{16}\u{1d}\u{1e}\u{1f}]", with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: "[\u{0}-\u{1f}\u{7f}]", with: " ", options: .regularExpression)
        t = t.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        if t.count > max { t = String(t.prefix(max - 1)) + "…" }
        return t
    }

    static func tag(serverId: String, conversation: String) -> String {
        "\(serverId):\(conversation.lowercased())"
    }

    static func text(_ m: PushMessage, serverId: String, serverName: String) -> PushText? {
        guard case let .message(kind, nick, conversation, text, action, _) = m else { return nil }
        return PushText(
            title: kind == .dm ? nick : "\(nick) in \(conversation)",
            subtitle: serverName,
            body: action ? clean("* \(nick) \(text)") : clean(text),
            tag: tag(serverId: serverId, conversation: conversation))
    }

    /// filter.ts shouldShowPush over the PushPrefs JSON the app wrote.
    static func shouldShow(_ m: PushMessage, serverId: String, prefs: [String: Any]?) -> Bool {
        guard case let .message(kind, _, conversation, _, _, _) = m else { return false }
        let p = prefs ?? [:]
        func flag(_ k: String) -> Bool { (p[k] as? Bool) ?? true }
        if !flag("enabled") { return false }
        let levels = p["levels"] as? [String: String] ?? [:]
        let servers = p["servers"] as? [String: [String: String]] ?? [:]
        let valid: Set<String> = ["all", "mentions", "nothing"]
        var level = levels["\(serverId)\u{0}\(conversation.lowercased())"].flatMap { valid.contains($0) ? $0 : nil }
        if level == nil {
            let sv = servers[serverId] ?? [:]
            if kind == .dm {
                level = sv["dms"].flatMap { $0 == "all" || $0 == "nothing" ? $0 : nil } ?? "all"
            } else {
                level = sv["channels"].flatMap { valid.contains($0) ? $0 : nil } ?? "mentions"
            }
        }
        if level == "nothing" { return false }
        return kind == .dm ? flag("directMessages") : flag("mentions")
    }
}
