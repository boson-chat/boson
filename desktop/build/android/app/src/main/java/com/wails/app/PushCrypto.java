package com.wails.app;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPrivateKeySpec;
import java.security.spec.ECPublicKeySpec;
import java.util.Arrays;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * RFC 8291 (Web Push message encryption, aes128gcm content coding of RFC
 * 8188) decryption: what the server encrypted to this device's key for one
 * server (docs/push.md §0). Plain Java (no Android APIs), so it's tested on
 * the desktop JDK (src/test/java/com/wails/app/PushCoreTest.java). The iOS
 * Notification Service Extension does the same in Swift.
 */
public final class PushCrypto {
    private PushCrypto() {}

    /** base64 or base64url, padded or not. */
    public static byte[] b64(String s) {
        String t = s.trim().replace('-', '+').replace('_', '/').replaceAll("=+$", "");
        while (t.length() % 4 != 0) t += "=";
        return Base64.getDecoder().decode(t);
    }

    private static ECParameterSpec p256() throws GeneralSecurityException {
        AlgorithmParameters p = AlgorithmParameters.getInstance("EC");
        p.init(new ECGenParameterSpec("secp256r1"));
        return p.getParameterSpec(ECParameterSpec.class);
    }

    private static byte[] hmac(byte[] key, byte[]... parts) throws GeneralSecurityException {
        Mac m = Mac.getInstance("HmacSHA256");
        m.init(new SecretKeySpec(key, "HmacSHA256"));
        for (byte[] p : parts) m.update(p);
        return m.doFinal();
    }

    /** HKDF-SHA256 with an output of at most 32 bytes (one block). */
    private static byte[] hkdf(byte[] salt, byte[] ikm, byte[] info, int len) throws GeneralSecurityException {
        byte[] prk = hmac(salt, ikm);
        return Arrays.copyOf(hmac(prk, info, new byte[]{1}), len);
    }

    private static byte[] concat(byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) n += p.length;
        byte[] out = new byte[n];
        int o = 0;
        for (byte[] p : parts) { System.arraycopy(p, 0, out, o, p.length); o += p.length; }
        return out;
    }

    /**
     * Decrypts an aes128gcm body with the device's key pair (raw P-256
     * scalar, uncompressed public point) and auth secret. Throws when it
     * isn't for this key (the AES-GCM tag doesn't match) or is malformed.
     */
    public static byte[] decrypt(byte[] body, byte[] privateScalar, byte[] publicPoint, byte[] auth) throws GeneralSecurityException {
        if (body.length < 21) throw new GeneralSecurityException("short body");
        byte[] salt = Arrays.copyOfRange(body, 0, 16);
        long rs = ((body[16] & 0xffL) << 24) | ((body[17] & 0xffL) << 16) | ((body[18] & 0xffL) << 8) | (body[19] & 0xffL);
        int idlen = body[20] & 0xff;
        if (rs < 18 || body.length < 21 + idlen || idlen != 65) throw new GeneralSecurityException("bad header");
        byte[] asPublic = Arrays.copyOfRange(body, 21, 21 + idlen);

        ECParameterSpec params = p256();
        KeyFactory kf = KeyFactory.getInstance("EC");
        PrivateKey priv = kf.generatePrivate(new ECPrivateKeySpec(new BigInteger(1, privateScalar), params));
        PublicKey pub = kf.generatePublic(new ECPublicKeySpec(point(asPublic), params));
        KeyAgreement ka = KeyAgreement.getInstance("ECDH");
        ka.init(priv);
        ka.doPhase(pub, true);
        byte[] ecdh = ka.generateSecret();

        byte[] keyInfo = concat("WebPush: info\0".getBytes(StandardCharsets.US_ASCII), publicPoint, asPublic);
        byte[] ikm = hkdf(auth, ecdh, keyInfo, 32);
        byte[] cek = hkdf(salt, ikm, "Content-Encoding: aes128gcm\0".getBytes(StandardCharsets.US_ASCII), 16);
        byte[] nonce = hkdf(salt, ikm, "Content-Encoding: nonce\0".getBytes(StandardCharsets.US_ASCII), 12);

        int off = 21 + idlen;
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        long seq = 0;
        while (off < body.length) {
            int end = (int) Math.min(body.length, off + rs);
            byte[] iv = nonce.clone();
            for (int i = 0; i < 8; i++) iv[11 - i] ^= (byte) (seq >>> (8 * i));
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(cek, "AES"), new GCMParameterSpec(128, iv));
            byte[] rec = c.doFinal(body, off, end - off);
            boolean last = end >= body.length;
            int i = rec.length - 1;
            while (i >= 0 && rec[i] == 0) i--;
            if (i < 0 || rec[i] != (last ? 2 : 1)) throw new GeneralSecurityException("bad padding");
            out.write(rec, 0, i);
            off = end;
            seq++;
        }
        return out.toByteArray();
    }

    private static ECPoint point(byte[] p) throws GeneralSecurityException {
        if (p.length != 65 || p[0] != 4) throw new GeneralSecurityException("not an uncompressed P-256 point");
        return new ECPoint(new BigInteger(1, Arrays.copyOfRange(p, 1, 33)), new BigInteger(1, Arrays.copyOfRange(p, 33, 65)));
    }
}
