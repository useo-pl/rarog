import Foundation
import Observation
import RarogContract
import RarogCore

// Prawy panel sesji na iPadzie: co dzieje się w tle OTWARTEJ sesji, co ostatnio
// się skończyło i co zmieniło się w katalogu. Otwiera i zamyka go wyłącznie człowiek (Cmd+I, przycisk w nagłówku),
// a urządzenie pamięta, że ma być otwarty, dopóki go nie zamknie. Reguły — czyste funkcje, testy na macOS; stan
// widoku i zapis preferencji — `RarogInspector`. Widok: `Views/Inspector/`. Właściciel: panel.

public enum InspectorModel {
  /// Panel width without a saved preference (pt).
  public static let defaultWidth: Double = 320
  /// Range of the width set by dragging the divider (pt).
  public static let minWidth: Double = 280
  public static let maxWidth: Double = 560
  /// The transcript next to the panel keeps at least this much (pt), as at the bottom of the hysteresis band with
  /// the default width; a narrower column narrows the panel, not the transcript.
  public static let transcriptMinWidth: Double = 560
  /// One VoiceOver adjustment of the width (pt).
  public static let adjustmentStep: Double = 40
  /// Detail column from which the panel appears (pt), whatever the panel's width: with the default 320 pt the
  /// transcript keeps at least 600 pt.
  public static let showWidth: Double = 920
  /// Stojący panel chowa się dopiero poniżej tej szerokości — histereza: obrót, Stage Manager czy poszerzenie listy
  /// o kilka punktów nie zdejmują panelu i nie stawiają go z powrotem w kolejnych klatkach.
  public static let hideWidth: Double = 880

  /// Nagłówki sekcji — cele kotwicy przewinięcia panelu obok wierszy „w tle" (jedna kotwica na cały panel).
  public static let backgroundAnchor = "inspector.section.background"
  public static let finishedAnchor = "inspector.section.finished"
  public static let scheduledAnchor = "inspector.section.scheduled"
  public static let artifactsAnchor = "inspector.section.artifacts"
  public static let pullRequestsAnchor = "inspector.section.pullRequests"
  /// Tap w linię gita przy widocznym panelu stawia kotwicę tutaj.
  public static let changesAnchor = "inspector.section.changes"

  /// Czy panel mieści się w kolumnie szczegółu. `eligible` = iPad w zwykłej szerokości (telefon i wąskie okno
  /// nigdy). `standing` = panel już stoi: wtedy trzyma się do 880 pt; panel, który nie stoi (zamknięty, schowany
  /// z braku miejsca, przed pierwszym pomiarem), staje dopiero od 920 pt — histereza dotyczy WYŁĄCZNIE stojącego
  /// panelu, więc zamknięcie przy 900 pt nie zostawia „miejsca” na ponowne otwarcie.
  public static func fits(columnWidth: Double, eligible: Bool, standing: Bool) -> Bool {
    guard eligible else { return false }
    return columnWidth >= (standing ? hideWidth : showWidth)
  }

  /// The width a column of `columnWidth` pt shows for the preferred width: never below 280 pt, and the transcript
  /// keeps 560 pt. The preference itself stays; the preferred width returns when the room does.
  public static func displayedWidth(preferred: Double, columnWidth: Double) -> Double {
    max(minWidth, min(preferred, columnWidth - transcriptMinWidth))
  }

  /// A width set by hand (drag, VoiceOver) in a column of `columnWidth` pt: within 280...560 pt and leaving the
  /// transcript 560 pt.
  public static func handWidth(_ proposed: Double, columnWidth: Double) -> Double {
    let upper = max(minWidth, min(maxWidth, columnWidth - transcriptMinWidth))
    return min(max(proposed, minWidth), upper)
  }

  /// The saved preference: no entry, a non-number or a non-finite number is the default; the rest is clamped to
  /// 280...560 pt.
  public static func preferredWidth(stored: Any?) -> Double {
    guard let value = (stored as? NSNumber)?.doubleValue ?? stored as? Double, value.isFinite else {
      return defaultWidth
    }
    return min(max(value, minWidth), maxWidth)
  }
}

