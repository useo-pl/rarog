// swift-tools-version:6.2
// Adapter terminala natywnej apki: JEDYNY pakiet, który importuje SwiftTerm. Renderer
// przypięty `exact: "1.19.0"` (gałąź `main` SwiftTerm jest w refaktorze pod 2.0). `SwiftTermSurface`
// (podklasa `TerminalView`, UIKit) spełnia protokół `TerminalSurface` z `RarogUI`; apka wstrzykuje fabrykę
// przez środowisko, więc `RarogUI` nie zna SwiftTerm i testuje się bez niego.
//
// Widok UIKit stoi pod `#if os(iOS)`. Na macOS (`swift test`) kompiluje się i testuje część wspólna:
// rozpęd przewijania, zapasowa czcionka z glifami Nerd Font i rdzeń emulatora SwiftTerm (`Terminal`) na
// syntetycznych bajtach. Build wymaga Metal Toolchain (SwiftTerm kompiluje shader) i — w xcodebuild —
// `-skipPackagePluginValidation` (wtyczka buildu SwiftTerm, `native/Rarog/README.md`).
import PackageDescription

let package = Package(
  name: "RarogTerminal",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "RarogTerminal", targets: ["RarogTerminal"]),
  ],
  dependencies: [
    .package(url: "https://github.com/migueldeicaza/SwiftTerm", exact: "1.19.0"),
    .package(path: "../RarogContract"),
    .package(path: "../RarogCore"),
    .package(path: "../RarogTransport"),
    .package(path: "../RarogUI"),
  ],
  targets: [
    .target(
      name: "RarogTerminal",
      dependencies: [
        .product(name: "SwiftTerm", package: "SwiftTerm"),
        .product(name: "RarogContract", package: "RarogContract"),
        .product(name: "RarogUI", package: "RarogUI"),
      ],
      // Zapasowe pismo z glifami Nerd Font (MIT) z licencją i atrybucją — katalog kopiowany w całości.
      resources: [.copy("Resources/NerdFontsSymbols")]
    ),
    .testTarget(
      name: "RarogTerminalTests",
      dependencies: [
        "RarogTerminal",
        .product(name: "SwiftTerm", package: "SwiftTerm"),
        .product(name: "RarogContract", package: "RarogContract"),
        .product(name: "RarogCore", package: "RarogCore"),
        .product(name: "RarogTransport", package: "RarogTransport"),
        .product(name: "RarogUI", package: "RarogUI"),
      ]
    ),
  ],
  swiftLanguageModes: [.v6]
)
