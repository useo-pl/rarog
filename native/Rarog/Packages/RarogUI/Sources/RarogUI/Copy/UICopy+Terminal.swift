import Foundation
import RarogContract
import RarogCore

// Ekran terminala apki: nagłówek, zdania stanów połączenia, pasek klawiszy,
// wyniki Kopiuj/Wklej. Treści terminala tu nie ma: zdania mówią o stanie, nigdy nie cytują ekranu.
extension UICopy {
  // MARK: Nagłówek

  public static var terminalTitle: String { L("terminal.title") }
  public static var terminalMoreSpoken: String { L("terminal.moreSpoken") }
  public static var terminalClose: String { L("terminal.close") }
  /// „×" uzbrojone: drugie naciśnięcie zabija powłokę na maszynie serwera.
  public static var terminalCloseConfirm: String { L("terminal.closeConfirm") }
  public static func terminalCloseConfirmSpoken(_ machine: ServerMachine) -> String {
    machine == .mac ? L("terminal.closeConfirmSpoken") : L("terminal.closeConfirmSpoken.vps")
  }
  /// `DELETE` bez odpowiedzi (sieć, limit czasu): powłoka mogła się zakończyć, a łączenie (`POST`) założyłoby
  /// wtedy nową — ekran czeka na gest.
  public static var terminalCloseUnknown: String { L("terminal.closeUnknown") }
  /// Ekran bez fabryki powierzchni albo bez zalogowania — nie ma czego pokazać.
  public static var terminalUnavailable: String { L("terminal.unavailable") }

  // MARK: Zakładki i zakładanie

  /// Etykieta zakładki bez znanego procesu (zaproszenie, terminal przed pierwszą listą).
  public static var terminalTabFallback: String { L("terminal.tabFallback") }
  public static var terminalInviteSpoken: String { L("terminal.inviteSpoken") }
  public static var terminalOff: String { L("terminal.off") }
  public static var terminalSlotsFull: String {
    L("terminal.slotsFull", TerminalSlot.max)
  }
  public static var newTerminal: String { L("terminal.newTerminal") }
  public static var newTabMenu: String { L("terminal.newTabMenu") }

  /// Etykieta zakładki terminala: proces na pierwszym planie (`nvim`, `lazygit`), jedno słowo do 12 znaków;
  /// pusty (serwer jeszcze nie wie) — „terminal".
  public static func terminalTabLabel(_ entry: TerminalListEntry) -> String {
    let word = entry.proc.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
    return word.isEmpty ? terminalTabFallback : String(word.prefix(12))
  }

  /// The name of a terminal by its slot, "Terminal 2" (also the quiet line of a terminal row in the session switcher).
  public static func terminalSlotName(_ slot: Int) -> String { L("terminal.tabSpoken.slot", slot) }
  /// "running": the terminal's stream is attached.
  public static var terminalRunning: String { L("terminal.tabSpoken.live") }

  /// Zdanie czytnika zakładki terminala: numer slotu, gdy znany, proces, „działa".
  public static func terminalTabSpoken(_ entry: TerminalListEntry?, current: Bool) -> String {
    guard let entry else { return current ? L("terminal.tabSpoken.invite") : terminalInviteSpoken }
    let name: String =
      switch (current, entry.slot > 0) {
      case (true, true): terminalSlotName(entry.slot)
      case (true, false): L("terminal.tabSpoken.invite")
      case (false, true): L("terminal.tabSpoken.goSlot", entry.slot)
      case (false, false): L("terminal.tabSpoken.go")
      }
    var parts = [name]
    if !entry.proc.isEmpty { parts.append(terminalTabLabel(entry)) }
    if entry.live { parts.append(terminalRunning) }
    return list(parts, .comma)
  }

  // MARK: Okna Cmd+F i Cmd+G

  /// Rodzaj okna dla czytnika (element tytułu okna): bez tego słowa nie wiadomo, czy to okno spod Cmd+G, czy spod
  /// Cmd+F.
  public static func terminalPopupKind(_ role: TerminalRole) -> String {
    role == .lazygit ? L("terminal.popupKind.lazygit") : L("terminal.popupKind.shell")
  }

  /// „×" okna tylko odpina (powłoka żyje dalej); „×” na trasie terminala zabija powłokę, więc ten nazywa OKNO.
  public static func terminalPopupClose(_ role: TerminalRole) -> String {
    role == .lazygit ? L("terminal.popupClose.lazygit") : L("terminal.popupClose.shell")
  }

  public static var shortcutPopupShell: String { L("terminal.shortcutPopupShell") }
  public static var shortcutPopupLazygit: String { L("terminal.shortcutPopupLazygit") }
  /// Terminal glyph in a project header of the tree: which project's shell the window opens.
  static func treePopupLabel(_ project: String) -> String { L("terminal.treePopupLabel", project) }

  // MARK: Historia

