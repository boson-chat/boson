package com.wails.app;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.Map;

/**
 * The push receiver's plain-Java core (PushCrypto, PushLine, PushFilter)
 * on the desktop JDK, no Android needed:
 *
 *   desktop/scripts/test-android-push.sh
 *
 * Mirrors client/src/renderer/src/modules/push/{payload,filter}.test.ts.
 * Arg 1: desktop/testdata/webpush-ergo-vector.json (a body from Ergo's own
 * webpush library).
 */
public final class PushCoreTest {
    private static int failures = 0;
    private static int checks = 0;

    private static void eq(String what, Object got, Object want) {
        checks++;
        if (!String.valueOf(got).equals(String.valueOf(want))) {
            failures++;
            System.out.println("FAIL " + what + ": got <" + got + ">, want <" + want + ">");
        }
    }

    // A string field of a flat JSON object (the vector's values have no
    // escapes but Go's \u0026 for &).
    private static String jsonField(String json, String key) {
        String k = "\"" + key + "\":\"";
        int i = json.indexOf(k);
        if (i < 0) throw new IllegalArgumentException("no " + key);
        int start = i + k.length();
        int end = json.indexOf('"', start);
        return json.substring(start, end).replace("\\u0026", "&");
    }

    public static void main(String[] args) throws Exception {
        // RFC 8291 §5.
        byte[] body = PushCrypto.b64("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
        byte[] priv = PushCrypto.b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94");
        byte[] pub = PushCrypto.b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
        byte[] auth = PushCrypto.b64("BTBZMqHH6r4Tts7J_aSIgg");
        eq("RFC 8291 vector", new String(PushCrypto.decrypt(body, priv, pub, auth), StandardCharsets.UTF_8), "When I grow up, I want to be a watermelon");
        // The wrong key fails (trial decryption relies on it).
        byte[] other = PushCrypto.b64("YGB03Q7_18Pu4SOYzAjsHw");
        boolean threw = false;
        try { PushCrypto.decrypt(body, priv, pub, other); } catch (java.security.GeneralSecurityException e) { threw = true; }
        eq("wrong auth secret fails", threw, true);

        // A body from Ergo's library (record size 2048: padded).
        if (args.length > 0) {
            String v = new String(Files.readAllBytes(Paths.get(args[0])), StandardCharsets.UTF_8);
            byte[] out = PushCrypto.decrypt(PushCrypto.b64(jsonField(v, "body")), PushCrypto.b64(jsonField(v, "private")),
                    PushCrypto.b64(jsonField(v, "public")), PushCrypto.b64(jsonField(v, "auth")));
            eq("Ergo vector", new String(out, StandardCharsets.UTF_8), jsonField(v, "plaintext"));
            PushLine m = PushLine.parse(new String(out, StandardCharsets.UTF_8));
            eq("Ergo vector title", m.title(), "thelion in #team");
        } else {
            System.out.println("(no Ergo vector given)");
        }

        // payload.test.ts
        PushLine.Parsed l = PushLine.parseLine("@time=2026-11-27T10:00:00.000Z;msgid=abc;account=alice :alice!a@host PRIVMSG #team :hi bob");
        eq("tags", l.tags.get("msgid") + "," + l.tags.get("account"), "abc,alice");
        eq("source/command/params", l.source + " " + l.command + " " + l.params, "alice!a@host PRIVMSG [#team, hi bob]");
        eq("tag unescape", PushLine.parseLine("@a=x\\sy\\:z\\\\ PING").tags.get("a"), "x y;z\\");
        eq("garbage", PushLine.parseLine("@tags-only"), null);
        eq("ping", PushLine.parse("PING webpush").type, PushLine.Type.PING);
        PushLine ch = PushLine.parse("@msgid=m1;time=2026-11-27T10:00:00.000Z :thelion!u@h PRIVMSG #team :bob: look");
        eq("mention", ch.type + " " + ch.kind + " " + ch.nick + " " + ch.conversation + " " + ch.text + " " + ch.msgid + " " + ch.time,
                "MESSAGE mention thelion #team bob: look m1 2026-11-27T10:00:00.000Z");
        PushLine dm = PushLine.parse(":alice!u@h PRIVMSG bob :hey");
        eq("dm", dm.kind + " " + dm.conversation + " " + dm.title(), "dm alice alice");
        PushLine me = PushLine.parse(":alice!u@h PRIVMSG bob :\u0001ACTION waves\u0001");
        eq("action", me.action + " " + me.text + " " + me.body(), "true waves * alice waves");
        eq("notice", PushLine.parse(":alice!u@h NOTICE bob :psst").notice, true);
        eq("ctcp", PushLine.parse(":alice!u@h PRIVMSG bob :\u0001VERSION\u0001").type, PushLine.Type.OTHER);
        eq("server notice", PushLine.parse(":irc.example NOTICE bob :server says").type, PushLine.Type.OTHER);
        eq("join", PushLine.parse(":alice!u@h JOIN #x").type, PushLine.Type.OTHER);
        PushLine rd = PushLine.parse("@time=x :irc.example MARKREAD #team timestamp=2026-11-27T10:00:00.000Z");
        eq("markread", rd.type + " " + rd.target + " " + rd.time, "READ #team 2026-11-27T10:00:00.000Z");
        PushLine rd2 = PushLine.parse(":irc.example MARKREAD alice timestamp=*");
        eq("markread *", rd2.type + " " + rd2.target + " [" + rd2.time + "]", "READ alice []");
        PushLine fmt = PushLine.parse(":thelion!u@h PRIVMSG #team :\u0002bob\u0002: \u000304look\u0003 here");
        eq("formatting", fmt.title() + " | " + fmt.body() + " | " + PushLine.tag("s1", fmt.conversation), "thelion in #team | bob: look here | s1:#team");
        StringBuilder longText = new StringBuilder();
        for (int i = 0; i < 300; i++) longText.append('x');
        eq("clamp", PushLine.clean(longText.toString(), 180).length(), 180);

        // filter.test.ts
        PushLine mention = PushLine.parse(":alice!u@h PRIVMSG #team :bob: hey");
        PushFilter d = new PushFilter();
        eq("default dm", d.shows(dm, "s1"), true);
        eq("default mention", d.shows(mention, "s1"), true);
        eq("ping hidden", d.shows(PushLine.parse("PING webpush"), "s1"), false);
        PushFilter off = new PushFilter(); off.enabled = false;
        eq("disabled", off.shows(dm, "s1"), false);
        PushFilter noDm = new PushFilter(); noDm.directMessages = false;
        eq("no dms", noDm.shows(dm, "s1"), false);
        PushFilter noMention = new PushFilter(); noMention.mentions = false;
        eq("no mentions", noMention.shows(mention, "s1"), false);
        PushFilter muted = new PushFilter(); muted.levels.put("s1\0#team", "nothing");
        eq("muted channel", muted.shows(mention, "s1"), false);
        eq("muted elsewhere", muted.shows(mention, "s2"), true);
        PushFilter quietDms = new PushFilter(); quietDms.servers.put("s1", map("dms", "nothing"));
        eq("server dms nothing", quietDms.shows(dm, "s1"), false);
        PushFilter quietCh = new PushFilter(); quietCh.servers.put("s1", map("channels", "nothing"));
        eq("server channels nothing", quietCh.shows(mention, "s1"), false);
        quietDms.levels.put("s1\0alice", "all");
        eq("own level wins", quietDms.shows(dm, "s1"), true);

        System.out.println(checks + " checks, " + failures + " failed");
        if (failures > 0) System.exit(1);
    }

    private static Map<String, String> map(String k, String v) {
        Map<String, String> m = new HashMap<>();
        m.put(k, v);
        return m;
    }
}
