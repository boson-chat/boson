// The extension's decrypt, parsing and filtering, run on the Mac:
//   desktop/scripts/test-ios-push.sh
// Same cases as the renderer's payload.test.ts / filter.test.ts.
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String, file: StaticString = #file, line: UInt = #line) {
    if !ok { failures += 1; print("FAIL \(what) (line \(line))") }
}
func eq<T: Equatable>(_ a: T, _ b: T, _ what: String, line: UInt = #line) {
    if a != b { failures += 1; print("FAIL \(what) (line \(line)): \(a) != \(b)") }
}
let u = PushStore.b64url

// RFC 8291 §5.
do {
    let keys = try PushKeys(privateRaw: u("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")!, auth: u("BTBZMqHH6r4Tts7J_aSIgg")!)
    eq(keys.publicRaw, u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")!, "rfc public key")
    let body = u("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")!
    eq(String(data: try PushCrypto.decrypt(body, keys: keys), encoding: .utf8), "When I grow up, I want to be a watermelon", "rfc 8291 vector")
    // The wrong key fails.
    let other = try PushKeys(privateRaw: Data(repeating: 7, count: 32), auth: Data(repeating: 1, count: 16))
    check((try? PushCrypto.decrypt(body, keys: other)) == nil, "wrong key must not decrypt")
} catch { failures += 1; print("FAIL rfc vector: \(error)") }

// A body from Ergo's own library (desktop/testdata, record size 2048).
let vecPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "desktop/testdata/webpush-ergo-vector.json"
var ergoBody = Data()
var ergoKeys: PushKeys?
do {
    let v = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: vecPath))) as! [String: String]
    let keys = try PushKeys(privateRaw: u(v["private"]!)!, auth: u(v["auth"]!)!)
    eq(keys.publicRaw, u(v["public"]!)!, "ergo vector public key")
    ergoBody = Data(base64Encoded: v["body"]!)!
    ergoKeys = keys
    eq(String(data: try PushCrypto.decrypt(ergoBody, keys: keys), encoding: .utf8), v["plaintext"], "ergo vector")
} catch { failures += 1; print("FAIL ergo vector: \(error)") }

// Parsing (payload.test.ts).
eq(PushLine.message("PING webpush"), .ping, "ping")
eq(PushLine.message("@msgid=m1;time=2026-11-27T10:00:00.000Z :thelion!u@h PRIVMSG #team :bob: look"),
   .message(kind: .mention, nick: "thelion", conversation: "#team", text: "bob: look", action: false, time: "2026-11-27T10:00:00.000Z"), "mention")
eq(PushLine.message(":alice!u@h PRIVMSG bob :hey"), .message(kind: .dm, nick: "alice", conversation: "alice", text: "hey", action: false, time: nil), "dm")
eq(PushLine.message(":alice!u@h PRIVMSG bob :\u{1}ACTION waves\u{1}"), .message(kind: .dm, nick: "alice", conversation: "alice", text: "waves", action: true, time: nil), "action")
eq(PushLine.message(":alice!u@h PRIVMSG bob :\u{1}VERSION\u{1}"), .other, "ctcp")
eq(PushLine.message(":irc.example NOTICE bob :server says"), .other, "server notice")
eq(PushLine.message(":alice!u@h JOIN #x"), .other, "join")
eq(PushLine.message("@time=x :irc.example MARKREAD #team timestamp=2026-11-27T10:00:00.000Z"), .read(target: "#team", time: "2026-11-27T10:00:00.000Z"), "markread")
eq(PushLine.message(":irc.example MARKREAD alice timestamp=*"), .read(target: "alice", time: nil), "markread *")
eq(PushLine.parse("@a=x\\sy\\:z\\\\ PING")?.tags["a"], "x y;z\\", "tag escapes")
eq(PushLine.text(PushLine.message(":thelion!u@h PRIVMSG #team :\u{2}bob\u{2}: \u{3}04look\u{3} here"), serverId: "s1", serverName: "Boson"),
   PushText(title: "thelion in #team", subtitle: "Boson", body: "bob: look here", tag: "s1:#team"), "channel text")
