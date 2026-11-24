import Foundation
import RarogContract
import RarogCore

// Arkusz „Limity”: sekcja maszyny serwera z wierszem aktualizacji. Wiersz w stopce listy: `UICopy+List`
// (`serverUpdate`); its popover with the update steps: `serverUpdateSheet…` below. Właściciel: lista.
extension UICopy {
  /// „Serwer 0.1.0 jest starszy niż apka (1.0.0). Zaktualizuj go na Macu:
  /// npm i -g @rarog/server@latest && rarog update”; from server `0.1.1` on the command is just `rarog update`. The command is not copy
  /// (``ServerUpdate/command``).
  public static func serverUpdateDetail(_ update: ServerUpdate, _ machine: ServerMachine) -> String {
    machine == .mac
      ? L("usage.serverUpdate.detail", update.server, update.release, update.command)
      : L("usage.serverUpdate.detail.vps", update.server, update.release, update.command)
  }

  /// Title of the popover of the footer's update row (`ServerUpdateSheet`).
  static var serverUpdateSheetTitle: String { L("list.serverUpdateSheet.title") }

  /// "Server 0.1.0 is older than this app (1.0.0). Run this in a terminal on the Mac:"; the command follows on its
  /// own line.
  static func serverUpdateSheetIntro(_ update: ServerUpdate, _ machine: ServerMachine) -> String {
    machine == .mac
      ? L("list.serverUpdateSheet.intro", update.server, update.release)
      : L("list.serverUpdateSheet.intro.vps", update.server, update.release)
  }

  /// Under the command: it installs the newest server and restarts it; the row goes away after the restart.
  static var serverUpdateSheetAfter: String { L("list.serverUpdateSheet.after") }
}
