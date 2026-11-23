import Foundation
import RarogContract

#if os(iOS)
import UIKit
#endif

// Jeden kanał ogłoszeń czytnika ekranu. Właściciel: dostępność.
//
// JEDEN komunikat ma JEDEN nośnik — każde zdanie dla czytnika idzie przez `Announcer`, nikt nie
// woła `UIAccessibility.post(.announcement)` sam. Bramki (aktywność, nowa karta decyzji) to czyste
// wartości trzymane przez widok, testowane na macOS; kanał tylko je wypowiada.

/// Kanał ogłoszeń. Na iOS ujściem jest `UIAccessibility.post(notification: .announcement)` z priorytetem
/// mowy; testy podają własne ujście i zegar.
@MainActor
public final class Announcer {
  /// Jak pilne jest zdanie dla czytnika.
  public enum Priority: Sendable, Equatable {
    /// Błąd i odmowa: przerywa bieżącą mowę (priorytet wysoki).
    case urgent
    /// Wynik akcji, zmiana stanu: w kolejce za bieżącą mową.
    case normal
    /// Aktywność agenta: mówiona, gdy czytnik milczy, i ustępuje każdej innej mowie.
    case ambient
  }

  public struct Announcement: Sendable, Equatable {
    public let text: String
    public let priority: Priority
  }

  /// To samo zdanie z dwóch miejsc w tej chwili to JEDEN komunikat (przycisk i ekran, które
  /// ogłosiłyby jeden wynik); po tym oknie ten sam tekst znów jest słyszalny (dwa razy „Nie udało się
  /// wysłać" to dwa zdarzenia).
  public static let duplicateWindow: TimeInterval = 1

  public static let shared = Announcer(sink: Announcer.post, now: Date.init)

  private let sink: @MainActor (Announcement) -> Void
  private let now: () -> Date
  private enum DuplicateKey: Hashable { case event(String), text(String) }
  private var recent: [DuplicateKey: Date] = [:]

  public init(sink: @escaping @MainActor (Announcement) -> Void, now: @escaping () -> Date) {
    self.sink = sink
    self.now = now
  }

  /// Wypowiada zdanie. `eventID` scala nośniki jednego zdarzenia; bez niego kluczem jest tekst.
  /// Puste i powtórzone w oknie `duplicateWindow` milczą, także przy innym zdaniu między nimi.
  public func say(_ text: String, priority: Priority = .normal, eventID: String? = nil) {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    let at = now()
    recent = recent.filter { at.timeIntervalSince($0.value) < Self.duplicateWindow }
    let key = eventID.map(DuplicateKey.event) ?? .text(text)
    guard recent[key] == nil else { return }
    recent[key] = at
    sink(Announcement(text: text, priority: priority))
  }

  /// Ujście systemowe: priorytet mowy z iOS 17 (wysoki przerywa, niski ustępuje), domyślny w kolejce.
  private static func post(_ announcement: Announcement) {
    #if os(iOS)
    let priority: UIAccessibilityPriority =
      switch announcement.priority {
      case .urgent: .high
      case .normal: .default
      case .ambient: .low
      }
    let text = NSAttributedString(
      string: announcement.text,
      attributes: [
        .accessibilitySpeechAnnouncementPriority: priority,
        .accessibilitySpeechQueueAnnouncement: announcement.priority != .urgent,
      ])
    UIAccessibility.post(notification: .announcement, argument: text)
    #endif
  }
}

/// Bramka ogłoszeń wiersza aktywności (PWA `shouldSpeakActivity`). Sam wiersz tyka co sekundę, więc
/// czytnik nie słyszy każdej zmiany: mówi przy PIERWSZEJ aktywności tury, przy zmianie rodzaju
/// (myśli → narzędzie → czeka), a poza tym nie częściej niż co 20 s. Woła ją widok przy ZMIANIE treści
/// wiersza, nie przy tyknięciu licznika — inaczej długie myślenie wracałoby co 20 s samo z siebie.
public struct ActivitySpeechGate: Sendable, Equatable {
  /// Najkrótszy odstęp między ogłoszeniami aktywności tego samego rodzaju (PWA `SPEAK_ACTIVITY_GAP_MS`).
  public static let gap: TimeInterval = 20

  /// Rodzaj ostatnio WIDZIANEJ aktywności (nie ogłoszonej) — od niej liczy się zmiana rodzaju.
  private var previous: ActivityKind?
  private var spokenAt: Date?

  public init() {}

  /// Nowa treść wiersza; `true` = powiedz ją. `nil` = wiersz pusty (koniec tury): następna aktywność
  /// jest znów pierwsza.
  public mutating func shouldSpeak(_ kind: ActivityKind?, now: Date) -> Bool {
    guard let kind else {
      previous = nil
      spokenAt = nil
      return false
    }
    defer { previous = kind }
    guard kind != .idle else { return false }
    let speak: Bool =
      if let previous, let spokenAt { previous != kind || now.timeIntervalSince(spokenAt) >= Self.gap } else { true }
    if speak { spokenAt = now }
    return speak
  }
}

/// Bramka „nowa karta decyzji": karta, która stanęła W TRAKCIE wizyty na ekranie sesji, dostaje jedno
/// zdanie (rodzaj i narzędzie z nagłówka karty). Karty zastane przy wejściu nie — ekran mówi o nich
/// sam, a czytnik po zmianie ekranu i tak czyta od góry. Przed pierwszym stanem transkryptu (szkielet)
/// bramka czeka: karta, która przyjdzie razem z treścią, też jest zastana.
public struct DecisionCardSpeech: Sendable, Equatable {
  /// Tożsamość karty rozróżnia dwa zdarzenia z takim samym nagłówkiem.
  public struct Event: Sendable, Equatable {
    public let id: String
    public let text: String
  }
  /// Karty decyzji ostatniego renderu; `nil` = jeszcze nie było stanu do porównania.
  private var known: Set<String>?

  public init() {}

  /// Zdania dla kart nowych od poprzedniego renderu, w kolejności transkryptu; karta w doku (`docked`) na końcu.
  /// Karta zastana w doku mówi raz, przy pierwszym stanie: dok stoi na dole ekranu, więc czytanie od góry dochodzi do
  /// niej ostatnie. Karta, która przeszła z transkryptu do doku (ten sam wiersz), nowa nie jest.
  public mutating func newCards(in rows: [TranscriptRow], docked: TranscriptRow? = nil) -> [Event] {
    guard !rows.contains(.loading) else { return [] }
    let cards = (rows + (docked.map { [$0] } ?? [])).compactMap(Self.card)
    let ids = Set(cards.map(\.id))
    defer { known = ids }
    guard let known else { return docked.flatMap(Self.card).map { [$0] } ?? [] }
    return cards.filter { !known.contains($0.id) }
  }

  private static func card(_ row: TranscriptRow) -> Event? {
    switch row {
    case let .permission(card): Event(id: row.id, text: UICopy.newDecisionSpoken(card.spokenHeader))
    case let .question(card): card.held ? nil : Event(id: row.id, text: UICopy.newDecisionSpoken(card.spokenHeader))
    case let .herdrDialog(card): Event(id: row.id, text: UICopy.newDecisionSpoken(card.spokenHeader))
    default: nil
    }
  }
}
