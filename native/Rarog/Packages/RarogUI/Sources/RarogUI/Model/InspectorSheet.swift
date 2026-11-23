import Foundation
import RarogContract
import RarogCore

// Prawy panel sesji na telefonie: telefon nie ma miejsca na panel obok transkryptu, więc
// ten sam panel staje jako arkusz. Otwiera go wyłącznie tap człowieka: przycisk panelu w nagłówku (na lewo od „×”),
// lewa część linii statusu (pierścień kontekstu i git) albo pigułka „w tle”. Dymka gita z ostatnim commitem telefon nie ma. iPad, także w wąskim oknie, zostaje
// przy dymkach i stojącym panelu. Reguły — czyste funkcje, testy na macOS (`InspectorSheetTests`); widok:
// `Views/Inspector/InspectorPanel+Sheet.swift`. Właściciel: panel.

/// Co robi tap w lewą część linii statusu (pierścień kontekstu i git).
public enum GitLineTap: Sendable, Equatable {
  /// Linia nie jest przyciskiem.
  case none
  /// Dymek gita: ostatni commit i zmienione pliki (iPad).
  case gitPopover
  /// Panel stoi obok transkryptu: tap przewija go do zmian w katalogu (iPad).
  case scrollPanel
  /// Telefon: panel sesji jako arkusz, przewinięty do kotwicy.
  case panelSheet(anchor: String)

  /// Tap otwiera arkusz panelu (podpowiedź czytnika mówi to zamiast „ostatni commit i zmienione pliki”).
  public var opensSheet: Bool {
    if case .panelSheet = self { return true }
    return false
  }
}

/// Co robi tap w pigułkę „w tle”.
public enum BackgroundPillTap: Sendable, Equatable {
  /// Dymek z zadaniami w tle (iPad, Codex).
  case popover
  /// Telefon: panel sesji jako arkusz, przewinięty do kotwicy.
  case panelSheet(anchor: String)
}

extension RarogNavigation {
  /// Tap w linię statusu `session`. `phone` = idiom telefonu (`PopoverLayout.sheetBar`), nie klasa szerokości: wąskie
  /// okno iPada zostaje przy dymku. Na telefonie przy sesji z panelem linia jest przyciskiem ZAWSZE i otwiera panel
  /// na górze (W TLE, SKOŃCZONE OSTATNIO). Na zmianach w katalogu tylko wtedy, gdy obok stoi pigułka „w tle” (ona
  /// prowadzi na górę) i git ma rozwinięcie (`StatusLine.gitExpands`): bez pigułki linia jest jedynym wejściem, a skok
  /// na dno panelu jest zbędny. Bez panelu (Codex, agent w terminalu Raroga) nie jest przyciskiem.
  public func gitLineTap(_ state: AppState, session: SessionSummary, isRepo: Bool, phone: Bool) -> GitLineTap {
    let expands = StatusLine.gitExpands(session, isRepo: isRepo)
    if phone {
      guard inspectorSession(state) == session.id else { return .none }
      let pill = StatusPills.background(session, inPanel: false)
      return .panelSheet(anchor: expands && pill ? InspectorModel.changesAnchor : InspectorModel.backgroundAnchor)
    }
    guard expands else { return .none }
    return inspectorVisible(state) ? .scrollPanel : .gitPopover
  }

  /// Tap w pigułkę „w tle” sesji `sessionId`: na telefonie przy sesji z panelem — arkusz panelu na górze (sekcja
  /// W TLE), inaczej dymek.
  public func backgroundPillTap(_ state: AppState, sessionId: String, phone: Bool) -> BackgroundPillTap {
    phone && inspectorSession(state) == sessionId ? .panelSheet(anchor: InspectorModel.backgroundAnchor) : .popover
  }

  /// Sesja, przy której stoi arkusz panelu: tylko sesja z panelem na ekranie (`inspectorSession`).
  public func inspectorSheetSession(_ state: AppState) -> String? {
    guard let id = inspector.sheet, id == inspectorSession(state) else { return nil }
    return id
  }

  /// Tap człowieka: kotwica TEJ sesji (inne zachowują swoje) i arkusz przy niej.
  public func openInspectorSheet(sessionId: String, anchor: String) {
    inspector.anchors[sessionId] = anchor
    inspector.sheet = sessionId
  }

  /// Przycisk panelu w nagłówku sesji. Telefon: przy każdej sesji z panelem, bo arkusz mieści się zawsze. iPad: tylko
  /// gdy panel obok transkryptu ma co zrobić (``inspectorAvailable(_:)``).
  public func inspectorButtonShown(_ state: AppState, phone: Bool) -> Bool {
    phone ? inspectorSession(state) != nil : inspectorAvailable(state)
  }

  /// Przycisk panelu jest „zaznaczony”: arkusz stoi (telefon) albo panel stoi obok transkryptu (iPad).
  public func inspectorButtonSelected(_ state: AppState, phone: Bool) -> Bool {
    phone ? inspectorSheetSession(state) != nil : inspectorVisible(state)
  }

  /// Tap w przycisk panelu na telefonie: arkusz na górze panelu (W TLE), przy stojącym arkuszu zamknięcie.
  public func toggleInspectorSheet(_ state: AppState) {
    if inspectorSheetSession(state) != nil { return closeInspectorSheet() }
    guard let id = inspectorSession(state) else { return }
    openInspectorSheet(sessionId: id, anchor: InspectorModel.backgroundAnchor)
  }

  /// Gest, Esc albo system zdjął arkusz (np. okno diffa stanęło nad nim). Kotwica zostaje na następne otwarcie.
  public func closeInspectorSheet() {
    if inspector.sheet != nil { inspector.sheet = nil }
  }
}
