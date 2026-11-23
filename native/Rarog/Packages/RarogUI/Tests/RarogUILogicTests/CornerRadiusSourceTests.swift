import Foundation
@testable import RarogUI
import Testing

// Jedna skala promieni rogów (`Theme/Radius.swift`). Zgłoszenie użytkownika:
// „zaokrąglenie rogów w elementach, które mają zaokrąglone rogi, to nie zawsze jest takie samo” — obok siebie
// stało 6, 8, 10, 12, 14 i 17 pt. Właściciel: wygląd.

@Suite("promienie rogów: jedna skala")
struct CornerRadiusSourceTests {
  static let root = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().appending(path: "Sources/RarogUI")
  /// Jedyny plik, w którym promień stoi liczbą.
  static let scale = "Theme/Radius.swift"

  /// Promień liczbą: `cornerRadius: 14`, `layer.cornerRadius = 10`, `roundCorners(14)`, stała `radius: CGFloat = 8`,
  /// róg nierówny (`topLeadingRadius: 6`), `cornerSize`/`cornerRadii` z `CGSize` i `.roundedRectangle(radius: 6)`.
  /// Wzorce idą po całym pliku, więc liczba w następnej linii też się liczy.
  static let literal = try! NSRegularExpression(pattern: [
    #"cornerRadius\s*[:=]\s*-?[0-9.]"#,
    #"roundCorners\(\s*-?[0-9.]"#,
    #"\b(?:radius|cornerRadius|\w+CornerRadius)\s*:\s*CGFloat\s*=\s*[0-9.]"#,
    #"\b(?:topLeading|topTrailing|bottomLeading|bottomTrailing)(?:Radius)?\s*:\s*[0-9.]"#,
    #"corner(?:Size|Radii)\s*:\s*CGSize\(\s*width\s*:\s*[0-9.]"#,
    #"\.roundedRectangle\(\s*radius\s*:\s*[0-9.]"#,
  ].joined(separator: "|"))

  /// Pliki źródeł RarogUI (ścieżka względna) z kodem bez komentarzy `//`, linia po linii.
  static func sources() throws -> [(file: String, lines: [String])] {
    let files = try #require(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
      .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
    return try files.map { file in
      let lines = try String(contentsOf: file, encoding: .utf8)
        .split(separator: "\n", omittingEmptySubsequences: false)
        .map { line in line.range(of: "//").map { String(line[..<$0.lowerBound]) } ?? String(line) }
      return (String(file.path.dropFirst(root.path.count + 1)), lines)
    }
  }

  /// Numery linii (od 1), w których zaczyna się promień liczbą.
  static func literalLines(in code: String) -> [Int] {
    let text = code as NSString
    return literal.matches(in: code, range: NSRange(location: 0, length: text.length)).map { match in
      text.substring(to: match.range.location).reduce(1) { $1 == "\n" ? $0 + 1 : $0 }
    }
  }

  static func offenders(_ matches: (String) -> Bool, skipScale: Bool = true) throws -> [String] {
    var found: [String] = []
    for (file, lines) in try sources() where !(skipScale && file == scale) {
      for (index, line) in lines.enumerated() where matches(line) {
        found.append("\(file):\(index + 1): \(line.trimmingCharacters(in: .whitespaces))")
      }
    }
    return found.sorted()
  }

  @Test("promień rogu stoi liczbą tylko w skali; reszta bierze block, inner, focusRing albo ghost")
  func noLiteralRadius() throws {
    #expect(try Self.sources().count > 50, "skan widzi za mało plików źródeł")
    var found: [String] = []
    for (file, lines) in try Self.sources() where file != Self.scale {
      for number in Self.literalLines(in: lines.joined(separator: "\n")) {
        found.append("\(file):\(number): \(lines[number - 1].trimmingCharacters(in: .whitespaces))")
      }
    }
    #expect(found.isEmpty, "promień liczbą poza \(Self.scale):\n\(found.joined(separator: "\n"))")
  }

  /// Przypadki kontrolne strażnika (`roundCorners(14)` i liczba w następnej linii przechodziły).
  @Test("strażnik łapie liczbę w każdej formie, także w roundCorners i w następnej linii; skala i cień przechodzą")
  func guardForms() {
    let caught = [
      "view.layer.roundCorners(14)", "RoundedRectangle(cornerRadius:\n  14)", ".rect(cornerRadius: 8)",
      "layer.cornerRadius = 10", "static let radius: CGFloat = 8", "private static let cornerRadius: CGFloat = 14",
      "UnevenRoundedRectangle(topLeadingRadius: 6)", ".buttonBorderShape(.roundedRectangle(radius: 6))",
      "UIBezierPath(roundedRect: r, cornerRadius: 14)",
    ]
    for sample in caught { #expect(Self.literalLines(in: sample) == [1], "\(sample)") }
    let passed = [
      "layer.roundCorners(Radius.block)", ".background(x, in: .block)", ".shadow(color: c, radius: 12, y: 4)",
      "dot.layer.cornerRadius = Self.dotSide / 2", "RoundedRectangle.inner.fill(c)",
    ]
    for sample in passed { #expect(Self.literalLines(in: sample).isEmpty, "\(sample)") }
    #expect(Self.literalLines(in: "let a = 1\n\nglass.layer.roundCorners(12)") == [3])
  }

  @Test("krzywa rogu ciągła: bez .circular, a warstwa UIKit dostaje promień tylko przez roundCorners")
  func continuousCurve() throws {
    let circular = try Self.offenders({ $0.contains(".circular") }, skipScale: false)
    #expect(circular.isEmpty, "krzywa kołowa:\n\(circular.joined(separator: "\n"))")
    // Core Animation domyślnie rysuje róg kołowo; `roundCorners` ustawia
    // promień ze skali razem z `.continuous`. Wolno tylko kółko: promień = połowa boku kropki.
    let direct = try Self.offenders { line in
      line.range(of: #"\.cornerRadius\s*="#, options: .regularExpression) != nil && !line.contains("/ 2")
    }
    #expect(direct.isEmpty, "promień warstwy poza roundCorners:\n\(direct.joined(separator: "\n"))")
  }
}
