import Testing

@testable import RarogTransport

@Suite("network path: reconnect decision and the client log line")
struct NetworkPathSnapshotTests {
  private let wifi = NetworkPathSnapshot.Interface(type: "wifi", name: "en0")
  private let vpn = NetworkPathSnapshot.Interface(type: "other", name: "utun4")

  private func path(
    satisfied: Bool = true, _ interfaces: [NetworkPathSnapshot.Interface], expensive: Bool = false,
    gateways: [String] = ["192.0.2.1:0"]
  ) -> NetworkPathSnapshot {
    NetworkPathSnapshot(satisfied: satisfied, interfaces: interfaces, expensive: expensive, gateways: gateways)
  }

  @Test("the first report is the starting state: no reconnect, no line")
  func firstReport() {
    let start = path([wifi])
    #expect(!start.reconnects(after: nil))
    #expect(start.changeLine(after: nil) == nil)
  }

  @Test("an equal report, or an interface renamed with the same type: no reconnect, no line")
  func equalPath() {
    let renamed = path([wifi, .init(type: "other", name: "utun5")])
    #expect(!renamed.reconnects(after: path([wifi, vpn])))
    #expect(renamed.changeLine(after: path([wifi, vpn])) == nil)
  }

  @Test("a VPN interface comes up on a satisfied path: reconnect, the line names both interface lists")
  func vpnInterface() {
    let after = path([wifi, vpn])
    #expect(after.reconnects(after: path([wifi])))
    #expect(
      after.changeLine(after: path([wifi]))
        == "network: path satisfied, changed interfaces wifi(en0) → wifi(en0),other(utun4); now wifi(en0),other(utun4) → reconnect")
  }

  @Test("the path loses the network: a line, no reconnect; the network back: a line and a reconnect")
  func unsatisfiedAndBack() {
    let lost = path(satisfied: false, [], gateways: [])
    #expect(!lost.reconnects(after: path([wifi])))
    #expect(
      lost.changeLine(after: path([wifi]))
        == "network: path unsatisfied, changed status; interfaces wifi(en0) → none; gateways 1 → 0; now none → no reconnect")
    let back = path([wifi])
    #expect(back.reconnects(after: lost))
    #expect(back.changeLine(after: lost)?.hasSuffix("→ reconnect") == true)
  }

  @Test("another gateway with the same count: reconnect, the line gives the count, never the address")
  func gatewayOnly() {
    let after = path([wifi], gateways: ["192.0.2.254:0"])
    let line = after.changeLine(after: path([wifi]))
    #expect(after.reconnects(after: path([wifi])))
    #expect(line == "network: path satisfied, changed gateways 1 → 1; now wifi(en0) → reconnect")
    #expect(line?.contains("192.0.2") == false)
  }

  @Test("isExpensive alone, also flapping on one cellular interface: a line, no reconnect")
  func expensiveOnly() {
    let cellular = NetworkPathSnapshot.Interface(type: "cellular", name: "pdp_ip0")
    let cheap = path([cellular])
    let expensive = path([cellular], expensive: true)
    #expect(!expensive.reconnects(after: cheap))
    #expect(!cheap.reconnects(after: expensive))
    #expect(
      expensive.changeLine(after: cheap)
        == "network: path satisfied, changed expensive false → true; now cellular(pdp_ip0) → no reconnect")
  }

  @Test("isExpensive together with another gateway: reconnect, the line names both")
  func expensiveWithGateway() {
    let after = path([wifi], expensive: true, gateways: ["192.0.2.254:0"])
    #expect(after.reconnects(after: path([wifi])))
    #expect(
      after.changeLine(after: path([wifi]))
        == "network: path satisfied, changed expensive false → true; gateways 1 → 1; now wifi(en0) → reconnect")
  }
}
