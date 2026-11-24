import Foundation

// Rejestr copy rdzenia (`docs/localization.md`): zdania, które oddaje rdzeń, a rysuje RarogUI.

/// Zdania odmów bramek. Mieszkają w rdzeniu, bo `MutationPolicy` oddaje zdanie; reszta copy
/// (karty, banery, pole wiadomości) należy do RarogUI. Logika nie porównuje tych zdań: to, czy odmowa minie
/// sama, niesie `PolicyRefusal.transient`.
public enum CoreCopy {
  public static var noConnection: String { L("core.noConnection") }
  public static var updateApp: String { L("core.updateApp") }
  /// Apka nowsza niż serwer: lekarstwem jest aktualizacja serwera. This refusal does not know the server version,
  /// so it carries the full chain with the install of the app's channel. The command is not copy
  /// (``ServerRelease/unknownServerCommand(release:)``).
  public static var updateServer: String { updateServer(release: ServerRelease.version) }

  /// ``updateServer`` for the app release `release` (tests pass a beta version).
  public static func updateServer(release: String) -> String {
    L("core.updateServer", ServerRelease.unknownServerCommand(release: release))
  }
  public static var unsupportedSession: String { L("core.unsupportedSession") }
}