/// Wynik Cmd+I albo przycisku nagłówka.
public enum InspectorToggle: Sendable, Equatable {
  case opened
  case closed
  /// Kolumna za wąska: preferencja bez zmian, człowiek dostaje zdanie, jak zrobić miejsce.
  case noRoom
  /// Na ekranie nie ma sesji Claude (terminal, Codex, projekt, telefon) — skrót milczy.
  case unavailable
}

/// Stan panelu: preferencje urządzenia `rarog.inspectorOpen`, `rarog.inspectorChangesCollapsed` i
/// `rarog.inspectorWidth` (przeżywają
/// zmianę sesji, obrót i restart apki),
/// pomiar kolumny szczegółu (`DetailView`) i to, czy otwarty panel stoi (histereza tylko dla stojącego), oraz —
/// w pamięci procesu — kotwica przewinięcia
/// i rozwinięcia faz workflow KAŻDEJ sesji osobno: powrót do sesji wraca do jej miejsca, a inna sesja nie
/// dostaje cudzego.
@MainActor
@Observable
public final class RarogInspector {
  public private(set) var open: Bool
  /// iPad w zwykłej szerokości — panel w ogóle wchodzi w grę.
  public private(set) var eligible = false
  /// Szerokość kolumny szczegółu z ostatniego pomiaru (pt).
  public private(set) var columnWidth: Double = 0
  /// Otwarty panel stoi w kolumnie: stanął od 920 pt i trzyma się do 880 pt. Zamknięty — nigdy (zamknięcie zeruje
  /// histerezę). Nie zależy od trasy: powrót z terminala do sesji przy 900 pt zostawia stojący panel.
  public private(set) var standing = false
  /// Kotwica przewinięcia panelu per sesja: id wiersza „w tle" albo nagłówka sekcji.
  public var anchors: [String: String] = [:]
  /// Rozwinięcia faz workflow per sesja (popover ma swoje, `BackgroundTasksPanel`).
  public var expansions: [String: WorkflowExpansion] = [:]
  /// Zwinięte katalogi drzewa zmian per sesja (ścieżki, `ChangesDirectoryRow.path`); drzewo startuje rozwinięte.
  public var collapsedDirs: [String: Set<String>] = [:]
  /// Całe drzewo zmian zwinięte do nagłówka sekcji: preferencja urządzenia `rarog.inspectorChangesCollapsed`, jedna
  /// dla wszystkich sesji. Zwinięte ręką zostaje zwinięte, rozwinięte — rozwinięte, także po zmianie sesji, nowej
  /// ramce gita i ponownym uruchomieniu. Zwinięć katalogów (`collapsedDirs`) nie rusza.
  public private(set) var changesCollapsed: Bool
  /// Telefon: sesja, przy której stoi panel jako arkusz (`Model/InspectorSheet.swift`). Otwiera go tylko tap
  /// człowieka, zamyka gest, okno apki i zmiana ekranu (`RarogNavigation.detail`).
  public internal(set) var sheet: String?
  /// Width the human chose: the device preference `rarog.inspectorWidth`, written at the end of a drag.
  public private(set) var preferredWidth: Double
  /// Width during a drag of the divider, before it is saved.
  public private(set) var dragWidth: Double?

  @ObservationIgnored private let prefs: PreferenceStore
  /// Width shown when the current drag started; the drag's translation counts from it.
  @ObservationIgnored private var dragStart: Double?

  public init(prefs: PreferenceStore) {
    self.prefs = prefs
    open = prefs.bool(forKey: NavigationPreferences.inspectorOpen)
    changesCollapsed = prefs.bool(forKey: NavigationPreferences.inspectorChangesCollapsed)
    preferredWidth = InspectorModel.preferredWidth(stored: prefs.object(forKey: NavigationPreferences.inspectorWidth))
  }

  /// The panel's width in the measured column (pt): the live drag width, otherwise the preference, either narrowed
  /// to the room (a column narrowing mid-drag narrows the live width too).
  public var displayedWidth: Double {
    InspectorModel.displayedWidth(preferred: dragWidth ?? preferredWidth, columnWidth: columnWidth)
  }

