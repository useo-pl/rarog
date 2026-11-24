import Foundation
import Observation
import RarogContract
import RarogCore

// Jeden arkusz naraz. Okna (terminal Cmd+F/Cmd+G, historia z trasy, diff, tekst transkryptu) i formularze („Nowa sesja”,
// „Ostatnie sesje”) to JEDEN stan nawigacji (`RarogNavigation.sheet`) i jeden `.sheet(item:)` na korzeniu
// (`SheetHost`). Dwa arkusze naraz nie mają jak powstać: nowy zastępuje stary. Własny stan i własny `.sheet` na rodzaj
// ustawiałby przy otwartym formularzu okno z Cmd+F „w kolejce”: wyskoczyłoby samo po zamknięciu formularza, a do tego
// czasu blokowałoby Cmd+1…9. Logika bez UIKit — testy na macOS.

/// Prośba o formularz „Nowa sesja”. Nowa prośba = nowa prezentacja (nowy identyfikator, czysty formularz);
/// wynik żądania należy wyłącznie do prezentacji, z której wyszedł.
public struct NewSessionRequest: Identifiable, Hashable, Sendable {
  public let id: UUID
  /// Katalog z wejścia (projekt bez sesji) — ma pierwszeństwo przed ostatnio odwiedzonym.
  public let cwd: String?

  public init(id: UUID = UUID(), cwd: String?) {
    self.id = id
    self.cwd = cwd
  }
}

/// Prośba o „Ostatnie sesje” projektu.
public struct RecentSessionsRequest: Identifiable, Hashable, Sendable {
  public let id: UUID
  public let cwd: String

  public init(id: UUID = UUID(), cwd: String) {
    self.id = id
    self.cwd = cwd
  }
}

/// Prośba o okno diffa sesji: od góry albo od pliku `path` (ścieżka z ramki `git-status`; zakończona `/` to
/// nieśledzony katalog, czyli pierwszy plik pod nim). Okno pobiera listę i patche samo (`DiffWindowModel`):
/// prezentujący — prawy panel i dymek gita — diffa nie pobierają, więc prośba nie niesie żadnej treści.
public struct DiffRequest: Identifiable, Equatable, Sendable {
  public let id: UUID
  public let sessionId: String
  public let path: String?

  public init(id: UUID = UUID(), sessionId: String, path: String?) {
    self.id = id
    self.sessionId = sessionId
    self.path = path
  }

  /// Tożsamość prezentacji: każde otwarcie jest inne, także tego samego pliku.
  public static func == (lhs: DiffRequest, rhs: DiffRequest) -> Bool { lhs.id == rhs.id }
}

/// A request for "Settings": the button in the list bar, a tap on a `device-paired` or `version-changed` push, and a
/// pairing link opened while logged in (the "Pair with …?" card then stands in this form). The page over the list is
/// navigation state (``RarogNavigation/settingsPage``), not part of the request.
public struct SettingsRequest: Identifiable, Hashable, Sendable {
  public let id: UUID

  public init(id: UUID = UUID()) {
    self.id = id
  }
}

/// Prośba o ekran „Dyktowanie” jako arkusz: stuknięcie mikrofonu pola wiadomości, gdy trasa dyktowania pyta
/// (`DictationRoute.ask`). Wybór zamyka arkusz; mikrofon otwiera dopiero następne stuknięcie.
public struct DictationRequest: Identifiable, Hashable, Sendable {
  public let id: UUID

  public init(id: UUID = UUID()) {
    self.id = id
  }
}

/// A request for the consent of the voice conversation across sessions: the session list button while a consent is
/// missing (`VoiceAgentSessionsEntry.consent`). The last consent starts the conversation; closing stores nothing more.
public struct VoiceAgentSessionsConsentRequest: Identifiable, Hashable, Sendable {
  public let id: UUID

  public init(id: UUID = UUID()) {
    self.id = id
  }
}

/// Arkusz nad ekranem. `id` to żeton TEJ prezentacji: zamknięcie jest zawsze adresowane żetonem, więc spóźnione
/// wywołanie starej prezentacji (`exit` zamkniętego terminala, odpowiedź formularza) nie zamyka nowej.
public enum AppSheet: Identifiable, Equatable, Sendable {
  case terminal(TerminalPopupRequest, token: UUID)
  case history(TerminalHistoryRequest, token: UUID)
  case diff(DiffRequest)
  /// Tekst transkryptu do zaznaczania przez wiele wiadomości — okno z migawką z chwili otwarcia.
  case transcriptText(TranscriptTextRequest)
  /// The whole input of a permission card whose block shows a preview; reading only.
  case consentInput(ConsentInputRequest)
  case newSession(NewSessionRequest)
  case recentSessions(RecentSessionsRequest)
  /// Notatka projektu: pisanie, więc formularz — trzyma przy zmianie ekranu z zewnątrz.
  case note(NoteRequest)
  /// „Ustawienia” (serwer, parowanie, urządzenia) — formularz: kod parowania i arkusz potwierdzenia trzymają.
  case settings(SettingsRequest)
  /// „Dyktowanie”: wybór i zgoda przed pierwszym nagraniem — formularz: okno nie wchodzi w miejsce pytania.
  case dictation(DictationRequest)
  /// The consent of the voice conversation across sessions (and the voice agent's before it when that is off) — a
  /// form: a window does not take its place.
  case voiceAgentSessionsConsent(VoiceAgentSessionsConsentRequest)

