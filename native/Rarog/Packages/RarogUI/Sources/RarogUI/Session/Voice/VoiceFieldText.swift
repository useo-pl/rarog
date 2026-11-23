import Foundation

/// Sklejenie dyktowania z polem wiadomości. Czyste, testowane na macOS.
/// Właściciel: dyktowanie.
///
/// `written` to ostatnia wartość, którą wpisało dyktowanie: wszystko inne w polu jest z klawiatury
/// człowieka albo z kodu ekranu i znaczy „przebazuj" (pisanie w trakcie ustawia nowy punkt startu).
struct VoiceFieldText: Equatable {
  /// Pole bez separatora — tyle stoi w polu, dopóki dyktowanie nic nie dało.
  private(set) var plain: String
  /// Tekst, do którego doklejają się bufory.
  private(set) var base: String
  private(set) var written: String
  /// Dopisek w nowej linii (notatka projektu, mikrofon w dymku), zamiast po spacji.
  let newLine: Bool

  init(field: String, newLine: Bool = false) {
    plain = field
    base = newLine ? Self.lineBase(field) : Self.base(field)
    written = field
    self.newLine = newLine
  }

  /// Separator dokładany TYLKO, gdy pole nie kończy się białym znakiem: tokeny niosą własne
  /// wiodące spacje, więc bezwarunkowa spacja dawałaby podwójną, a jej brak sklejałby słowa.
  static func base(_ field: String) -> String {
    guard let last = field.last, !last.isWhitespace else { return field }
    return field + " "
  }

  /// Dopisek od nowej linii: puste pole i pole kończące się końcem linii zostają, reszta dostaje `\n`.
  static func lineBase(_ field: String) -> String {
    guard let last = field.last, !last.isNewline else { return field }
    return field + "\n"
  }

  /// Tekst pola w trakcie dyktowania: baza, to, co pewne, i bieżąca hipoteza. Bez podyktowanego
  /// tekstu pole zostaje nietknięte — odmowa mikrofonu ani cisza nie zostawiają spacji na końcu.
  /// Na początku linii (dopisek od nowej linii) wiodące spacje tokenów odpadają.
  func value(_ buffers: VoiceBuffers) -> String {
    var text = Substring(buffers.text)
    if newLine, base.last?.isNewline ?? true { text = text.drop { $0 == " " } }
    return text.isEmpty ? plain : base + text
  }

  mutating func wrote(_ value: String) {
    written = value
  }

  /// Pole po zdarzeniu edycji. `true` = człowiek pisał: bufory trzeba wyzerować (`rebase`).
  mutating func edited(field: String) -> Bool {
    guard field != written else { return false }
    plain = field
    base = field
    written = field
    return true
  }
}

/// Pole tekstowe widziane przez dyktowanie: `ComposerView` i notatka projektu (`NoteVoiceTarget`) w apce, atrapa
/// w testach.
@MainActor
protocol VoiceTextTarget: AnyObject {
  var text: String { get }
  /// Trwa składanie znaku (IME): zapis zerwałby kompozycję.
  var isComposing: Bool { get }
  /// Wpisuje wartość dyktowania, kursor zostaje tam, gdzie był (``voiceSelection``). Pole zgłasza
  /// to jak każdą zmianę z kodu — ``VoiceFieldBinding`` rozpoznaje własny zapis.
  func writeDictation(_ value: String)
}

/// Sklejenie jednego nagrania z polem. Pole zmienia się trzema drogami: zapisem dyktowania,
/// klawiaturą i kodem ekranu (tekst nieudanej wysyłki wraca na górę pola, szkic, prompt po Esc).
/// Dwie ostatnie znaczą „przebazuj" — bez tego następny token nadpisałby pole wartością sprzed
/// zmiany, a tekst oddany po odmowie wysyłki przepadłby razem z wpisem kolejki.
@MainActor
final class VoiceFieldBinding {
  /// Słabo: pole należy do ekranu, nagranie bez pola nic już nie pisze.
  private weak var target: (any VoiceTextTarget)?
  private var text: VoiceFieldText
  /// Trwa zapis dyktowania — zgłoszenie zmiany z tej chwili to nasz własny tekst.
  private var writing = false

  init(target: any VoiceTextTarget, newLine: Bool = false) {
    self.target = target
    text = VoiceFieldText(field: target.text, newLine: newLine)
  }

  func value(_ buffers: VoiceBuffers) -> String {
    text.value(buffers)
  }

  /// Widok nagrywarki → pole, zapis tylko przy realnej zmianie. W trakcie składania znaku pole
  /// należy do edytora; koniec nagrania (`final`) pisze mimo to — `committed` nie ginie.
  func show(_ buffers: VoiceBuffers, final: Bool) {
    guard let target else { return }
    let next = text.value(buffers)
    guard target.text != next else {
      text.wrote(next)
      return
    }
    guard !target.isComposing || final else { return }
    write(next)
  }

  /// Zapis dyktowania (także hipoteza utrwalona przy przejęciu mikrofonu).
  func write(_ value: String) {
    guard let target else { return }
    if target.text != value {
      writing = true
      target.writeDictation(value)
      writing = false
    }
    text.wrote(value)
  }

  /// Pole się zmieniło — klawiatura albo kod ekranu. `true` = tekst w polu nie jest już nasz:
  /// bufory nagrywarki trzeba wyzerować (`VoiceRecorder.rebase`). Własny zapis to nie zmiana.
  func fieldChanged() -> Bool {
    guard !writing, let target else { return false }
    return text.edited(field: target.text)
  }
}

/// Zaznaczenie po wpisaniu dyktowania: kursor na końcu tylko wtedy, gdy tam był — człowiek, który
/// w trakcie poprawia zdanie wyżej, zostaje tam, gdzie poprawia. Długości w UTF-16 (`NSRange`).
func voiceSelection(old: NSRange, oldLength: Int, newLength: Int) -> NSRange {
  if old.location >= oldLength { return NSRange(location: newLength, length: 0) }
  let location = min(old.location, newLength)
  return NSRange(location: location, length: min(old.length, newLength - location))
}
