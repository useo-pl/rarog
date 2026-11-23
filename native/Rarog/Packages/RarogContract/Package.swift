// swift-tools-version:6.2
// Kontrakt SSE/REST Raroga po stronie klienta natywnego: typy ramek, tolerancyjny dekoder
// (lustro `shared/src/decode.ts`) i test złotych ramek `shared/fixtures/sse/`. Bez UIKit, więc
// `swift test` chodzi na macOS. Biblioteka `RarogContractFixtures` służy WYŁĄCZNIE testom
// (czyta pliki z repo przez `#filePath`) — apka jej nie linkuje.
// `CopyLanguage` i `CopyLookup` leżą tutaj, bo kontrakt widzą wszystkie pakiety z copy; katalog-próbka
// `Tests/RarogContractTests/Resources/Localizable.xcstrings` sprawdza wyszukanie w jawnym języku,
// stąd `defaultLocalization`. Zasób celu `Copy/Localizable.xcstrings` to katalog zdań serwera (`server.*`, `push.*`):
// generuje go z rejestru `shared/src/sentences/` skrypt `scripts/sentences-catalog.mjs --write`, razem
// z deskryptorami argumentów `Copy/SentenceDescriptors.swift`.
import PackageDescription

let package = Package(
  name: "RarogContract",
  defaultLocalization: "en",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "RarogContract", targets: ["RarogContract"]),
    .library(name: "RarogContractFixtures", targets: ["RarogContractFixtures"]),
  ],
  targets: [
    .target(name: "RarogContract", resources: [.process("Copy/Localizable.xcstrings")]),
    .target(name: "RarogContractFixtures"),
    .testTarget(
      name: "RarogContractTests",
      dependencies: ["RarogContract", "RarogContractFixtures"],
      resources: [.process("Resources/Localizable.xcstrings")]
    ),
  ],
  swiftLanguageModes: [.v6]
)
