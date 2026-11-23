import Foundation
import RarogContract

/// Dopasowanie echa wysyłki. Właściciel: wysyłka.
///
/// Najpierw identyfikator: echo z `clientMessageId` gasi WYŁĄCZNIE wpis o tym identyfikatorze,
/// a wiadomość z obcym identyfikatorem (inne urządzenie) nie gasi niczego. Echo bez identyfikatora
/// (starszy serwer, transkrypt odtworzony z jsonl po restarcie Raroga) idzie po podpisie.
///
/// Podpis = TEKST i LISTA załączników `(nazwa, bajty)`, dokładnie to, czym człowiek rozporządzał,
/// naciskając „Wyślij"; serwer składa echo z tej samej pary i niczego nie przycina. Kolejność
/// wpisów jest mechanizmem odróżniania „ok", „ok": echo gasi NAJSTARSZY pasujący wpis.
/// Klient NIE rozpoznaje wpisów harnessu po tagach: notka harnessu (`notice`) nie jest echem.
public enum EchoMatching {
  /// Podpis wysyłki. Separatory spoza tekstu z klawiatury: para („ab", 1 zdjęcie) i („a", „b1")
  /// nie skleja się w ten sam podpis.
  public static func signature(text: String, attachments: [(name: String, bytes: Int)]) -> String {
    let list = attachments.map { "\($0.name)\u{1}\($0.bytes)" }.joined(separator: "\u{2}")
    return "\(list)\u{0}\(text)"
  }

  public static func signature(of entry: OutboxEntry) -> String {
    signature(text: entry.text, attachments: entry.attachments.map { ($0.name, $0.bytes) })
  }

  /// Podpis echa albo `nil`, gdy wiadomość nie może być echem (rola inna niż `user` albo notka
  /// harnessu — rola efektywna to nie człowiek).
  public static func signature(of message: TranscriptMessage) -> String? {
    guard message.role == .user, message.notice == nil else { return nil }
    var text = ""
    for case let .text(value, _) in message.blocks { text += value }
    let attachments = (message.attachments ?? []).map { ($0.name, $0.bytes) }
    return signature(text: text, attachments: attachments)
  }

  /// Indeks najstarszego wpisu tej sesji, który ta wiadomość gasi; `nil` = żaden.
  static func matchIndex(
    in outbox: [OutboxEntry], sessionId: String, message: TranscriptMessage, serverStartId: String?, skew: Duration
  ) -> Int? {
    guard let wanted = signature(of: message) else { return nil }
    if let raw = message.clientMessageId {
      // Identyfikator rozstrzyga i nie potrzebuje granicy: nadał go ten klient tej wiadomości.
      guard let id = UUID(uuidString: raw) else { return nil }
      return outbox.firstIndex { $0.id == id && $0.sessionId == sessionId && $0.awaitsEcho }
    }
    return outbox.firstIndex { entry in
      guard entry.sessionId == sessionId, entry.awaitsEchoBySignature, signature(of: entry) == wanted else { return false }
      return isNewer(message, than: entry, serverStartId: serverStartId, skew: skew)
    }
  }

  /// Echo musi być NOWSZE niż wszystko, co klient znał w chwili wysyłki — archiwalne „ok"
  /// z historii nie gasi świeżego wpisu, którego serwer nie widział, także po zimnym
  /// starcie i eksmisji transkryptu (granica leży przy wpisie na dysku).
  ///
  /// 1. Ten sam proces serwera co przy wysyłce i znany `maxSeq` → `seq` echa > `maxSeq`.
  /// 2. Inny proces (restart serwera: `seq` od nowa) albo brak `seq` → czas serwera echa >
  ///    `lastAt` (oba czasy z zegara serwera, więc bez zapasu na rozjazd).
  /// 3. Granicy brak (transkrypt nieznany przy wysyłce) → czas echa ≥ czas wysyłki − zapas.
  static func isNewer(_ message: TranscriptMessage, than entry: OutboxEntry, serverStartId: String?, skew: Duration) -> Bool {
    let at = ISOTime.parse(message.at)
    if let boundary = entry.boundary {
      if let maxSeq = boundary.maxSeq, let sent = boundary.serverStartId, sent == serverStartId {
        return message.seq > maxSeq
      }
      if let lastAt = boundary.lastAt.flatMap(ISOTime.parse), let at {
        return at > lastAt
      }
    }
    guard let at else { return true }
    return at >= entry.createdAt.addingTimeInterval(-skew.timeInterval)
  }

  /// Tożsamość wiadomości w obrębie snapshotu: numer + podpis echa.
  static func identity(_ message: TranscriptMessage) -> String {
    "\(message.seq)|\(signature(of: message) ?? "")"
  }
}
