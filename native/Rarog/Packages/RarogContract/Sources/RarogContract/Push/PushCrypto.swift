import CryptoKit
import Foundation

// Otwieranie koperty banera formatu 3 — CryptoKit, bez UIKit i bez Keychaina: klucz
// podaje wołający (NSE przez `PushKeyReader`, apka z własnego wpisu). Parametry są ZAMROŻONE, druga strona
// to `server/src/notify/push-crypto.ts` (`pushProtocol(3)`); zgodność pilnują wektory
// `shared/fixtures/push-crypto/vectors.v3.json`. Formatu 2 apka nie otwiera (inne `info` i AAD):
//
// - klucz banera = HKDF-SHA256: IKM = 32 SUROWE bajty klucza push (base64url → bajty), sól PUSTA podana jawnie
//   (`Data()`), info `rarog-push-banner-v1`, wyjście 32 B;
// - ChaCha20-Poly1305 (`ChaChaPoly.SealedBox(combined: n‖c)`), AAD = UTF-8 `rarog-push/3|<kid>`;
// - tekst jawny = JSON dopełniony spacjami do wielokrotności 256 B.
//
// Tylko otwieranie — szyfruje wyłącznie serwer.

/// Szyfr koperty banera formatu 3.
public enum PushCrypto {
  /// `info` HKDF klucza banera (`PUSH_KEY_INFO_V3`).
  public static let keyInfo = "rarog-push-banner-v1"
  /// Przedrostek AAD (`PUSH_AAD_PREFIX_V3`); całość = przedrostek + `kid`.
  public static let aadPrefix = "rarog-push/3|"
  /// Długość klucza push z parowania i klucza banera (bajty).
  public static let keyBytes = 32
  public static let nonceBytes = 12
  public static let tagBytes = 16
  /// Kubełek długości tekstu jawnego (dopełnienie spacjami).
  public static let plaintextBucketBytes = 256
  /// Sufit tekstu jawnego, do którego serwer go przycina.
  public static let plaintextMaxBytes = 2048
  /// Najdłuższy tekst jawny, jaki apka w ogóle dekoduje: cały ładunek APNs ma 4096 B.
  static let plaintextHardLimit = 4096

  /// Dlaczego koperty nie da się otworzyć. Nigdy nie niesie treści.
  public enum Failure: Error, Sendable, Equatable {
    /// Wartość wpisu Keychaina to nie 32 bajty base64url.
    case keyInvalid
    /// Zły klucz, `kid` w AAD, zmieniony bit nonce, szyfrogramu albo tagu.
    case authenticationFailed
    /// Odszyfrowany tekst to nie tekst jawny banera.
    case plaintextInvalid
  }

  /// Wartość wpisu Keychaina klucza push (TEKST base64url w UTF-8, `DeviceKeychain`) → klucz push.
  public static func pushKey(keychainValue: Data) throws(Failure) -> SymmetricKey {
    guard let text = String(data: keychainValue, encoding: .utf8) else { throw .keyInvalid }
    return try pushKey(base64URL: text)
  }

  /// Klucz push z tekstu base64url (`pushKey` z parowania) — dokładnie 32 bajty.
  public static func pushKey(base64URL text: String) throws(Failure) -> SymmetricKey {
    guard let raw = PushWire.base64URL(text), raw.count == keyBytes else { throw .keyInvalid }
    return SymmetricKey(data: raw)
  }

  /// Klucz banera: HKDF-SHA256 z pustą solą i info ``keyInfo``.
  public static func bannerKey(pushKey: SymmetricKey) -> SymmetricKey {
    HKDF<SHA256>.deriveKey(
      inputKeyMaterial: pushKey, salt: Data(), info: Data(keyInfo.utf8), outputByteCount: keyBytes)
  }

  /// AAD koperty: UTF-8 `rarog-push/3|<kid>`.
  public static func aad(kid: String) -> Data {
    Data((aadPrefix + kid).utf8)
  }

  /// Otwarcie koperty: surowe bajty tekstu jawnego (z dopełnieniem).
  public static func open(_ envelope: PushEnvelope, pushKey: SymmetricKey) throws(Failure) -> Data {
    do {
      let box = try ChaChaPoly.SealedBox(combined: envelope.nonce + envelope.sealed)
      return try ChaChaPoly.open(box, using: bannerKey(pushKey: pushKey), authenticating: aad(kid: envelope.kid))
    } catch {
      throw .authenticationFailed
    }
  }

  /// Otwarcie koperty i dekodowanie tekstu jawnego (``PushPlaintext``).
  public static func openPlaintext(_ envelope: PushEnvelope, pushKey: SymmetricKey) throws(Failure) -> PushPlaintext {
    let raw = try open(envelope, pushKey: pushKey)
    guard raw.count <= plaintextHardLimit, let plaintext = try? JSONDecoder().decode(PushPlaintext.self, from: raw)
    else { throw .plaintextInvalid }
    return plaintext
  }
}
