import Foundation

// Key events of the shortcut sheet: a hardware key code and its state turned into what the hold machine
// (`CommandHold`) needs. No GameController here: the app passes `GCKeyCode.rawValue`, which is the HID usage of the
// keyboard page, so the logic and its tests run on macOS. Owner: shortcuts.

/// Which Cmd key.
public enum CommandSide: Sendable, Hashable {
  case left, right
}

/// One key change. Every key except the left and right Cmd, also Shift, Option and Control, is another key.
public enum CommandKeyEvent: Sendable, Equatable {
  case commandDown(CommandSide)
  case commandUp(CommandSide)
  case otherKeyDown(Int)
  case otherKeyUp(Int)

  /// HID usage of the left Cmd key (keyboard page 0x07, Left GUI), `GCKeyCode.leftGUI.rawValue`.
  public static let leftCommandUsage = 0xE3
  /// HID usage of the right Cmd key (Right GUI), `GCKeyCode.rightGUI.rawValue`.
  public static let rightCommandUsage = 0xE7

  /// `usage`: the HID usage of the key (`GCKeyCode.rawValue`); `pressed`: down or up.
  public init(usage: Int, pressed: Bool) {
    switch usage {
    case Self.leftCommandUsage: self = pressed ? .commandDown(.left) : .commandUp(.left)
    case Self.rightCommandUsage: self = pressed ? .commandDown(.right) : .commandUp(.right)
    default: self = pressed ? .otherKeyDown(usage) : .otherKeyUp(usage)
    }
  }
}
