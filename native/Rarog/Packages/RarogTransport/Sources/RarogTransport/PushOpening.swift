import Foundation
import RarogContract
import Synchronization

// Otwarcie banera v3 z `userInfo` — JEDEN kod dla rozszerzenia powiadomień (NSE) i apki (`PushRouting`
// w RarogCore). Czyste funkcje: wejście `userInfo`, klucz przez ``PushKeyReader``, czas; wyjście tekst jawny albo
// powód odmowy, który nigdy nie niesie treści. NSE dokłada świeżość (`exp + 300 s`) i składa decyzję
// (``PushServiceDecision``); klasa w celu Xcode tylko ją wykonuje, a ``OnceHandler`` pilnuje, że handler systemu
// pada dokładnie raz (zwykły koniec albo `serviceExtensionTimeWillExpire`).

/// Dlaczego banera v3 nie da się otworzyć. NSE zostawia wtedy oryginał (tekst zastępczy), apka — powiadomienie bez
/// celu. Nigdy nie niesie treści.
public enum PushRefusal: Error, Sendable, Equatable {
  /// Brak bloku `rarog` albo `v ≠ 3` (v1, koperta formatu 2 pod tym kluczem, cudzy push).
  case notV3
  /// Koperta spoza reguł odbiorcy (`kid`, `n`, `c`).
  case envelopeInvalid
  /// Brak klucza dla `kid` (zły `kid`, klucz skasowany, inne urządzenie).
  case keyMissing
  /// `errSecInteractionNotAllowed`: telefon przed pierwszym odblokowaniem po restarcie.
  case keychainLocked
  /// Inny błąd Keychaina (`OSStatus`).
  case keychainFailed(Int32)
  /// Wartość wpisu to nie 32 bajty base64url.
  case keyInvalid
  /// AEAD: zły klucz, `kid` w AAD, zmieniony bit nonce, szyfrogramu albo tagu.
  case authenticationFailed
  /// Odszyfrowany tekst to nie tekst jawny banera v3 (walidacja).
  case plaintextInvalid
  /// NSE: `teraz > exp + 300 s` — stary szyfrogram (powtórzenie) zostaje tekstem zastępczym.
  case expired
  /// NSE: tekst jawny bez tytułu i treści (sama plakietka) — nie ma czego podstawić.
  case withoutAlert
}

public enum PushOpening {
  /// Blok `rarog` v3 z `userInfo` → tekst jawny. Bez sprawdzania `exp`: apka przy tapnięciu otwiera także stare
  /// powiadomienie z Centrum powiadomień.
  public static func open(userInfo: [AnyHashable: Any], keys: any PushKeyReader) -> Result<PushPlaintext, PushRefusal> {
    guard let block = userInfo["rarog"] as? [String: Any], JSONSerialization.isValidJSONObject(block),
      let data = try? JSONSerialization.data(withJSONObject: block),
      let version = try? JSONDecoder().decode(Version.self, from: data), version.v == PushEnvelope.version
    else { return .failure(.notV3) }
    guard let envelope = try? JSONDecoder().decode(PushEnvelope.self, from: data) else {
      return .failure(.envelopeInvalid)
    }
    let value: Data
    switch keys.pushKey(kid: envelope.kid) {
    case let .found(found): value = found
    case .none: return .failure(.keyMissing)
    case .locked: return .failure(.keychainLocked)
    case let .failed(status): return .failure(.keychainFailed(status))
    }
    do throws(PushCrypto.Failure) {
      let key = try PushCrypto.pushKey(keychainValue: value)
      return .success(try PushCrypto.openPlaintext(envelope, pushKey: key))
    } catch {
      switch error {
      case .keyInvalid: return .failure(.keyInvalid)
      case .authenticationFailed: return .failure(.authenticationFailed)
      case .plaintextInvalid: return .failure(.plaintextInvalid)
      }
    }
  }

  /// Sama wersja bloku `rarog` — reszta kształtu zależy od niej.
  private struct Version: Decodable {
    let v: Int
  }
}

/// Decyzja rozszerzenia powiadomień dla jednego pushu: podstawić tytuł, treść i `rarogOpen` albo zostawić oryginał.
public enum PushServiceDecision: Sendable, Equatable {
  /// Tytuł i treść z tekstu jawnego; `open` idzie do `userInfo` (``PushOpen/adding(to:)``) obok bloku `rarog` v3,
  /// `threadIdentifier` zostaje nietknięty.
  case replace(title: String, body: String, open: PushOpen)
  /// Oryginał (tekst zastępczy z `aps.alert`) — z powodem.
  case keep(PushRefusal)

  /// Ile po `exp` (`apns-expiration` wysyłki) szyfrogram jest jeszcze świeży.
  public static let freshness: TimeInterval = 300

  /// `renderer` tłumaczy tytuł i treść z kodem zdania (`titleRef`, `bodyRef`) na język apki; tekst bez kodu
  /// zostaje tekstem serwera. Domyślnie język procesu (NSE podaje go jawnie).
  public static func decide(
    userInfo: [AnyHashable: Any], keys: any PushKeyReader, now: Date,
    renderer: SentenceRenderer = ServerText.renderer(language: .current)
  ) -> PushServiceDecision {
    var plaintext: PushPlaintext
    switch PushOpening.open(userInfo: userInfo, keys: keys) {
    case let .success(opened): plaintext = opened
    case let .failure(refusal): return .keep(refusal)
    }
    plaintext.translate(renderer)
    guard now.timeIntervalSince1970 <= TimeInterval(plaintext.exp) + freshness else { return .keep(.expired) }
    guard let title = plaintext.title, let body = plaintext.body else { return .keep(.withoutAlert) }
    return .replace(title: title, body: body, open: PushOpen(plaintext))
  }
}

/// Handler wołany DOKŁADNIE raz, z którejkolwiek strony przyjdzie pierwszy wynik (NSE: zwykły koniec albo
/// `serviceExtensionTimeWillExpire`, każdy na swoim wątku). Następne wywołania nic nie robią.
public final class OnceHandler<Value>: @unchecked Sendable {
  private let handler: (Value) -> Void
  private let fired = Atomic<Bool>(false)

  public init(_ handler: @escaping (Value) -> Void) {
    self.handler = handler
  }

  /// `true` = to wywołanie oddało wartość systemowi.
  @discardableResult
  public func callAsFunction(_ value: Value) -> Bool {
    guard fired.compareExchange(expected: false, desired: true, ordering: .acquiringAndReleasing).exchanged else {
      return false
    }
    handler(value)
    return true
  }
}
