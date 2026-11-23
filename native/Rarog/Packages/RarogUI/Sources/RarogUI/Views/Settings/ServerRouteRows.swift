import Foundation
import RarogCore

// The server's routes on the "Server" page (`SettingsServerPage`): the HTTPS address, and the iroh pair as a row
// labelled "iroh" with the first 8 characters of the EndpointId, instead of the address on an iroh-only server and under it on
// a server with both. No SwiftUI, so `swift test` checks the rows on macOS (`ServerRouteRowsTests`). The iroh pair
// arrives in place (`PairingEvent.routesUpdated`): the rows are computed from ``PairedServer`` on every render, while
// the pairing code and the device list live in other state fields.

/// A route row: label, value (address or short EndpointId) and accessibility identifier.
struct ServerRouteRow: Equatable, Sendable {
  let label: String
  let value: String
  let identifier: String
}

enum ServerRouteRows {
  /// The rows of the bound server; none without a server (the screen then says `pairing.serverNone`).
  static func rows(_ binding: ServerBinding) -> [ServerRouteRow] {
    guard case let .device(server) = binding else { return [] }
    return rows(url: server.url, irohEndpointId: server.iroh?.endpointId)
  }

  /// The address and iroh rows in this order; a server with neither route (impossible after the stored credential's
  /// validation) has none.
  static func rows(url: URL?, irohEndpointId: String?) -> [ServerRouteRow] {
    var rows: [ServerRouteRow] = []
    if let url {
      rows.append(ServerRouteRow(label: UICopy.serverAddress, value: url.absoluteString, identifier: "settings.address"))
    }
    if let irohEndpointId {
      rows.append(ServerRouteRow(
        label: UICopy.settingsIrohLabel, value: UICopy.irohShort(irohEndpointId), identifier: "settings.iroh"))
    }
    return rows
  }
}
