// Cechy klawiatury pola wiadomości zależne od tekstu (komendy „/”). Reguła bez UIKit — testowana na macOS
// (`RarogUILogicTests`); przełożenie na cechy `UITextView` jest pod `#if os(iOS)`. Właściciel: pole.
import RarogCore
#if os(iOS)
import UIKit
#endif

/// Cechy klawiatury pola wiadomości dla tekstu, który w nim stoi. Komenda Claude Code — tekst zaczyna się, po
/// wiodących białych znakach, od `/` (jak `trimStart` w `classifySlashText` serwera) — idzie bez autokorekty,
/// wielkiej litery, sprawdzania pisowni i inteligentnych myślników, cudzysłowów i wstawiania: iOS zamienia
/// `--force` na `—force`, a proste cudzysłowy na drukarskie, co psuje argumenty komendy.
/// Każdy inny tekst, także pusty, ma domyślne cechy pola.
public struct ComposerTextTraits: Equatable, Sendable {
  /// Autokorekta (`autocorrectionType`).
  public let autocorrects: Bool
  /// Wielka litera na początku zdania (`autocapitalizationType`).
  public let capitalizesSentences: Bool
  /// Sprawdzanie pisowni (`spellCheckingType`).
  public let checksSpelling: Bool
  /// `--` → `—` (`smartDashesType`).
  public let smartDashes: Bool
  /// Proste cudzysłowy → drukarskie (`smartQuotesType`).
  public let smartQuotes: Bool
  /// Dokładanie i zdejmowanie spacji przy wklejaniu i usuwaniu słów (`smartInsertDeleteType`).
  public let smartInsertDelete: Bool

  /// Zwykła wiadomość: dzisiejsze cechy pola.
  public static let message = ComposerTextTraits(enabled: true)
  /// Komenda: wszystko, co przerabia wpisany tekst, wyłączone.
  public static let command = ComposerTextTraits(enabled: false)

  public init(text: String) {
    self = Self.isCommand(text) ? .command : .message
  }

  private init(enabled: Bool) {
    autocorrects = enabled
    capitalizesSentences = enabled
    checksSpelling = enabled
    smartDashes = enabled
    smartQuotes = enabled
    smartInsertDelete = enabled
  }

  /// Pierwszy znak po wiodących białych znakach to `/` — reguła rdzenia (``SlashCommandText``, białe znaki jak
  /// `trimStart` serwera), wspólna z podpowiedziami po „/” i odświeżeniem listy komend po odmowie wysyłki.
  static func isCommand(_ text: String) -> Bool {
    SlashCommandText.isCommand(text)
  }
}

#if os(iOS)
extension ComposerTextTraits {
  /// Zapis cech w polu. Klawiatura już wysunięta bierze je dopiero po `reloadInputViews()` — o tym rozstrzyga
  /// właściciel pola (`ComposerView.applyTextTraits`).
  func apply(to field: UITextView) {
    field.autocorrectionType = autocorrects ? .default : .no
    field.autocapitalizationType = capitalizesSentences ? .sentences : .none
    field.spellCheckingType = checksSpelling ? .default : .no
    field.smartDashesType = smartDashes ? .default : .no
    field.smartQuotesType = smartQuotes ? .default : .no
    field.smartInsertDeleteType = smartInsertDelete ? .default : .no
  }
}
#endif
