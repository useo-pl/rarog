import Foundation

// Renaming a session in place on the list row. Owner: list.
extension UICopy {
  /// Context menu item of an agent row.
  public static var renameSession: String { L("list.rename") }
  /// VoiceOver label of the field that replaces the row.
  public static var renameFieldLabel: String { L("list.renameFieldLabel") }
  /// Counter under the field: "12 / 28".
  public static func renameCounter(_ count: Int, limit: Int) -> String { L("list.renameCounter", count, limit) }
  /// Keys under the field with a hardware keyboard.
  public static var renameHint: String { L("list.renameHint") }
  /// Gestures under the field without a hardware keyboard: touch has no Esc.
  public static var renameHintTouch: String { L("list.renameHintTouch") }
  /// The button at the end of the field's line without a hardware keyboard: it closes the field as Esc does.
  public static var renameCancel: String { L("list.renameCancel") }
  /// Sentence card after a rename the server did not confirm in time.
  public static var renameTimedOut: String { L("list.renameTimedOut") }

  /// Sentence card after a refused rename message: the server's reason, or a plain one without it.
  public static func renameRefused(_ reason: String?) -> String {
    let reason = reason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return L("list.renameRefused", reason.isEmpty ? L("list.renameNotSent") : reason)
  }
}
