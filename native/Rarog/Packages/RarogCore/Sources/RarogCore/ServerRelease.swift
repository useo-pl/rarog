import Foundation

// Wersja serwera wydana razem z apką. Apka nie pyta rejestru npm: zna wersję serwera ze swojego wydania, a gdy
// serwer, z którym rozmawia, jest od niej starszy, stopka listy pokazuje cichy wiersz „Dostępna aktualizacja serwera”.
// Bez ruchu sieciowego poza sondą `GET /api/version`, którą apka i tak wysyła. Właściciel: aktywność i lista.

/// Wydanie serwera, z którym wyszła ta apka.
public enum ServerRelease {
  /// Pole `version` z `package.json` korzenia repo w chwili wydania. Podbicie wersji serwera podbija tę stałą w tym
  /// samym commicie: strażnik `server/test/wersja-apki-i-serwera.test.ts` porównuje oba zapisy.
  public static let version = "1.0.1"

  /// First package version with `rarog update`: the first version after `0.1.0`. Only the triple counts: a local
  /// build `0.1.1-local.…` from the clone already has `rarog update`.
  public static let updateCommandSince = "0.1.1"

  /// Update of a server that has `rarog update`. A command, not copy: no language variants.
  public static let updateOnlyCommand = "rarog update"

  /// Full chain: install from the registry, then `rarog update`. For a server below the threshold and where the server
  /// version is unknown (refusal for an older protocol, ``CoreCopy/updateServer``). A command, not copy.
  /// The package is `@rarog/server`; the guard `server/test/wersja-apki-i-serwera.test.ts` compares the name
  /// with `RAROG_PACKAGE_NAME` of the server.
  public static let installAndUpdateCommand = "npm i -g @rarog/server@latest && \(updateOnlyCommand)"

  /// Update command for the server version from the probe (`docs/distribution.md`, "Server update indicator"): from
  /// ``updateCommandSince`` just `rarog update`, below it the full chain, unreadable or missing version → `nil` (no
  /// hint).
  public static func updateCommand(server: String?) -> String? {
    guard let server, let current = SemanticVersion(server), let since = SemanticVersion(updateCommandSince) else {
      return nil
    }
    return current.core.lexicographicallyPrecedes(since.core) ? installAndUpdateCommand : updateOnlyCommand
  }
}

/// Serwer starszy niż wydany z apką: wiersz w stopce listy i zdanie w sekcji maszyny arkusza „Limity”.
public struct ServerUpdate: Sendable, Equatable {
  /// Wersja z ostatniej udanej sondy bieżącego serwera.
  public let server: String
  /// ``ServerRelease/version`` (w testach dowolna).
  public let release: String
  /// ``ServerRelease/updateCommand(server:)`` for ``server``.
  public let command: String

  /// `nil`, gdy wersji serwera nie ma, któraś wersja jest nieczytelna albo serwer nie jest starszy.
  public init?(server: String?, release: String) {
    guard let server, let current = SemanticVersion(server), let shipped = SemanticVersion(release),
      current < shipped, let command = ServerRelease.updateCommand(server: server)
    else { return nil }
    self.server = server
    self.release = release
    self.command = command
  }
}

extension AppState {
  /// Wiersz „Dostępna aktualizacja serwera”: wersja serwera z sondy mniejsza niż ``ServerRelease/version``.
  public var serverUpdate: ServerUpdate? { ServerUpdate(server: serverVersion, release: ServerRelease.version) }
}

/// Wersja według semver 2.0.0: `major.minor.patch`, opcjonalne wydanie próbne po `-`, dopisek po `+` pominięty.
/// Zapis spoza tej gramatyki (prefiks `v`, brak pola, puste pole, zero wiodące w polu liczbowym rdzenia albo wydania
/// próbnego, liczba ponad `Int`) jest nieczytelny. Dopisek po `+` ma tylko składnię pól, zera wiodące wolno w nim pisać.
struct SemanticVersion: Comparable {
  enum Identifier: Comparable {
    /// Pole liczbowe; w semver mniejsze od każdego pola z literami.
    case number(Int)
    case text(String)
  }

  let core: [Int]
  /// Puste = wydanie, które jest większe od każdego wydania próbnego tej samej trójki.
  let prerelease: [Identifier]

  init?(_ text: String) {
    let withoutBuild = text.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false)
    guard let main = withoutBuild.first, withoutBuild.count == 1 || Self.isIdentifierList(withoutBuild[1]) else {
      return nil
    }
    let parts = main.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
    let numbers = parts[0].split(separator: ".", omittingEmptySubsequences: false)
    guard numbers.count == 3 else { return nil }
    var core: [Int] = []
    for field in numbers {
      guard Self.isNumber(field), let value = Int(field) else { return nil }
      core.append(value)
    }
    var prerelease: [Identifier] = []
    if parts.count == 2 {
      guard Self.isIdentifierList(parts[1]) else { return nil }
      for field in parts[1].split(separator: ".") {
        if Self.isDigits(field) {
          guard Self.isNumber(field), let value = Int(field) else { return nil }
          prerelease.append(.number(value))
        } else {
          prerelease.append(.text(String(field)))
        }
      }
    }
    self.core = core
    self.prerelease = prerelease
  }

  static func < (lhs: SemanticVersion, rhs: SemanticVersion) -> Bool {
    if lhs.core != rhs.core { return lhs.core.lexicographicallyPrecedes(rhs.core) }
    switch (lhs.prerelease.isEmpty, rhs.prerelease.isEmpty) {
    case (true, _): return false
    case (false, true): return true
    case (false, false): return lhs.prerelease.lexicographicallyPrecedes(rhs.prerelease)
    }
  }

  private static func isDigits(_ field: Substring) -> Bool {
    !field.isEmpty && field.allSatisfy { $0.isASCII && $0.isNumber }
  }

  /// Pole liczbowe semver: same cyfry, bez zera wiodącego (`0` tak, `01` i `00` nie).
  private static func isNumber(_ field: Substring) -> Bool {
    isDigits(field) && (field.count == 1 || field.first != "0")
  }

  /// Pola po kropce, każde niepuste, ze znaków `[0-9A-Za-z-]`.
  private static func isIdentifierList(_ list: Substring) -> Bool {
    let fields = list.split(separator: ".", omittingEmptySubsequences: false)
    return fields.allSatisfy { field in
      !field.isEmpty && field.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
    }
  }
}
