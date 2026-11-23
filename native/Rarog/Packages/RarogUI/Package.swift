// swift-tools-version:6.2
// Widoki natywnej apki: SwiftUI dla nawigacji, listy, logowania i kart; UIKit dla transkryptu
// (`UICollectionView` + diffable data source, tekst w `UITextView` na TextKit 2) i pola wiadomości
// (`UITextView` przypięty do `keyboardLayoutGuide`). Zero logiki domenowej — stan i decyzje daje
// `RarogCore`, tu są tylko copy, modele prezentacji i widoki.
//
// Pliki z UIKit/SwiftUI są pod `#if os(iOS)`; copy, modele wierszy, parser markdownu i reguły
// prezentacji kompilują się także na macOS, więc `swift test` (scripts/ios-check.sh) testuje je
// bez symulatora.
// Copy: katalog `Copy/Localizable.xcstrings` (`docs/localization.md`); język źródłowy `en`.
import PackageDescription

let package = Package(
  name: "RarogUI",
  defaultLocalization: "en",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "RarogUI", targets: ["RarogUI"]),
  ],
  dependencies: [
    .package(path: "../RarogContract"),
    .package(path: "../RarogCore"),
  ],
  targets: [
    .target(
      name: "RarogUI",
      dependencies: [
        .product(name: "RarogContract", package: "RarogContract"),
        .product(name: "RarogCore", package: "RarogCore"),
      ],
      resources: [.process("Copy/Localizable.xcstrings")]
    ),
    .testTarget(
      // Nie `RarogUITests`: tak nazywa się target XCUITest w projekcie apki (kolizja modułów).
      name: "RarogUILogicTests",
      dependencies: [
        "RarogUI",
        .product(name: "RarogContract", package: "RarogContract"),
        .product(name: "RarogCore", package: "RarogCore"),
        .product(name: "RarogContractFixtures", package: "RarogContract"),
      ],
      // Snapshot of the catalog keys (`CopyCatalogTests`): test data, not a package resource.
      exclude: ["Fixtures"]
    ),
  ],
  swiftLanguageModes: [.v6]
)