  public var id: UUID {
    switch self {
    case let .terminal(_, token), let .history(_, token): token
    case let .diff(request): request.id
    case let .transcriptText(request): request.id
    case let .consentInput(request): request.id
    case let .newSession(request): request.id
    case let .recentSessions(request): request.id
    case let .note(request): request.id
    case let .settings(request): request.id
    case let .dictation(request): request.id
    case let .voiceAgentSessionsConsent(request): request.id
    }
  }

  /// Formularz ma stan (wpisana ścieżka, start w drodze), więc TRZYMA: okno nie wchodzi w jego miejsce.
  public var isForm: Bool {
    switch self {
    case .newSession, .recentSessions, .note, .settings, .dictation, .voiceAgentSessionsConsent: true
    case .terminal, .history, .diff, .transcriptText, .consentInput: false
    }
  }

  /// Okno (terminal, historia, diff, tekst transkryptu, całe wejście karty): ustępuje innemu oknu i zmianie ekranu.
  public var isWindow: Bool { !isForm }
}

extension RarogNavigation {
  /// Okno terminala nad ekranem (Cmd+F powłoka, Cmd+G lazygit), jeśli to ono stoi.
  public var popup: TerminalPopupRequest? {
    if case let .terminal(request, _) = sheet { return request }
    return nil
  }

  /// Okno historii terminala trasy, jeśli to ono stoi.
  public var terminalHistory: TerminalHistoryRequest? {
    if case let .history(request, _) = sheet { return request }
    return nil
  }

  /// Otwiera arkusz. Okno zastępuje inne okno; formularz zastępuje okno i inny formularz; okno NIE wchodzi
  /// w miejsce formularza (formularz trzyma). Otwarty dymek zdejmuje system sam, gdy arkusz staje (pomiar
  /// na iOS 26.2 i 27).
  public func openSheet(_ next: AppSheet) {
    if next.isWindow, sheet?.isForm == true { return }
    sheet = next
  }

  /// „Ustawienia”, jeśli to one stoją.
  public var settingsSheet: SettingsRequest? {
    if case let .settings(request) = sheet { return request }
    return nil
  }

  /// Opens "Settings" on `page` (`nil` = the list). Standing Settings are not built anew (a pairing link or a push tap
  /// reaching the open sheet): only the page changes. Over another page the change takes two steps: `nil`, a main
  /// queue turn, then the new page. SwiftUI does not pop a deeper page when the destination value is swapped, and
  /// `nil` with a value in one update merges into a swap; the turn lets the old page disappear and the new one appear.
  public func openSettings(page: SettingsPage? = nil) {
    guard let standing = settingsSheet else {
      pendingSettingsPage = nil
      openSheet(.settings(SettingsRequest()))
      settingsPage = page
      return
    }
    if pendingSettingsPage?.sheet == standing.id, settingsPage == nil {
      // The first step stands in this update: a later request only retargets the second step.
      pendingSettingsPage?.page = page
      return
    }
    pendingSettingsPage = nil
    guard settingsPage != page else { return }
    guard let page, settingsPage != nil else {
      settingsPage = page
      return
    }
    settingsPage = nil
    let pending = PendingSettingsPage(sheet: standing.id, page: page)
    pendingSettingsPage = pending
    DispatchQueue.main.async { [weak self] in
      MainActor.assumeIsolated { self?.finishSettingsPage(pending.step) }
    }
  }

  /// Second step of a page change: only its own step, while the same Settings still stand on the list.
  private func finishSettingsPage(_ step: UUID) {
    guard let pending = pendingSettingsPage, pending.step == step else { return }
    pendingSettingsPage = nil
    guard settingsSheet?.id == pending.sheet, settingsPage == nil else { return }
    settingsPage = pending.page
  }

  /// „Dyktowanie”, jeśli to ono stoi.
  public var dictationSheet: DictationRequest? {
    if case let .dictation(request) = sheet { return request }
    return nil
  }

  /// Otwiera „Dyktowanie” — chyba że już stoi (drugie stuknięcie mikrofonu nie buduje arkusza od nowa).
  public func openDictation() {
    guard dictationSheet == nil else { return }
    openSheet(.dictation(DictationRequest()))
  }

