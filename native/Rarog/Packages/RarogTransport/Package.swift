// swift-tools-version:6.2
// Transport natywnej apki: parser SSE na bajtach, klient REST z kluczem urządzenia i `Origin`,
// bramka mutacji. Bez UIKit — `swift test` na macOS. Zależy wyłącznie od `RarogContract`.
// Biblioteka `RarogTransportTesting` (atrapa tunelu iroh z usterkami i sztucznym zegarem) służy WYŁĄCZNIE testom
// tego pakietu i pakietów nad nim — apka jej nie linkuje.
import PackageDescription

let package = Package(
  name: "RarogTransport",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "RarogTransport", targets: ["RarogTransport"]),
    .library(name: "RarogTransportTesting", targets: ["RarogTransportTesting"]),
  ],
  dependencies: [
    .package(path: "../RarogContract"),
  ],
  targets: [
    .target(
      name: "RarogTransport",
      dependencies: [.product(name: "RarogContract", package: "RarogContract")]
    ),
    .target(name: "RarogTransportTesting", dependencies: ["RarogTransport"]),
    .testTarget(
      name: "RarogTransportTests",
      dependencies: [
        "RarogTransport",
        "RarogTransportTesting",
        .product(name: "RarogContract", package: "RarogContract"),
        .product(name: "RarogContractFixtures", package: "RarogContract"),
      ]
    ),
  ],
  swiftLanguageModes: [.v6]
)
