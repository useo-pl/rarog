import Foundation
import RarogContract

// Katalog projektów: stan, zdarzenia reduktora i wyniki akcji magazynu.
// Właściciel: projekty i zakładki.

/// Ostatnie projekty z serwera (`GET /api/projects/recent`) — same ścieżki i czasy, zero treści.
public struct CatalogState: Sendable, Equatable {
  /// Najświeższy pierwszy (kolejność serwera); projekty bez żywej sesji też tu są.
  public var recent: [RecentProject] = []
  /// Kiedy ostatnio pytaliśmy o listę — dławik odświeżania (``CatalogTiming``).
  public var recentAt: Date?

  public init() {}
}

/// Zdarzenie katalogu — jedna pozycja `CoreEvent.catalog`, gałęzie w `Reducer+Catalog`.
public enum CatalogEvent: Sendable, Equatable {
  /// Żądanie poszło — dławik liczy od teraz; porażka zostawia listę ostatnią znaną.
  case recentProjectsRequested(at: Date)
  case recentProjectsLoaded([RecentProject], at: Date)
}

/// Odstępy katalogu. Lista nie jedzie strumieniem, więc odświeża się na żądanie widoku, nie
/// częściej niż co `recentRefresh`.
public enum CatalogTiming {
  public static let recentRefresh: TimeInterval = 60
}

/// Zapamiętany model i effort nowej sesji. Zapisuje go formularz nowej sesji po
/// udanym starcie; „+" i Cmd+N tylko czytają. Brak modelu = model domyślny konta.
public struct NewSessionDefaults: Sendable, Equatable, Codable {
  public var model: String?
  public var effort: EffortLevel?
  /// Effort „auto" wybrany ŚWIADOMIE w formularzu — przeżywa następne wejście, zamiast wracać
  /// do podpowiedzi `xhigh`. „+" i Cmd+N go nie czytają: brak effortu to i tak „auto".
  public var effortAuto = false
  /// „Model domyślny konta" wybrany ŚWIADOMIE w formularzu — przeżywa następne wejście, zamiast
  /// wracać do podpowiedzi `opus[1m]`. „+" i Cmd+N go nie czytają: brak modelu to i tak
  /// model konta.
  public var modelAccount = false

  public init(model: String? = nil, effort: EffortLevel? = nil) {
    self.model = model
    self.effort = effort
  }

  enum CodingKeys: String, CodingKey { case model, effort, effortAuto, modelAccount }

  // Wpis z magazynu urządzenia to dane z zewnątrz (inna wersja apki): nieznany effort przepada,
  // a nie psuje odczytu całego wpisu.
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    model = try? c.decode(String.self, forKey: .model)
    effort = (try? c.decode(String.self, forKey: .effort)).flatMap(EffortLevel.init(rawValue:))
    effortAuto = (try? c.decode(Bool.self, forKey: .effortAuto)) ?? false
    modelAccount = (try? c.decode(Bool.self, forKey: .modelAccount)) ?? false
  }
}

/// Wynik „+" / Cmd+N. Zdania składa RarogUI.
public enum CreateSessionOutcome: Sendable, Equatable {
  /// 202 — panel założony; `trustPrompt` = katalog nie był otwierany w Claude Code.
  case created(sessionId: String, trustPrompt: Bool)
  /// Zakładanie wyłączone (`canLaunch == false`): zdanie serwera (`HerdrStatus.detail`) albo `nil`.
  case blocked(String?)
  /// Odmowa bramki klienta albo serwera (400/409/429) — zdanie do pokazania wprost.
  case refused(String?)
  case offline
  case timedOut
  case failed
  case loggedOut
}

/// Wynik zamknięcia sesji.
public enum CloseSessionOutcome: Sendable, Equatable {
  case closed
  /// Codex, nieznany silnik albo sesja nieobsługiwana — „×" nie istnieje, nic nie wyszło.
  case notAllowed
  /// Odmowa serwera (409 martwe gniazdo, 404 sesji już nie ma) albo bramki klienta.
  case refused(String?)
  case offline
  case timedOut
  case failed
  case loggedOut
}
