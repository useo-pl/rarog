import RarogContract

/// Globalny stan zgodności apki z serwerem (`docs/implementation-spec.md`, "Native client build threshold").
///
/// W `tooOld` i `protocolMismatch` apka CZYTA, ale każda mutacja jest odmową z banerem;
/// wyjątki (logowanie, log diagnostyczny, obecność) zna bramka transportu.
public enum Compatibility: Sendable, Equatable {
  /// Przed pierwszym `hello` strumienia globalnego.
  case unknown
  case ok
  /// `build < hello.minClientBuild` — „zaktualizuj apkę".
  case tooOld(minClientBuild: Int)
  /// `hello.protocolVersion != 3` (porównanie ścisłe). Kierunek: serwer nowszy → zaktualizuj apkę; apka nowsza →
  /// zaktualizuj serwer (``ServerRelease/installAndUpdateCommand``; sam `rarog restart` nie podniesie protokołu).
  /// Połączenia NIE zrywamy.
  case protocolMismatch(server: Int)

  /// Ocena po `hello`. Niezgodność protokołu wygrywa z progiem buildu: przy innym protokole
  /// próg może znaczyć co innego.
  public static func evaluate(_ hello: HelloEvent, build: Int) -> Compatibility {
    if hello.protocolVersion != CoreLimits.protocolVersion {
      return .protocolMismatch(server: hello.protocolVersion)
    }
    if let minimum = hello.minClientBuild, build < minimum {
      return .tooOld(minClientBuild: minimum)
    }
    return .ok
  }

  /// Zdanie odmowy przy niezgodności TRWAŁEJ (`tooOld`, `protocolMismatch`) z kierunkiem lekarstwa;
  /// `nil` przy `ok` i `unknown`. Wejście terminala blokuje wyłącznie ono.
  public var permanentRefusal: String? {
    switch self {
    case .ok, .unknown: nil
    case .tooOld: CoreCopy.updateApp
    case let .protocolMismatch(server):
      server > CoreLimits.protocolVersion ? CoreCopy.updateApp : CoreCopy.updateServer
    }
  }

  /// `true` = serwer jest nowszy niż ta apka (lekarstwo: aktualizacja apki).
  public var serverIsNewer: Bool {
    switch self {
    case .tooOld: true
    case let .protocolMismatch(server): server > CoreLimits.protocolVersion
    case .unknown, .ok: false
    }
  }
}
