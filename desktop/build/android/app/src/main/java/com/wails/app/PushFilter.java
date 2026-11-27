package com.wails.app;

import java.util.HashMap;
import java.util.Map;

/**
 * Whether a decrypted push is shown: the app's notification settings and
 * the per-server / per-conversation levels, as
 * client/src/renderer/src/modules/push/filter.ts decides (keep them in
 * step). The renderer mirrors its PushPrefs JSON here (BosonPush "prefs");
 * BosonPushService reads it into this. Plain Java.
 */
public final class PushFilter {
    public boolean enabled = true;
    public boolean mentions = true;
    public boolean directMessages = true;
    /** serverId → "channels" / "dms" → level. */
    public Map<String, Map<String, String>> servers = new HashMap<>();
    /** "<serverId>\0<conversation lower-cased>" → level. */
    public Map<String, String> levels = new HashMap<>();

    private String level(String serverId, String conversation, boolean dm) {
        String own = levels.get(serverId + "\0" + conversation.toLowerCase(java.util.Locale.ROOT));
        if (isLevel(own)) return own;
        Map<String, String> sv = servers.get(serverId);
        String l = sv == null ? null : sv.get(dm ? "dms" : "channels");
        if (dm) return "all".equals(l) || "nothing".equals(l) ? l : "all";
        return isLevel(l) ? l : "mentions";
    }

    private static boolean isLevel(String v) {
        return "all".equals(v) || "mentions".equals(v) || "nothing".equals(v);
    }

    public boolean shows(PushLine m, String serverId) {
        if (m.type != PushLine.Type.MESSAGE) return false;
        if (!enabled) return false;
        boolean dm = m.kind.equals("dm");
        if (level(serverId, m.conversation, dm).equals("nothing")) return false;
        return dm ? directMessages : mentions;
    }
}
