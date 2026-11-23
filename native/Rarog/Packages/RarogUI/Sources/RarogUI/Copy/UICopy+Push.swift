import Foundation
import RarogCore

// Copy powiadomień APNs. Właściciel: push. Sukces
// mówi apka dopiero po ODEBRANYM pushu próbnym, więc zdanie jest o tym, co się stało, nie o prośbie.
extension UICopy {
  /// „Na tym urządzeniu": zgoda jest per instalacja, iPhone i iPad włączają się osobno.
  public static var pushPrompt: String { L("push.prompt") }
  public static var pushEnable: String { L("push.enable") }
  /// Systemowe pytanie o zgodę stoi na ekranie.
  public static var pushEnabling: String { L("push.enabling") }
  /// „×" — tydzień ciszy, nie „nigdy więcej".
  public static var pushSnooze: String { L("push.snooze") }

  /// Dymek po „Włącz".
  public static func pushNotice(_ kind: PushNotice.Kind) -> String {
    switch kind {
    case .working: L("push.notice.working")
    case .testMissing: L("push.notice.testMissing")
    case .denied: L("push.notice.denied")
    case .failed: L("push.notice.failed")
    }
  }
}
