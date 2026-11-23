// swift-tools-version:6.2
// Rdzeń natywnej apki: magazyn stanu `@Observable`, czyste reduktory ramek SSE, pętla
// połączenia, stan zgodności, trwała kolejka wysyłki, obecność i raport `kontrakt:`. Bez UIKit —
// `swift test` na macOS. Transport wchodzi przez protokół `RarogTransporting` (atrapa w testach).
// Copy: katalog `Copy/Localizable.xcstrings` (`docs/localization.md`); język źródłowy `en`.
import PackageDescription

let package = Package(
  name: "RarogCore",
  defaultLocalization: "en",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "RarogCore", targets: ["RarogCore"]),
  ],
  dependencies: [
    .package(path: "../RarogContract"),
    .package(path: "../RarogTransport"),
    // Tylko testy: adres tapnięcia kafla Live Activity składa `RarogActivity`, czyta `PushRouting` —
    // test sprawdza, że jedno rozumie drugie. Biblioteka `RarogCore` od `RarogActivity` NIE zależy.
    .package(path: "../RarogActivity"),
  ],
  targets: [
    .target(
      name: "RarogCore",
      dependencies: [
        .product(name: "RarogContract", package: "RarogContract"),
        .product(name: "RarogTransport", package: "RarogTransport"),
      ],
      resources: [.process("Copy/Localizable.xcstrings")]
    ),
    .testTarget(
      name: "RarogCoreTests",
      dependencies: [
        "RarogCore",
        .product(name: "RarogContract", package: "RarogContract"),
        .product(name: "RarogContractFixtures", package: "RarogContract"),
        .product(name: "RarogTransport", package: "RarogTransport"),
        // Atrapa tunelu iroh i zegar sztuczny dla testów przełącznika transportu nad prawdziwym runtime'em.
        .product(name: "RarogTransportTesting", package: "RarogTransport"),
        .product(name: "RarogActivity", package: "RarogActivity"),
      ],
      // Snapshot of the catalog keys (`CopyCatalogTests`): test data, not a package resource.
      exclude: ["Fixtures"]
    ),
  ],
  swiftLanguageModes: [.v6]
)