  public static var terminalHistoryLoading: String { L("terminal.historyLoading") }
  public static var terminalHistoryEmpty: String { L("terminal.historyEmpty") }
  public static var terminalHistoryFailed: String { L("terminal.historyFailed") }
  public static var terminalHistoryGone: String { L("terminal.historyGone") }
  public static var terminalHistoryCopy: String { L("terminal.historyCopy") }
  public static var terminalHistoryCopyDone: String { L("terminal.historyCopyDone") }
  public static var terminalHistoryClose: String { L("terminal.historyClose") }

  /// „Wczytaj więcej (do 5000 linii)" — tylko gdy historia była ucięta poniżej sufitu.
  public static func terminalHistoryMore(_ lines: Int) -> String {
    L("terminal.historyMore", lines)
  }

  /// Stopka historii: ile wierszy widać i czy coś zostało za sufitem `limit`.
  public static func terminalHistoryFoot(text: String, truncated: Bool, limit: Int) -> String {
    let body = text.hasSuffix("\n") ? String(text.dropLast()) : text
    let lines = text.isEmpty ? 0 : body.split(separator: "\n", omittingEmptySubsequences: false).count
    return truncated ? L("terminal.historyFoot.truncated", lines, limit) : L("terminal.historyFoot", lines)
  }

  // MARK: Stany połączenia

  public static var terminalConnecting: String { L("terminal.connecting") }
  public static var terminalReconnecting: String { L("terminal.reconnecting") }
  public static var terminalExited: String { L("terminal.exited") }
  public static var terminalMissing: String { L("terminal.missing") }
  /// `err` bez zdania serwera.
  public static var terminalFailed: String { L("terminal.failed") }
  /// Nowy terminal (`next`): żądanie mogło dojść, a odpowiedź nie wróciła.
  public static var terminalNewUnconfirmed: String { L("terminal.newUnconfirmed") }
  public static var terminalRestart: String { L("terminal.restart") }
  public static var terminalRetry: String { L("terminal.retry") }

  // MARK: Pasek klawiszy

  public static var terminalKeyBar: String { L("terminal.keyBar") }
  public static var terminalScreen: String { L("terminal.screen") }
  public static var terminalKeyEsc: String { L("terminal.keyEsc") }
  public static var terminalKeyTab: String { L("terminal.keyTab") }
  public static var terminalKeyCtrl: String { L("terminal.keyCtrl") }
  public static var terminalKeyCtrlHint: String { L("terminal.keyCtrlHint") }
  public static var terminalKeyCmd: String { L("terminal.keyCmd") }
  public static var terminalKeyCmdHint: String { L("terminal.keyCmdHint") }
  public static var terminalKeyArmed: String { L("terminal.keyArmed") }
  public static var terminalKeyPad: String { L("terminal.keyPad") }
  public static var terminalKeyPadHint: String { L("terminal.keyPadHint") }
  public static var terminalArrowUp: String { L("terminal.arrowUp") }
  public static var terminalArrowDown: String { L("terminal.arrowDown") }
  public static var terminalArrowLeft: String { L("terminal.arrowLeft") }
  public static var terminalArrowRight: String { L("terminal.arrowRight") }
  public static var terminalCopy: String { L("terminal.copy") }
  public static var terminalCopyHint: String { L("terminal.copyHint") }
  public static var terminalPaste: String { L("terminal.paste") }
  public static var terminalPasteHint: String { L("terminal.pasteHint") }
  public static var terminalHistory: String { L("terminal.history") }
  public static var terminalHistoryHint: String { L("terminal.historyHint") }
  public static var terminalCtrlOn: String { L("terminal.ctrlOn") }
  public static var terminalCmdOn: String { L("terminal.cmdOn") }

  // MARK: Linki

  public static var terminalLinkOpen: String { L("terminal.linkOpen") }
  public static var terminalLinkCopy: String { L("terminal.linkCopy") }

  // MARK: Kopiuj i Wklej

  public static var terminalCopyDone: String { L("terminal.copyDone") }
  public static var terminalCopyEmpty: String { L("terminal.copyEmpty") }
  public static var terminalPasteEmpty: String { L("terminal.pasteEmpty") }
  public static var terminalPasteOffline: String { L("terminal.pasteOffline") }
  /// Sufit sprawdza klient (serwer odrzuca nadmiar bez słowa): nie poleciał ani jeden bajt.
  public static var terminalPasteTooBig: String {
    L("terminal.pasteTooBig", TerminalWire.maxPasteBytes / 1024)
  }

  /// Zdanie po wklejce; `nil` = wklejka w drodze (ekran mówi sam za siebie).
  public static func terminalPasteOutcome(_ outcome: TerminalInputOutcome) -> String? {
    switch outcome {
    case .queued: nil
    case .empty: terminalPasteEmpty
    case .notConnected: terminalPasteOffline
    case .tooLarge: terminalPasteTooBig
    }
  }
}
