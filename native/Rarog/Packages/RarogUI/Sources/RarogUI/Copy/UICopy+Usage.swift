import Foundation
import RarogContract
import RarogCore

// Arkusz „Limity”: sekcja maszyny serwera z wierszem aktualizacji. Wiersz w stopce listy: `UICopy+List`
// (`serverUpdate`). Właściciel: lista.
extension UICopy {
  /// „Serwer 0.1.0 jest starszy niż apka (1.0.0). Zaktualizuj go na Macu:
  /// npm i -g @rarog/server@latest && rarog update”; from server `0.1.1` on the command is just `rarog update`. The command is not copy
  /// (``ServerUpdate/command``).
  public static func serverUpdateDetail(_ update: ServerUpdate, _ machine: ServerMachine) -> String {
    machine == .mac
      ? L("usage.serverUpdate.detail", update.server, update.release, update.command)
      : L("usage.serverUpdate.detail.vps", update.server, update.release, update.command)
  }
}
