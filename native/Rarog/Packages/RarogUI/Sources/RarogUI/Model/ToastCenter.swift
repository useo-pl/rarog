import Foundation
import Observation
import RarogContract
import RarogCore
#if canImport(UIKit)
import UIKit
#endif

// Dymek w apce. Właściciel: łączność. Widoki: `Views/ToastHost` (nakładka u dołu
// prawej kolumny) i `Session/SessionViewController+Toast` (ekran sesji, nad promptem).
//
// Jeden nośnik na dwie rzeczy tej samej wagi: sygnał o INNEJ sesji (słowo rodzaju w kolorze tonu
// i „projekt · sesja", tap otwiera sesję) i komunikat apki — bez akcji albo z jedną akcją w osobnym segmencie
// (notatka projektu: „Cofnij", „Otwórz"; tap w resztę dymka zamyka). Jeden dymek naraz — nowy
// zastępuje stary; znika po 6 s albo gdy człowiek dojdzie do tej sesji dowolną drogą. Cykl życia
// (zegar 6 s, ogłoszenie czytnika) należy do centrum, nie do widoku: dymek ma dwa osadzenia,
// a każde musi tak samo gasnąć i mówić.
// Najlżejszy jest dymek potwierdzenia (kopia w terminalu): stoi krócej
// (`notice(_:hold:)`) i ustępuje — nie wypiera dymka o sesji ani dymka z akcją, wypiera tylko zwykły komunikat i inne
// potwierdzenie.

/// Treść dymka.
public struct Toast: Sendable, Equatable, Identifiable {
  public let id: Int
  /// Sesja, do której prowadzi tap; `nil` = komunikat apki (tap tylko zamyka).
  public let sessionId: String?
  /// Słowo rodzaju („Czeka na zgodę") — pierwsze, w kolorze tonu; `nil` przy komunikacie apki.
  public let kind: String?
  /// „projekt · sesja" — po słowie, wyciszone.
  public let place: String?
  /// Pełne zdanie: czytnik ekranu i treść komunikatu apki.
  public let text: String
  public let tone: StatusTone?
  /// Akcja komunikatu apki (segment za kreską); domknięcie trzyma centrum (`ToastCenter.performAction`).
  public let action: ToastAction?
  /// Wygląd: zwykły dymek albo krótkie potwierdzenie (znacznik przed zdaniem).
  public let style: ToastStyle
}

/// Wariant wyglądu dymka. Potwierdzenie (kopia w terminalu) to komunikat apki bez akcji, ze znacznikiem przed zdaniem.
public enum ToastStyle: Sendable, Equatable {
  case standard
  case confirmation
}

/// Akcja w dymku komunikatu: etykieta i identyfikator testów.
public struct ToastAction: Sendable, Equatable {
  public let label: String
  public let identifier: String

  public init(label: String, identifier: String) {
    self.label = label
    self.identifier = identifier
  }
}

@MainActor
@Observable
public final class ToastCenter {
  /// Dość, żeby kątem oka przeczytać projekt i czasownik; za mało, żeby zasłaniać ekran.
  public static let hold: Duration = .seconds(6)
  /// Dymek z akcją przy VoiceOver: czytnik musi zdążyć przeczytać zdanie i dojść do przycisku.
  public static let actionHoldVoiceOver: Duration = .seconds(10)
  /// Potwierdzenie gestu, który człowiek właśnie zrobił (kopia w terminalu): wynik widać od razu, więc krótko.
  public static let confirmationHold: TimeInterval = 2

  public private(set) var current: Toast?
  @ObservationIgnored private var nextId = 0
  @ObservationIgnored private let announcer: Announcer
  /// Odliczanie `hold` — testy podają własne (sterowane) czekanie.
  @ObservationIgnored private let wait: @Sendable (Duration) async -> Void
  /// Zegar bieżącego dymka; nowy dymek, tap i dojście do sesji go anulują.
  @ObservationIgnored private var expiry: Task<Void, Never>?
  /// Akcja bieżącego dymka; znika razem z nim.
  @ObservationIgnored private var perform: (@MainActor () -> Void)?
  /// Czytnik ekranu włączony — testy podają własne.
  @ObservationIgnored private let voiceOver: @MainActor () -> Bool

