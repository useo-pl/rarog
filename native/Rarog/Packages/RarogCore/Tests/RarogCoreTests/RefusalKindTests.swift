import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Testing

// Odmowa bramki niesie, czy minie sama (`PolicyRefusal.transient`), i tylko to pole decyduje o losie próby
// terminala — nie treść zdania, które zależy od języka apki.
@Suite("odmowa bramki: przejściowa albo trwała po polu, nie po zdaniu")
@MainActor
struct RefusalKindTests {
  @Test("POST /api/term: odmowa przejściowa ponawia, trwała staje — niezależnie od treści zdania")
  func terminalOpenFailureFollowsFlag() {
    let transient = MutationRefusal(gate: .compatibility, message: "dowolne zdanie", transient: true)
    #expect(TerminalSession.openFailure(.refused(transient)) == .transient(maybeProcessed: false))
    let permanent = MutationRefusal(gate: .compatibility, message: CoreCopy.noConnection)
    #expect(TerminalSession.openFailure(.refused(permanent)) == .incompatible(CoreCopy.noConnection))
  }

  @Test("bez hello: bramka zgodności odmawia przejściowo zdaniem o braku połączenia, wejście terminala wolne")
  func noHelloIsTransient() async {
    let rules = MutationRules(timing: CoreTiming(compatWait: .milliseconds(20)))
    #expect(await rules.compatibilityRefusal() == PolicyRefusal(CoreCopy.noConnection, transient: true))
    #expect(await rules.terminalInputRefusal() == nil)
    let gate = MutationGate(policy: rules)
    await #expect(throws: MutationRefusal(gate: .compatibility, message: CoreCopy.noConnection, transient: true)) {
      try await gate.check(method: "POST", path: "/api/term")
    }
  }
}
