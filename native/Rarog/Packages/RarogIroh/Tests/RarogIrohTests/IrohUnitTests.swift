import Foundation
import IrohLib
@testable import RarogIroh
import RarogTransport
import Testing

// Część adaptera bez gniazd: powód zamknięcia z napisu biblioteki, podpis kluczem iroh, odmowa klucza o złym
// rozmiarze przed `bind`. Idzie zawsze, także w sandboksie; zestaw żywy (`IrohLiveTests`) bez `RAROG_TEST_IROH=1`
// jest pominięty.

@Suite("adapter iroh bez sieci: powód zamknięcia, podpis, klucz")
struct IrohUnitTests {
  @Test("kod drugiej strony z napisu zamknięcia", arguments: [
    ("closed by peer: 3", UInt64?(3)),
    ("closed by peer: revoked (code 3)", 3),
    ("closed by peer: bye (code 0)", 0),
    ("closed by peer: 0", 0),
    ("closed by peer: a (code 1) (code 5)", 5),
    ("closed", nil),
    ("timed out", nil),
    ("closed by peer: revoked", nil),
    ("closed by peer: (code x)", nil),
    ("", nil),
  ])
  func peerCode(text: String, code: UInt64?) {
    #expect(IrohCloseReason.peerCode(text) == code)
  }

  @Test("powód zamknięcia: .closed z kodem drugiej strony i pełnym napisem")
  func closeFailure() {
    #expect(IrohCloseReason.failure("closed by peer: 3") == .closed(code: 3, reason: "closed by peer: 3"))
    #expect(IrohCloseReason.failure("closed") == .closed(code: nil, reason: "closed"))
  }

  @Test("podpis IrohSigner: 64 B, sprawdza go PublicKey.verify z EndpointId, inna treść odpada")
  func signer() throws {
    let secret = SecretKey.generate()
    let signer = try IrohSigner(secretKey: secret.toBytes())
    #expect(signer.endpointId == secret.public().description)
    #expect(signer.endpointId.count == 64)
    #expect(signer.endpointId.allSatisfy { "0123456789abcdef".contains($0) })

    let message = Data("rarog relay access".utf8)
    let signature = try signer.sign(message)
    #expect(signature.count == 64)
    let key = try EndpointId.fromString(s: signer.endpointId)
    try key.verify(message: message, signature: try Signature.fromBytes(bytes: signature))
    #expect(throws: IrohError.self) {
      try key.verify(message: Data("other".utf8), signature: try Signature.fromBytes(bytes: signature))
    }
  }

  @Test("klucz podpisu inny niż 32 B → .unavailable", arguments: [0, 31, 33, 64])
  func signerRejectsKey(count: Int) {
    #expect {
      _ = try IrohSigner(secretKey: Data(repeating: 1, count: count))
    } throws: { error in
      guard case .unavailable = error as? TunnelFailure else { return false }
      return true
    }
  }

  @Test("bind z kluczem innym niż 32 B → .bindFailed, zanim biblioteka otworzy gniazdo", arguments: [0, 16, 33])
  func bindRejectsKey(count: Int) async {
    await #expect {
      _ = try await IrohTunnelTransport().bind(secretKey: Data(count: count), homeRelay: URL(string: "https://relay.example/")!)
    } throws: { error in
      guard case .bindFailed(let message) = error as? TunnelFailure else { return false }
      return message.contains("\(count) bytes")
    }
  }

  @Test("adapter nie czeka na online(): w źródle nie ma tego wywołania")
  func noOnline() throws {
    let source = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources/RarogIroh")
    let files = try FileManager.default.contentsOfDirectory(at: source, includingPropertiesForKeys: nil)
      .filter { $0.pathExtension == "swift" }
    #expect(!files.isEmpty)
    for file in files {
      let code = try String(contentsOf: file, encoding: .utf8)
        .split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
      #expect(!code.contains { $0.contains(".online(") }, "\(file.lastPathComponent)")
    }
  }
}
