import RarogContract
@testable import RarogCore
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// The pairing card (`PairingFlowCard`) while the relay has not admitted a freshly sponsored server yet:
/// `waitingForRelay` shows the waiting text and "Cancel" (`pair.cancel`), and "Cancel" ends the wait
/// through `cancelPairing`. `.pairing` keeps its busy row without "Cancel". The assertions read the same functions the
/// view draws from (`PairingFlowCard.detail`, `PairingFlowCard.controls`), because the SwiftUI accessibility tree of
/// this test process is empty (see `SettingsSheetServerTests`).
@MainActor
final class PairingControlsRelayTests: XCTestCase {
  static let address = URL(string: "https://rarog.example.ts.net")!
  static let code = "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ"

  func testWaitingForRelayShowsWaitingTextAndCancel() async throws {
    let rig = try SettingsSheetServerTests.Rig(page: nil)
    defer { rig.close() }
    let link = PairingLink(target: .https(Self.address), code: Self.code)
    rig.store.dispatch(.pairing(.waitingForRelay(link, until: Date().addingTimeInterval(60))))
    try await rig.settle()
    let flow = rig.store.state.pairing.flow
    XCTAssertEqual(PairingFlowCard.detail(flow), "Czekam, aż relay wpuści serwer…")
    XCTAssertEqual(PairingFlowCard.controls(flow), [.waiting, .cancel])
    XCTAssertEqual(PairingCardControl.cancel.identifier, "pair.cancel")
  }

  func testCancelWhileWaitingEndsTheWait() async throws {
    let rig = try SettingsSheetServerTests.Rig(page: nil)
    defer { rig.close() }
    let link = PairingLink(target: .https(Self.address), code: Self.code)
    rig.store.dispatch(.pairing(.waitingForRelay(link, until: Date().addingTimeInterval(60))))
    try await rig.settle()
    PairingFlowCard.cancel(rig.store)
    try await rig.settle()
    XCTAssertEqual(rig.store.state.pairing.flow, .idle)
  }

  func testPairingKeepsBusyRowWithoutCancel() async throws {
    let rig = try SettingsSheetServerTests.Rig(page: nil)
    defer { rig.close() }
    rig.store.dispatch(.pairing(.started(PairingLink(target: .https(Self.address), code: Self.code))))
    try await rig.settle()
    let flow = rig.store.state.pairing.flow
    XCTAssertNil(PairingFlowCard.detail(flow))
    XCTAssertEqual(PairingFlowCard.controls(flow), [.busy])
    PairingFlowCard.cancel(rig.store)
    XCTAssertEqual(rig.store.state.pairing.flow, flow, "“Cancel” does not stop a request in flight")
  }

  func testOtherFlowsKeepTheirControls() throws {
    let link = PairingLink(target: .https(Self.address), code: Self.code)
    XCTAssertEqual(PairingFlowCard.controls(.confirming(link)), [.confirm, .cancel])
    XCTAssertEqual(PairingFlowCard.controls(.failed(link, .offline)), [.retry, .cancel])
  }
}