eq(PushLine.text(PushLine.message(":Alice!u@h PRIVMSG bob :\u{1}ACTION waves\u{1}"), serverId: "s1", serverName: "Boson")?.body, "* Alice waves", "action text")
eq(PushLine.text(PushLine.message(":Alice!u@h PRIVMSG bob :hi"), serverId: "s1", serverName: "Boson")?.tag, "s1:alice", "dm tag")
eq(PushLine.clean(String(repeating: "x", count: 300)).count, 180, "clamp")

// Filtering (filter.test.ts).
let dm = PushLine.message(":alice!u@h PRIVMSG bob :hey")
let mention = PushLine.message(":alice!u@h PRIVMSG #team :bob: hey")
check(PushLine.shouldShow(dm, serverId: "s1", prefs: nil), "dm by default")
check(PushLine.shouldShow(mention, serverId: "s1", prefs: [:]), "mention by default")
check(!PushLine.shouldShow(.ping, serverId: "s1", prefs: nil), "never a ping")
check(!PushLine.shouldShow(dm, serverId: "s1", prefs: ["enabled": false]), "disabled")
check(!PushLine.shouldShow(dm, serverId: "s1", prefs: ["directMessages": false]), "no dms")
check(!PushLine.shouldShow(mention, serverId: "s1", prefs: ["mentions": false]), "no mentions")
check(!PushLine.shouldShow(mention, serverId: "s1", prefs: ["levels": ["s1\u{0}#team": "nothing"]]), "muted channel")
check(PushLine.shouldShow(mention, serverId: "s2", prefs: ["levels": ["s1\u{0}#team": "nothing"]]), "other server")
check(!PushLine.shouldShow(dm, serverId: "s1", prefs: ["servers": ["s1": ["dms": "nothing"]]]), "server dms nothing")
check(!PushLine.shouldShow(mention, serverId: "s1", prefs: ["servers": ["s1": ["channels": "nothing"]]]), "server channels nothing")
check(PushLine.shouldShow(dm, serverId: "s1", prefs: ["servers": ["s1": ["dms": "nothing"]], "levels": ["s1\u{0}alice": "all"]]), "own level wins")

// The extension's decision, end to end over the Ergo body.
if let keys = ergoKeys {
    let rec = PushStore.Record(serverId: "s1", serverName: "Boson HQ", mailbox: "mb1", keys: keys)
    let stranger = PushStore.Record(serverId: "s2", serverName: "Other", mailbox: "mb2",
                                    keys: try! PushKeys(privateRaw: Data(repeating: 9, count: 32), auth: Data(repeating: 2, count: 16)))
    // As the relay sends it (pushrelay delivery/apns.go).
    let info: [AnyHashable: Any] = ["aps": ["alert": ["body": "New message"], "mutable-content": 1],
                                    "boson": ["v": 1, "mailbox": "mb1", "payload": ergoBody.base64EncodedString()]]
    if case let .show(t, sid, conv) = PushReceiver.decide(info, records: [stranger, rec], prefs: nil) {
        eq(t, PushText(title: "thelion in #team", subtitle: "Boson HQ", body: "bob: ship it", tag: "s1:#team"), "decide text")
        eq(sid, "s1", "decide server"); eq(conv, "#team", "decide conversation")
    } else { failures += 1; print("FAIL decide: not shown") }
    // No mailbox id: found by trying the keys; url-safe base64 too.
    let urlSafe = ergoBody.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    if case .show = PushReceiver.decide(["p": urlSafe], records: [stranger, rec], prefs: nil) {} else { failures += 1; print("FAIL decide by trial") }
    // Muted: dropped. Unknown keys: a known mailbox falls back, a stranger's is dropped.
    if case .drop = PushReceiver.decide(info, records: [rec], prefs: ["levels": ["s1\u{0}#team": "nothing"]]) {} else { failures += 1; print("FAIL muted") }
    if case .fallback(serverId: "s1") = PushReceiver.decide(info, records: [PushStore.Record(serverId: "s1", serverName: "", mailbox: "mb1", keys: stranger.keys)], prefs: nil) {} else { failures += 1; print("FAIL fallback") }
    if case .drop = PushReceiver.decide(info, records: [stranger], prefs: nil) {} else { failures += 1; print("FAIL stranger") }
}

if failures > 0 { print("\(failures) failed"); exit(1) }
print("ok: push extension tests passed")
