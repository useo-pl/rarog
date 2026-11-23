import Foundation
import IrohLib
import RarogTransport

/// Podpis Ed25519 kluczem iroh apki: ten sam klucz tajny co endpoint, więc `endpointId` to klucz publiczny podpisu.
public struct IrohSigner: TunnelSigner {
  private let secret: SecretKey
  /// Klucz publiczny jako EndpointId: 64 znaki hex, małe litery.
  public let endpointId: String

  /// Klucz tajny 32 B; inny rozmiar → `TunnelFailure.unavailable`.
  public init(secretKey: Data) throws {
    do { secret = try SecretKey.fromBytes(bytes: secretKey) } catch {
      throw TunnelFailure.unavailable("identity: \(IrohFailure.describe(error))")
    }
    endpointId = secret.public().description
  }

  /// Podpis 64 B.
  public func sign(_ message: Data) throws -> Data {
    secret.sign(message: message).toBytes()
  }
}
