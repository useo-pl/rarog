import Foundation

// Bufory transkryptu dyktowania i odczyt odpowiedzi strumienia Soniox. Czyste,
// testowane na macOS. Właściciel: dyktowanie.

/// Tekst z dyktowania w dwóch warstwach.
///
/// `committed` jest nietykalne: tekst, który człowiek już przeczytał w polu, nie ma prawa zniknąć
/// (zerwana sieć, zejście w tło). `provisional` to bieżąca hipoteza — ZASTĘPOWANA w całości przy
/// każdej wiadomości, nigdy doklejana.
public struct VoiceBuffers: Sendable, Equatable {
  public var committed: String
  public var provisional: String

  public init(committed: String = "", provisional: String = "") {
    self.committed = committed
    self.provisional = provisional
  }

  public static let empty = VoiceBuffers()

  /// Całość do pola: to, co pewne, i bieżąca hipoteza.
  public var text: String { committed + provisional }
}

/// Token ze strumienia — tyle, ile czytamy.
struct SonioxToken: Sendable, Equatable {
  let text: String
  let isFinal: Bool
  /// Audio time of the token within one connection (`start_ms`, `end_ms`); a new connection counts from zero.
  var startMs: Int? = nil
  var endMs: Int? = nil
}

/// Jedna wiadomość strumienia w kształcie, w jakim ją czytamy. Wiadomość nieczytelna = `nil`
/// (pomijana): strumień nie pada od jednej złej ramki.
struct SonioxReply: Sendable, Equatable {
  var tokens: [SonioxToken]?
  var finished = false
  /// Ramka błędu: `error_code` (kod HTTP) decyduje, co dalej (`SonioxStream`); treści błędu nie czytamy.
  var errorCode: Int?

  static func parse(_ text: String) -> SonioxReply? {
    guard let data = text.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    var reply = SonioxReply()
    if let code = object["error_code"] as? NSNumber { reply.errorCode = code.intValue }
    if let raw = object["tokens"] as? [Any] {
      reply.tokens = raw.compactMap { item in
        guard let token = item as? [String: Any] else { return nil }
        let text = token["text"] as? String ?? ""
        // `is_final` tylko jako prawdziwy bool: `1` z JSON-u to liczba, nie zatwierdzenie.
        let isFinal = (token["is_final"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue } ?? false
        return SonioxToken(
          text: text, isFinal: isFinal, startMs: (token["start_ms"] as? NSNumber)?.intValue,
          endMs: (token["end_ms"] as? NSNumber)?.intValue)
      }
    }
    if let finished = object["finished"] as? NSNumber, CFGetTypeID(finished) == CFBooleanGetTypeID() {
      reply.finished = finished.boolValue
    }
    return reply
  }
}

/// The moment of an edit during recording, on one connection's audio clock. Soniox later sends the hypothesis
/// the person saw and edited again (confirmed as final, or once more as a hypothesis); without the cut that text
/// would land in the field a second time.
struct SonioxCut: Sendable, Equatable {
  /// Audio time the field already shows (the latest `end_ms` heard before the edit).
  let ms: Int
  /// The hypothesis that stood in the field at the edit: a word that crosses the cut extends it.
  let shown: [SonioxToken]

  /// A token after the cut stays whole. A token before it is the person's text and goes. A token that crosses
  /// the cut keeps only what follows the shown words it starts with (`do` shown, `doing` heard → `ing`); a rewrite
  /// of shown words cannot be merged and goes, so the field keeps the version the person saw. A token without a
  /// start time stays: without timestamps old words cannot be told from new ones.
  func trim(_ token: SonioxToken) -> SonioxToken? {
    guard let start = token.startMs, start < ms else { return token }
    guard let end = token.endMs, end > ms else { return nil }
    let prefix = shown.filter { ($0.startMs ?? -1) >= start && ($0.startMs ?? .max) < ms }.map(\.text).joined()
    guard !prefix.isEmpty, token.text.count > prefix.count, token.text.hasPrefix(prefix) else { return nil }
    return SonioxToken(text: String(token.text.dropFirst(prefix.count)), isFinal: token.isFinal, startMs: ms, endMs: end)
  }
}

enum SonioxText {
  /// Znacznik końca wypowiedzi z detekcji granicy zdania — NIGDY nie trafia do pola. Przychodzi tylko przy
  /// włączonej detekcji (dziś wyłączona, `SonioxConfigFrame`); obsługa zostaje, żeby powrót był jedną linią.
  static let endToken = "<end>"
  /// Znacznik ręcznej finalizacji: metadana protokołu, nie tekst (trafiała do pola).
  static let finToken = "<fin>"

  /// Doklejenie tokenu do `committed`. Tokenów NIE sklejamy własną logiką słów: jednostki
  /// subwordowe Soniox niosą wiodącą spację, więc konkatenacja jest już poprawnym tekstem.
  /// Wyjątek: `<end>` domyka akapit i zjada wiodącą spację następnego tokenu.
  static func append(_ committed: String, _ text: String) -> String {
    if text == endToken {
      let trimmed = committed.trimmingSuffix { $0 == " " || $0 == "\t" }
      if trimmed.isEmpty || trimmed.hasSuffix("\n") { return trimmed }
      return trimmed + "\n"
    }
    if committed.hasSuffix("\n") { return committed + text.trimmingPrefix { $0 == " " || $0 == "\t" } }
    return committed + text
  }

  /// Bufory po jednej wiadomości. Wiadomość BEZ tokenów (`keepalive`, `finished`) zostawia je
  /// nietknięte — inaczej każda taka ramka gasiłaby hipotezę i pole migotałoby bez powodu.
  ///
  /// `cut`: an edit during recording (`rebase`) made the shown text the person's own (``SonioxCut``).
  static func apply(_ buffers: VoiceBuffers, _ tokens: [SonioxToken], cut: SonioxCut? = nil) -> VoiceBuffers {
    guard !tokens.isEmpty else { return buffers }
    var committed = buffers.committed
    var provisional = ""
    let kept = cut.map { cut in tokens.compactMap { cut.trim($0) } } ?? tokens
    for token in kept where !token.text.isEmpty && token.text != finToken {
      if token.isFinal {
        committed = append(committed, token.text)
      } else if token.text != endToken {
        provisional += token.text
      }
    }
    return VoiceBuffers(committed: committed, provisional: provisional)
  }

  /// The latest audio time the tokens reach (`end_ms`), or `nil` when none carries one.
  static func heardUntil(_ tokens: [SonioxToken]) -> Int? {
    tokens.compactMap(\.endMs).max()
  }

  /// Zerwany strumień: hipoteza staje się tekstem, bo człowiek już ją przeczytał w polu.
  static func fold(_ buffers: VoiceBuffers) -> VoiceBuffers {
    guard !buffers.provisional.isEmpty else { return buffers }
    return VoiceBuffers(committed: append(buffers.committed, buffers.provisional), provisional: "")
  }
}

extension String {
  fileprivate func trimmingSuffix(while predicate: (Character) -> Bool) -> String {
    var end = endIndex
    while end > startIndex, predicate(self[index(before: end)]) { end = index(before: end) }
    return String(self[..<end])
  }
}