  public init(
    announcer: Announcer = .shared,
    wait: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) },
    voiceOver: @escaping @MainActor () -> Bool = ToastCenter.systemVoiceOver
  ) {
    self.announcer = announcer
    self.wait = wait
    self.voiceOver = voiceOver
  }

  public static func systemVoiceOver() -> Bool {
    #if canImport(UIKit)
    UIAccessibility.isVoiceOverRunning
    #else
    false
    #endif
  }

  /// Nowy sygnał z rdzenia. Dymek staje WYŁĄCZNIE, gdy człowiek ogląda inną sesję (`viewing`):
  /// na liście albo w widoku projektu dublowałby kropkę stanu, a we własnej sesji — kartę.
  public func offer(_ signal: SessionSignal?, state: AppState, viewing: String?) {
    guard let signal, let viewing, viewing != signal.sessionId, let session = state.sessions[signal.sessionId] else {
      return
    }
    let kind = UICopy.signalKind(signal.kind)
    let place = UICopy.signalPlace(session)
    show(
      sessionId: signal.sessionId, kind: kind, place: place, text: "\(kind) · \(place)", tone: Self.tone(signal.kind),
      action: nil, style: .standard, hold: nil)
  }

  /// Komunikat apki (np. „Powiadomienia włączone"), opcjonalnie z jedną akcją.
  public func notice(_ text: String, action: ToastAction? = nil, perform: (@MainActor () -> Void)? = nil) {
    let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !line.isEmpty else { return }
    show(
      sessionId: nil, kind: nil, place: nil, text: line, tone: nil, action: perform == nil ? nil : action,
      style: .standard, hold: nil)
    self.perform = perform
  }

  /// Krótkie potwierdzenie gestu (np. „Skopiowano do schowka." z terminala) na `hold` sekund, w wariancie
  /// „potwierdzenie”. Ustępuje: dymek o sesji i dymek z akcją zostają na ekranie (czytnik i tak słyszy zdanie),
  /// zwykły komunikat i poprzednie potwierdzenie ustępują jemu.
  public func notice(_ text: String, hold: TimeInterval) {
    let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !line.isEmpty else { return }
    if let current, current.sessionId != nil || current.action != nil {
      announcer.say(line)
      return
    }
    show(
      sessionId: nil, kind: nil, place: nil, text: line, tone: nil, action: nil, style: .confirmation,
      hold: .milliseconds(Int((hold * 1000).rounded())))
  }

  /// Wyjście dla ekranu UIKit (kopia w terminalu): zdanie idzie jako potwierdzenie na ``confirmationHold``.
  /// `nil` bez centrum — ekran mówi wtedy wynik po swojemu.
  public static func confirmation(_ center: ToastCenter?) -> ((String) -> Void)? {
    guard let center else { return nil }
    return { [weak center] text in center?.notice(text, hold: confirmationHold) }
  }

  /// Stuknięcie w segment akcji TEGO dymka: dymek gaśnie, akcja rusza. Dymek, który zdążył zgasnąć albo zostać
  /// zastąpiony, nie wykonuje niczego.
  public func performAction(_ id: Int) {
    guard current?.id == id, let perform else { return }
    clear()
    perform()
  }

  /// Człowiek doszedł do sesji dowolną drogą (lista, skrót, zakładka, tap w dymek) — jej dymek gaśnie.
  public func reached(_ sessionId: String?) {
    guard let sessionId, current?.sessionId == sessionId else { return }
    clear()
  }

  /// Zdejmuje TEN dymek (upływ czasu, tap). Nowszy, który zdążył go zastąpić, zostaje.
  public func dismiss(_ id: Int) {
    if current?.id == id { clear() }
  }

  private func show(
    sessionId: String?, kind: String?, place: String?, text: String, tone: StatusTone?, action: ToastAction?,
    style: ToastStyle, hold custom: Duration?
  ) {
    nextId += 1
    let toast = Toast(
      id: nextId, sessionId: sessionId, kind: kind, place: place, text: text, tone: tone, action: action, style: style)
    current = toast
    perform = nil
    // Czytnik słyszy dymek w kolejce, nie w pół zdania — w każdym osadzeniu.
    announcer.say(action.map { "\(text). \($0.label)" } ?? text, eventID: "toast:\(toast.id)")
    let hold = custom ?? (action != nil && voiceOver() ? Self.actionHoldVoiceOver : Self.hold)
    expiry?.cancel()
    expiry = Task { [weak self, wait] in
      await wait(hold)
      guard !Task.isCancelled else { return }
      self?.dismiss(toast.id)
    }
  }

  private func clear() {
    current = nil
    perform = nil
    expiry?.cancel()
    expiry = nil
  }

  /// Ton = kolor stanu: bursztyn czeka, czerwień stanęło, błękit skończył (`notify-copy`).
  static func tone(_ kind: SessionSignal.Kind) -> StatusTone {
    switch kind {
    case .permission, .question: .waiting
    case .error, .limit: .failed
    case .done: .unread
    }
  }
}

/// Gdzie stoi dymek: na ekranie sesji z transkryptem NAD promptem, w ekranie
/// (UIKit, nad paskiem „Przewiń na dół"), na każdym innym ekranie prawej kolumny (terminal, Codex, projekt,
/// „startuje", pusta kolumna) — nakładka u dołu kolumny. Ekran sesji ma osadzenie u siebie, więc nakładka
/// wtedy milczy; dymek nie ginie przy zmianie ekranu, tylko zmienia osadzenie. Otwarte okno terminala Cmd+F/Cmd+G
/// ma dymek u siebie, u dołu arkusza: arkusz przykrywa kolumnę, a dymek w niej
/// (np. „Skopiowano do schowka." z tego okna) byłby pod nim; nakładka kolumny wtedy milczy.
public enum ToastPlacement: Sendable, Equatable {
  case sessionScreen
  case overlay
  case terminalWindow

  /// Ta sama reguła co `DetailView`: ekran sesji stoi, gdy na trasie nie ma terminala, a wybrana sesja jest
  /// na liście i nie jest wpisem Codexa. Okno terminala nad kolumną wygrywa z oboma.
  @MainActor
  public static func resolve(navigation: RarogNavigation, state: AppState) -> ToastPlacement {
    if navigation.popup != nil { return .terminalWindow }
    guard navigation.terminalRoute(state) == nil, let id = navigation.selectedSessionId,
      let session = state.sessions[id], session.engine != .codex
    else { return .overlay }
    return .sessionScreen
  }
}

extension Notification.Name {
  /// Komunikat apki do dymka z miejsc bez dostępu do środowiska SwiftUI (UIKit); `object` = zdanie.
  public static let rarogAppNotice = Notification.Name("pl.useo.rarog.appNotice")
}
