package com.wails.app;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What a push carries, as client/src/renderer/src/modules/push/payload.ts
 * reads it (keep them in step): the IRC line — a PRIVMSG/NOTICE that was a
 * DM or a highlight, MARKREAD, or the subscription test "PING webpush".
 * Plain Java (tested on the desktop JDK).
 */
public final class PushLine {
    public enum Type { PING, READ, MESSAGE, OTHER }

    public Type type = Type.OTHER;
    /** MESSAGE: "dm" or "mention". */
    public String kind = "";
    public String nick = "";
    /** The channel, or the sender's nick for a DM: the buffer it opens. */
    public String conversation = "";
    public String text = "";
    public boolean action;
    public boolean notice;
    public String msgid = "";
    public String time = "";
    /** READ: the conversation read, and up to when ("" unknown). */
    public String target = "";

    static final class Parsed {
        Map<String, String> tags = new HashMap<>();
        String source = "";
        String command = "";
        List<String> params = new ArrayList<>();
    }

    private static String unescapeTag(String v) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (c != '\\') { b.append(c); continue; }
            if (++i >= v.length()) break;
            char e = v.charAt(i);
            switch (e) {
                case ':': b.append(';'); break;
                case 's': b.append(' '); break;
                case '\\': b.append('\\'); break;
                case 'r': b.append('\r'); break;
                case 'n': b.append('\n'); break;
                default: b.append(e);
            }
        }
        return b.toString();
    }

    private static String ltrim(String s) {
        int i = 0;
        while (i < s.length() && s.charAt(i) == ' ') i++;
        return s.substring(i);
    }

    static Parsed parseLine(String raw) {
        String s = raw.replaceAll("[\r\n]+$", "");
        Parsed p = new Parsed();
        if (s.startsWith("@")) {
            int sp = s.indexOf(' ');
            if (sp < 0) return null;
            for (String t : s.substring(1, sp).split(";")) {
                if (t.isEmpty()) continue;
                int eq = t.indexOf('=');
                if (eq < 0) p.tags.put(t, "");
                else p.tags.put(t.substring(0, eq), unescapeTag(t.substring(eq + 1)));
            }
            s = ltrim(s.substring(sp + 1));
        }
        if (s.startsWith(":")) {
            int sp = s.indexOf(' ');
            if (sp < 0) return null;
            p.source = s.substring(1, sp);
            s = ltrim(s.substring(sp + 1));
        }
        while (!s.isEmpty()) {
            if (!p.command.isEmpty() && s.startsWith(":")) { p.params.add(s.substring(1)); break; }
            int sp = s.indexOf(' ');
            String word = sp < 0 ? s : s.substring(0, sp);
            if (p.command.isEmpty()) p.command = word.toUpperCase(java.util.Locale.ROOT);
            else p.params.add(word);
            if (sp < 0) break;
            s = ltrim(s.substring(sp + 1));
        }
        return p.command.isEmpty() ? null : p;
    }

    private static final Pattern ACTION = Pattern.compile("^\u0001ACTION ?([^\u0001]*)\u0001?$");

    public static PushLine parse(String raw) {
        PushLine m = new PushLine();
        Parsed l = parseLine(raw);
        if (l == null) return m;
        if (l.command.equals("PING")) { m.type = Type.PING; return m; }
        if (l.command.equals("MARKREAD")) {
            String target = l.params.size() > 0 ? l.params.get(0) : "";
            if (target.isEmpty()) return m;
            String ts = l.params.size() > 1 ? l.params.get(1).replaceFirst("^timestamp=", "") : "";
            m.type = Type.READ;
            m.target = target;
            m.time = ts.equals("*") ? "" : ts;
            return m;
        }
        if (!l.command.equals("PRIVMSG") && !l.command.equals("NOTICE")) return m;
        String target = l.params.size() > 0 ? l.params.get(0) : "";
        String text = l.params.size() > 1 ? l.params.get(1) : "";
        int bang = l.source.indexOf('!');
        if (target.isEmpty() || bang <= 0) return m;
        String nick = l.source.substring(0, bang);
        boolean action = false;
        if (text.startsWith("\u0001")) {
            Matcher a = ACTION.matcher(text);
            if (!a.matches()) return m;
            action = true;
            text = a.group(1);
        }
        boolean channel = !target.isEmpty() && "#&!+".indexOf(target.charAt(0)) >= 0;
        m.type = Type.MESSAGE;
        m.kind = channel ? "mention" : "dm";
        m.nick = nick;
        m.conversation = channel ? target : nick;
        m.text = text;
        m.action = action;
        m.notice = l.command.equals("NOTICE");
        m.msgid = l.tags.getOrDefault("msgid", "");
        m.time = l.tags.getOrDefault("time", "");
        return m;
    }

    /** IRC formatting and control characters out, whitespace collapsed, clamped. */
    public static String clean(String s, int max) {
        String t = s
                .replaceAll("\u0003(\\d{1,2}(,\\d{1,2})?)?", "")
                .replaceAll("\u0004([0-9a-fA-F]{6}(,[0-9a-fA-F]{6})?)?", "")
                .replaceAll("[\u0002\u000f\u0011\u0016\u001d\u001e\u001f]", "")
                .replaceAll("[\u0000-\u001f\u007f]", " ")
                .replaceAll("\\s+", " ")
                .trim();
        return t.length() > max ? t.substring(0, max - 1) + "…" : t;
    }

    /** "<nick> in #channel", or "<nick>" for a DM. */
    public String title() {
        return kind.equals("dm") ? nick : nick + " in " + conversation;
    }

    public String body() {
        return action ? clean("* " + nick + " " + text, 180) : clean(text, 180);
    }

    /** Collapses repeats per conversation (the renderer's tag too). */
    public static String tag(String serverId, String conversation) {
        return serverId + ":" + conversation.toLowerCase(java.util.Locale.ROOT);
    }
}
