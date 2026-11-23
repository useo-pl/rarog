import Foundation
import RarogContract
import RarogCore

// Copy produktu po polsku (zdania żyją w kliencie). Źródło brzmienia:
// `docs/design.md` „Interface voice";
// natywnie poprawione tam, gdzie wymagania każą (429 i 403 mówią osobno). Zdania odmów bramek
// rdzenia (`CoreCopy`) zostają w rdzeniu — tu są tylko powtórzone przez odwołanie.
//
// Copy jest rozcięte na rozszerzenia per obszar: `UICopy+Cards`, `+Composer`, `+Header`,
// `+List`, `+Projects`, `+Shortcuts`, `+Transcript`, `+Activity`, `+Pairing`. Tu zostają zdania sieci i banery.

public enum UICopy {
  // MARK: Sieć i dostęp

  public static var appName: String { L("app.appName") }
  /// 401 klucza w miejscu bez własnego ekranu (terminal): magazyn i tak wyloguje.
  public static var deviceKeyRejected: String { L("app.deviceKeyRejected") }
  public static var serverSilent: String { L("app.serverSilent") }
  public static var timedOut: String { L("app.timedOut") }
  public static var forbiddenBody: String { L("app.forbiddenBody") }

  // MARK: Listy pozycji wyliczanych

  /// Separator listy RÓWNORZĘDNYCH pozycji — z katalogu, bo i znak, i odstępy to rzecz języka. Zdanie z członami
  /// gramatycznie powiązanymi („czeka na: X”, „X, od 4 minut”) ma własny klucz z parametrami, nie listę.
  public enum ListSeparator: Sendable {
    /// „A, B, C” — człony zdania czytnika, liczniki („2 commity do pobrania, 1 commit do wypchnięcia”).
    case comma
    /// „A · B · C” — linia metadanych na ekranie (licznik, czas, stan).
    case dot
    /// „A; B” — grupy, z których każda ma własne przecinki (limity planu, Mac dla czytnika).
    case semicolon
    /// „Zdanie. Zdanie.” — całe zdania jedno po drugim (każde z własną kropką).
    case sentence
  }

  /// Pozycje złączone separatorem z katalogu (`app.list.*`); puste pozycje zostają — filtruje wywołujący.
  public static func list(_ items: [String], _ separator: ListSeparator) -> String {
    let glue =
      switch separator {
      case .comma: L("app.list.comma")
      case .dot: L("app.list.dot")
      case .semicolon: L("app.list.semicolon")
      case .sentence: L("app.list.sentence")
      }
    return items.joined(separator: glue)
  }

  /// Fraza jako całe zdanie (znak końca zdania z katalogu): „Mac — procesor 35 procent.”
  public static func sentence(_ phrase: String) -> String { L("app.sentence", phrase) }

  // MARK: Banery

  /// - Parameter now: zegar zdania „stany sprzed X" (baner herdr).
  public static func banner(_ banner: Banner, now: Date = Date()) -> String {
    switch banner {
    case let .incompatible(compat):
      compat.serverIsNewer ? CoreCopy.updateApp : CoreCopy.updateServer
    case .connecting: L("app.banner.connecting")
    case .serverUnreachable: serverSilent
    case .transcriptStalled: L("app.banner.transcriptStalled")
    case let .herdrUnavailable(detail, staleSince):
      herdrUnavailable(detail: detail, staleSince: staleSince, now: now)
    case let .herdrReadOnly(detail):
      detail.map { L("app.banner.herdrReadOnly.detail", $0) } ?? L("app.banner.herdrReadOnly")
    case let .pushDegraded(since, reason):
      // Przyczyna od serwera mówi, co dalej — zdanie z nią zastępuje ogólne „od godziny”.
      switch reason {
      case .passMissing: L("app.banner.pushDegraded.passMissing")
      case .envMismatch: L("app.banner.pushDegraded.envMismatch")
      case nil:
        ServerTime.clock(since).map { L("app.banner.pushDegraded.since", $0) }
          ?? L("app.banner.pushDegraded")
      }
    }
  }
}
