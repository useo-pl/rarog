// swift-tools-version:6.2
// Adapter iroh natywnej apki: JEDYNY pakiet, który importuje IrohLib (biblioteka statyczna z iroh-ffi, ok. 25 MB
// na plasterek). `IrohTunnelTransport` i `IrohSigner` spełniają protokoły tunelu z `RarogTransport`
// (`Tunnel/TunnelTypes.swift`); reszta apki widzi tylko te protokoły i linkuje ten pakiet wyłącznie w celu apki,
// więc rozszerzenia i `swift test` innych pakietów nie ciągną IrohLib.
//
// IrohLib przypięty `exact: "1.2.0"`: gotowy xcframework z wydania n0 (zip z sumą SHA-256 w manifeście iroh-ffi).
// Testy żywe (`IrohLiveTests`, dwa endpointy w jednym procesie, bez relaya) włącza `RAROG_TEST_IROH=1`; `bind`
// w sandboksie Claude Code pada na monitorze sieci, więc te testy idą poza nim.
import PackageDescription

let package = Package(
  name: "RarogIroh",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "RarogIroh", targets: ["RarogIroh"]),
  ],
  dependencies: [
    .package(url: "https://github.com/n0-computer/iroh-ffi", exact: "1.2.0"),
    .package(path: "../RarogContract"),
    .package(path: "../RarogTransport"),
  ],
  targets: [
    .target(
      name: "RarogIroh",
      dependencies: [
        .product(name: "IrohLib", package: "iroh-ffi"),
        .product(name: "RarogTransport", package: "RarogTransport"),
      ]
    ),
    .testTarget(
      name: "RarogIrohTests",
      dependencies: [
        "RarogIroh",
        .product(name: "IrohLib", package: "iroh-ffi"),
        .product(name: "RarogContract", package: "RarogContract"),
        // Tylko testy: wektory podpisu z `shared/fixtures/relay-auth/manifest.json` (`IrohSignerVectorTests`).
        .product(name: "RarogContractFixtures", package: "RarogContract"),
        .product(name: "RarogTransport", package: "RarogTransport"),
      ]
    ),
  ],
  swiftLanguageModes: [.v6]
)