  /// Opens the consent of the voice conversation across sessions, unless it stands already.
  public func openVoiceAgentSessionsConsent() {
    if case .voiceAgentSessionsConsent = sheet { return }
    openSheet(.voiceAgentSessionsConsent(VoiceAgentSessionsConsentRequest()))
  }

  /// Formularz notatki projektu otwarty teraz, jeśli to on stoi.
  public var noteSheet: NoteRequest? {
    if case let .note(request) = sheet { return request }
    return nil
  }

  /// Formularz notatki projektu: zastępuje okno i dymek, a inny formularz — jak każdy formularz (wejścia, które
  /// nie mają prawa skasować „Nowej sesji", sprawdzają to same: ⌘J w ``perform(_:store:now:)``).
  public func openNote(cwd: String, start: NoteRequest.Start = .edit) {
    openSheet(.note(NoteRequest(cwd: ProjectPath.normalized(cwd), start: start)))
  }

  /// Okno diffa sesji: od góry (`path == nil`) albo od pliku stukniętego w panelu lub dymku gita.
  public func openDiff(sessionId: String, path: String?) {
    openSheet(.diff(DiffRequest(sessionId: sessionId, path: path)))
  }

  /// Zamyka arkusz o tym żetonie; inny (nowszy) zostaje.
  public func closeSheet(id: UUID) {
    if sheet?.id == id { sheet = nil }
  }

  /// Zapis `nil` z wiązania arkusza (gest, tap obok, `dismiss()`): zamyka arkusz, którego treść STOI na ekranie
  /// (`shown`). Gdy stan ma już następny arkusz, zapis należy do schodzącego i nowego nie rusza.
  public func sheetDismissed(shown: UUID?) {
    guard let current = sheet else { return }
    if let shown, shown != current.id { return }
    sheet = nil
  }

  /// Żeton okna, które straciło swoją sesję (zamknięta na innym urządzeniu): diff nie ma czego pokazywać, a lista
  /// i patche na ekranie byłyby ostatnimi znanymi. Ekran pod spodem mówi wtedy „nie ma takiej sesji” bez zmiany trasy, więc
  /// reguła „zmiana ekranu zamyka okno” tego nie łapie. Tylko przy ŚWIEŻEJ liście:
  /// lista jeszcze niewczytana albo z pamięci podręcznej niczego nie zamyka.
  public func orphanedSheet(_ state: AppState) -> UUID? {
    guard case let .diff(request) = sheet, state.sessionsLoaded, !state.listStale,
      state.sessions[request.sessionId] == nil
    else { return nil }
    return request.id
  }

  /// Koniec zalogowanego interfejsu (401, wylogowanie): arkusz do niego należał. Nawigacja przeżywa wylogowanie,
  /// ale stan formularza ginie z widokiem — samo żądanie wróciłoby po zalogowaniu pustym formularzem
  /// nad innym ekranem. Arkusz panelu sesji na telefonie też należał do tego interfejsu: bez zdjęcia stanąłby po
  /// zalogowaniu sam, bo `detail` zostaje.
  public func dropSheet() {
    sheet = nil
    inspector.sheet = nil
  }
}

/// Wejścia do formularza „Nowa sesja” i ekranu „Ostatnie sesje”: kto prosi o arkusz.
/// Przycisk w pasku listy, ekran projektu bez sesji (`ProjectEmptyView`) i zegar w nagłówku sesji proszą przez
/// prezentera ze środowiska; stan trzyma nawigacja (``RarogNavigation/sheet``), pokazuje `SheetHost`. Cmd+N i „+"
/// w pasku zakładek zostają szybkim startem w bieżącym projekcie. Właściciel: sterowanie sesją.
@MainActor
@Observable
public final class NewSessionPresenter {
  public typealias Request = NewSessionRequest
  public typealias Recent = RecentSessionsRequest

  private let navigation: RarogNavigation

  public init(navigation: RarogNavigation) {
    self.navigation = navigation
  }

  public var request: Request? {
    if case let .newSession(request) = navigation.sheet { return request }
    return nil
  }

  public var recent: Recent? {
    if case let .recentSessions(recent) = navigation.sheet { return recent }
    return nil
  }

  public func openNewSession(cwd: String? = nil) {
    navigation.openSheet(.newSession(Request(cwd: cwd)))
  }

  public func openRecent(cwd: String) {
    navigation.openSheet(.recentSessions(Recent(cwd: cwd)))
  }

  func isCurrent(_ request: Request) -> Bool { self.request?.id == request.id }
  func isCurrent(_ recent: Recent) -> Bool { self.recent?.id == recent.id }

  func close(_ request: Request) { navigation.closeSheet(id: request.id) }
  func close(_ recent: Recent) { navigation.closeSheet(id: recent.id) }
}
