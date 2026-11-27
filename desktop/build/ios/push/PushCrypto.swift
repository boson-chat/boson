// RFC 8291 (Message Encryption for Web Push) with RFC 8188 aes128gcm, the
// receiving side: what the Boson server (Ergo) encrypts to this device's
// key, decrypted in the Notification Service Extension. The key pair and
// auth secret are the device's for one server (desktop/push.go keeps them in
// the keychain shared through the App Group).
import CryptoKit
import Foundation

enum PushCryptoError: Error {
    case short, badKey, badRecordSize, decrypt, padding
}

struct PushKeys {
    let privateKey: P256.KeyAgreement.PrivateKey
    let auth: Data

    init(privateRaw: Data, auth: Data) throws {
        guard let k = try? P256.KeyAgreement.PrivateKey(rawRepresentation: privateRaw), auth.count == 16 else {
            throw PushCryptoError.badKey
        }
        privateKey = k
        self.auth = auth
    }

    var publicRaw: Data { privateKey.publicKey.x963Representation }
}

enum PushCrypto {
    static func hkdf(salt: Data, ikm: Data, info: Data, count: Int) -> Data {
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: info, outputByteCount: count)
        return key.withUnsafeBytes { Data($0) }
    }

    /// The plaintext of an aes128gcm Web Push body.
    static func decrypt(_ body: Data, keys: PushKeys) throws -> Data {
        let b = [UInt8](body)
        // header: salt(16) | rs(4) | idlen(1) | keyid(idlen)
        guard b.count >= 21 else { throw PushCryptoError.short }
        let salt = Data(b[0..<16])
        let rs = Int(b[16]) << 24 | Int(b[17]) << 16 | Int(b[18]) << 8 | Int(b[19])
        let idlen = Int(b[20])
        guard rs >= 18, b.count >= 21 + idlen else { throw PushCryptoError.badRecordSize }
        // The keyid is the server's ephemeral public key (65 bytes).
        let serverPub = Data(b[21..<(21 + idlen)])
        guard let asPub = try? P256.KeyAgreement.PublicKey(x963Representation: serverPub) else {
            throw PushCryptoError.badKey
        }
        let shared = try keys.privateKey.sharedSecretFromKeyAgreement(with: asPub)
        let ecdh = shared.withUnsafeBytes { Data($0) }
        var keyInfo = Data("WebPush: info".utf8)
        keyInfo.append(0)
        keyInfo.append(keys.publicRaw)
        keyInfo.append(serverPub)
        let ikm = hkdf(salt: keys.auth, ikm: ecdh, info: keyInfo, count: 32)
        let cek = hkdf(salt: salt, ikm: ikm, info: Data("Content-Encoding: aes128gcm\u{0}".utf8), count: 16)
        let baseNonce = [UInt8](hkdf(salt: salt, ikm: ikm, info: Data("Content-Encoding: nonce\u{0}".utf8), count: 12))
        let key = SymmetricKey(data: cek)

        var out = Data()
        var offset = 21 + idlen
        var seq: UInt64 = 0
        while offset < b.count {
            let end = min(offset + rs, b.count)
            let record = Data(b[offset..<end])
            guard record.count > 16 else { throw PushCryptoError.short }
            var nonce = baseNonce
            for i in 0..<8 { nonce[11 - i] ^= UInt8((seq >> (8 * UInt64(i))) & 0xff) }
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: nonce),
                ciphertext: record.prefix(record.count - 16),
                tag: record.suffix(16))
            guard let plain = try? AES.GCM.open(box, using: key) else { throw PushCryptoError.decrypt }
            // Padding: the content, a delimiter (2 for the last record, 1
            // otherwise), then zeros.
            let p = [UInt8](plain)
            guard let d = p.lastIndex(where: { $0 != 0 }) else { throw PushCryptoError.padding }
            let last = end == b.count
            guard p[d] == (last ? 2 : 1) else { throw PushCryptoError.padding }
            out.append(contentsOf: p[0..<d])
            offset = end
            seq += 1
            if last { break }
        }
        return out
    }
}