  /// The divider moved by `translation` pt since the gesture began (negative = to the left = wider). The width
  /// follows live; nothing is saved until ``endDrag()``, and the panel stays open and standing.
  public func drag(translation: Double) {
    let start = dragStart ?? displayedWidth
    dragStart = start
    let next = InspectorModel.handWidth(start - translation, columnWidth: columnWidth)
    if next != dragWidth { dragWidth = next }
  }

  /// End of the drag: the width reached becomes the preference, written once.
  public func endDrag() {
    defer { dragStart = nil }
    guard let width = dragWidth else { return }
    dragWidth = nil
    savePreferredWidth(width)
  }

  /// VoiceOver adjustment: the shown width plus `delta`, within the drag limits, saved at once.
  public func adjustWidth(by delta: Double) {
    savePreferredWidth(InspectorModel.handWidth(displayedWidth + delta, columnWidth: columnWidth))
  }

  private func savePreferredWidth(_ width: Double) {
    if width != preferredWidth { preferredWidth = width }
    prefs.set(width, forKey: NavigationPreferences.inspectorWidth)
  }

  /// Panel, który nie stoi, może stanąć: kolumna ma co najmniej 920 pt.
  public var canOpen: Bool {
    InspectorModel.fits(columnWidth: columnWidth, eligible: eligible, standing: false)
  }

  /// Pomiar kolumny szczegółu (`DetailView`): szerokość i to, czy panel w ogóle wchodzi w grę.
  public func noteLayout(columnWidth: Double, eligible: Bool) {
    if self.eligible != eligible { self.eligible = eligible }
    if self.columnWidth != columnWidth { self.columnWidth = columnWidth }
    settle()
  }

  public func setOpen(_ value: Bool) {
    guard value != open else { return }
    open = value
    prefs.set(value, forKey: NavigationPreferences.inspectorOpen)
    settle()
  }

  public func setChangesCollapsed(_ value: Bool) {
    guard value != changesCollapsed else { return }
    changesCollapsed = value
    prefs.set(value, forKey: NavigationPreferences.inspectorChangesCollapsed)
  }

  /// Stojący panel trzyma się do 880 pt, niestojący (także zamknięty przed chwilą) staje od 920 pt.
  private func settle() {
    let next = open && InspectorModel.fits(columnWidth: columnWidth, eligible: eligible, standing: standing)
    if next != standing { standing = next }
  }
}

extension RarogNavigation {
  /// Sesja Claude na ekranie, przy której panel ma sens: transkrypt z polem wiadomości. Terminal (także wpis agenta
  /// z `termId` — Codex albo Claude uruchomiony w terminalu Raroga), stan Codexa, ekran projektu i sesja jeszcze
  /// nieznana liście — `nil`.
  public func inspectorSession(_ state: AppState) -> String? {
    guard case let .session(id) = detail, terminalRoute(state) == nil, let session = state.sessions[id],
      session.engine != .codex
    else { return nil }
    return id
  }

  /// Przycisk w nagłówku ma co zrobić: zamknąć stojący panel albo otworzyć go przy kolumnie od 920 pt.
  public func inspectorAvailable(_ state: AppState) -> Bool {
    inspectorSession(state) != nil && (inspector.standing || inspector.canOpen)
  }

  /// Panel stoi obok transkryptu.
  public func inspectorVisible(_ state: AppState) -> Bool {
    inspector.standing && inspectorSession(state) != nil
  }

  /// Cmd+I i przycisk nagłówka. Stojący panel zamyka zawsze; za wąska kolumna NIE zmienia preferencji (panel,
  /// który człowiek zostawił otwarty, wróci sam, gdy zrobi się miejsce) — zamiast tego ``InspectorToggle/noRoom``.
  @discardableResult
  public func toggleInspector(_ state: AppState) -> InspectorToggle {
    if inspectorVisible(state) {
      inspector.setOpen(false)
      return .closed
    }
    guard inspector.eligible, inspectorSession(state) != nil else { return .unavailable }
    guard inspector.canOpen else { return .noRoom }
    inspector.setOpen(true)
    return .opened
  }
}
