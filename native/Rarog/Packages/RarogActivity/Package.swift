// swift-tools-version:6.2
// Live Activity natywnej apki: atrybuty aktywności dla ActivityKit, czyste copy
// ze stanu zbiorczego (`LiveActivityPresentation`) i widoki SwiftUI kafla (ekran blokady, Dynamic
// Island). Linkują go apka (start aktywności i zapis liczników; pełną treść wysyła serwer) i rozszerzenie
// `RarogWidgets` (rysuje kafel) — rozszerzenie NIE linkuje rdzenia ani transportu. Zależy wyłącznie od
// `RarogContract`.
// Copy i adres tapnięcia kompilują się na macOS (`swift test` w `scripts/ios-check.sh`); ActivityKit
// i SwiftUI są pod `#if os(iOS)` (ActivityKit na macOS jest w SDK, ale niedostępny).
// Copy: katalog `Copy/Localizable.xcstrings` (`docs/localization.md`); język źródłowy `en`.
import PackageDescription

let package = Package(
  name: "RarogActivity",
  defaultLocalization: "en",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "RarogActivity", targets: ["RarogActivity"]),
  ],
  dependencies: [
    .package(path: "../RarogContract"),
  ],
  targets: [
    .target(
      name: "RarogActivity",
      dependencies: [.product(name: "RarogContract", package: "RarogContract")],
      resources: [.process("Copy/Localizable.xcstrings")]
    ),
    .testTarget(
      name: "RarogActivityTests",
      dependencies: [
        "RarogActivity",
        .product(name: "RarogContract", package: "RarogContract"),
        .product(name: "RarogContractFixtures", package: "RarogContract"),
      ],
      // Snapshot of the catalog keys (`CopyCatalogTests`): test data, not a package resource.
      exclude: ["Fixtures"]
    ),
  ],
  swiftLanguageModes: [.v6]
)
