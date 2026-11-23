#if os(iOS)
import GameController
import UIKit

/// Stan klawiszy klawiatury sprzętowej wg `GCKeyboard` — JEDYNE miejsce, które o niego pyta (strażnik
/// `SessionSwitcherSourceTests`). UIKit nie zawsze dowozi puszczenie klawisza: do kontenera terminala `pressesEnded`
/// nie dochodzi (ślady „zapas GCKeyboard" z iPada), więc powierzchnia terminala pyta tu o stan klawisza serii. Sama
/// obecność klawiatury (`GCKeyboard.coalesced != nil`) zostaje tam, gdzie jest.
///
/// Key changes (the shortcut sheet): one `keyChangedHandler` subscription, set when the first listener comes
/// and again on every `GCKeyboardDidConnect` (the coalesced keyboard can be `nil` for a moment after connecting).
/// Each change goes to the listeners on the main queue as a `CommandKeyEvent`; the rest of the app gets events, not
/// `GCKeyboard`.
@MainActor
public enum HardwareKeys {
  /// Czy klawisz jest wciśnięty; `nil` = nie wiadomo (brak klawiatury sprzętowej).
  public static func isPressed(_ key: UIKeyboardHIDUsage) -> Bool? {
    GCKeyboard.coalesced?.keyboardInput?.button(forKeyCode: GCKeyCode(rawValue: CFIndex(key.rawValue)))?.isPressed
  }

  /// Whether a Cmd key is down, the left or the right one; `nil` = no hardware keyboard.
  public static func commandPressed() -> Bool? {
    let left = isPressed(.keyboardLeftGUI)
    let right = isPressed(.keyboardRightGUI)
    if left == nil, right == nil { return nil }
    return left == true || right == true
  }

  // MARK: Key changes

  private static var listeners: [ObjectIdentifier: @MainActor (CommandKeyEvent) -> Void] = [:]
  private static var connectObserver: NSObjectProtocol?

  /// `listener` gets every key change until ``removeKeyListener(_:)`` with the same owner.
  static func addKeyListener(_ owner: AnyObject, _ listener: @escaping @MainActor (CommandKeyEvent) -> Void) {
    listeners[ObjectIdentifier(owner)] = listener
    if connectObserver == nil {
      connectObserver = NotificationCenter.default.addObserver(
        forName: .GCKeyboardDidConnect, object: nil, queue: .main
      ) { note in
        // Delivered on the main queue (`queue: .main`), so the keyboard does not cross threads.
        nonisolated(unsafe) let keyboard = note.object as? GCKeyboard
        MainActor.assumeIsolated { subscribe(keyboard) }
      }
    }
    subscribe(nil)
  }

  static func removeKeyListener(_ owner: AnyObject) {
    listeners[ObjectIdentifier(owner)] = nil
  }

  /// Sets the one handler on the connected keyboard (the notification's object, else the coalesced keyboard).
  private static func subscribe(_ keyboard: GCKeyboard?) {
    (keyboard ?? GCKeyboard.coalesced)?.keyboardInput?.keyChangedHandler = handler()
  }

  /// Built outside the main actor: GameController calls it on its handler queue, so the closure must not inherit the
  /// main actor's isolation. The change goes to the main queue in arrival order.
  nonisolated private static func handler() -> GCKeyboardValueChangedHandler {
    { _, _, keyCode, pressed in
      let event = CommandKeyEvent(usage: Int(keyCode.rawValue), pressed: pressed)
      DispatchQueue.main.async {
        MainActor.assumeIsolated { deliver(event) }
      }
    }
  }

  private static func deliver(_ event: CommandKeyEvent) {
    for listener in listeners.values { listener(event) }
  }
}
#endif
