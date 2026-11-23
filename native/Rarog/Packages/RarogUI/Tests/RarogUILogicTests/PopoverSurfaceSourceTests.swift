import Foundation
import Testing

// Popovery na pełnym `surface`, nie na systemowym szkle (szkło daje szarą, rozmytą plamę nad ciemnym
// transkryptem). Szkła i rozmycia nie oddaje żaden render w testach — wygląd sprawdzają zrzuty iPada
// (`GlassScreenshotUITests`). Tu strażnik źródeł: popover SwiftUI, w którego TREŚCI nie stoi `.popoverSurface()`,
// pada od razu. Właściciel: nagłówek.

@Suite("popovery: pełne tło `surface` zamiast systemowego szkła")
struct PopoverSurfaceSourceTests {
  static let sources = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().appending(path: "Sources/RarogUI")

  /// Kod bez komentarzy `//`, po pliku (ścieżka względem `Sources/RarogUI`).
  static func files() throws -> [(name: String, code: String)] {
    let enumerator = try #require(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
    var result: [(String, String)] = []
    for case let url as URL in enumerator where url.pathExtension == "swift" {
      let code = try String(contentsOf: url, encoding: .utf8)
        .split(separator: "\n", omittingEmptySubsequences: false)
        .map { line in line.range(of: "//").map { String(line[..<$0.lowerBound]) } ?? String(line) }
        .joined(separator: "\n")
      result.append((url.path.replacingOccurrences(of: sources.path + "/", with: ""), code))
    }
    return result
  }

  /// Treść każdego `.popover(…) { … }` w kodzie: domknięcie za nawiasem wywołania (nawiasy i klamry liczone,
  /// bo argument `item: Binding(get: { … })` sam ma klamry). `nil` = popover bez domknięcia treści.
  static func popoverContents(_ code: String) -> [String?] {
    let chars = Array(code)
    let marker = Array(".popover(")
    var result: [String?] = []
    var index = 0
    while index + marker.count <= chars.count {
      guard Array(chars[index..<index + marker.count]) == marker else {
        index += 1
        continue
      }
      var cursor = index + marker.count
      var depth = 1
      while cursor < chars.count, depth > 0 {
        if chars[cursor] == "(" { depth += 1 } else if chars[cursor] == ")" { depth -= 1 }
        cursor += 1
      }
      while cursor < chars.count, chars[cursor].isWhitespace { cursor += 1 }
      guard cursor < chars.count, chars[cursor] == "{" else {
        result.append(nil)
        index = cursor
        continue
      }
      let start = cursor
      depth = 0
      repeat {
        if chars[cursor] == "{" { depth += 1 } else if chars[cursor] == "}" { depth -= 1 }
        cursor += 1
      } while cursor < chars.count && depth > 0
      result.append(String(chars[start..<cursor]))
      index = cursor
    }
    return result
  }

  static func covered(_ code: String) -> [Bool] {
    popoverContents(code).map { $0?.contains(".popoverSurface()") ?? false }
  }

  @Test("parser: modyfikator liczy się tylko w treści swojego popovera")
  func parser() {
    let good = """
      .popover(item: Binding(get: { sheet.current }, set: { _ in })) { ticket in
        Panel(ticket).popoverSurface()
      }
      """
    #expect(Self.covered(good) == [true])
    // Modyfikator na przycisku, za domknięciem popovera (liczniki 1 i 1 przepuszczały ten błąd).
    let outside = """
      Button {}.popover(isPresented: $open) {
        Panel()
      }
      .popoverSurface()
      """
    #expect(Self.covered(outside) == [false])
    // Dwa popovery, modyfikator tylko w pierwszym.
    let second = """
      .popover(isPresented: $a) { A().popoverSurface() }
      .popover(isPresented: $b) { B() }
      """
    #expect(Self.covered(second) == [true, false])
  }

  @Test("każdy `.popover(` w źródłach ma `.popoverSurface()` w swojej treści (git, „w tle”, model)")
  func everyPopoverHasSurface() throws {
    var popovers = 0
    for file in try Self.files() {
      let covered = Self.covered(file.code)
      popovers += covered.count
      for (number, ok) in covered.enumerated() {
        #expect(ok, "\(file.name): popover nr \(number + 1) bez `.popoverSurface()` w treści")
      }
    }
    // Co najmniej trzy popovery — strażnik nie może przejść na pustym zbiorze.
    #expect(popovers >= 3, "znalezione popovery SwiftUI: \(popovers)")
  }

  @Test("popover UIKit (`modalPresentationStyle = .popover`) ma pełne tło widoku i pod strzałką (arkusz promptów)")
  func everyUIKitPopoverHasSurface() throws {
    var popovers = 0
    for file in try Self.files() where file.code.contains("modalPresentationStyle = .popover") {
      popovers += 1
      #expect(file.code.contains(".view.backgroundColor ="), "\(file.name): popover UIKit bez tła widoku")
      #expect(
        file.code.contains("popoverPresentationController?.backgroundColor ="), "\(file.name): popover UIKit bez tła strzałki")
    }
    #expect(popovers >= 1, "znalezione popovery UIKit: \(popovers)")
  }

  @Test("modyfikator: tło prezentacji to pełne `Palette.surface`, a platforma popovera (strzałka, rogi) — to samo")
  func surfaceModifier() throws {
    let code = try #require(Self.files().first { $0.name == "Views/Presentation/PopoverSurface.swift" }).code
    #expect(code.contains("func popoverSurface()"))
    #expect(code.contains("presentationBackground(Color(uiColor: Palette.surface))"))
    // Rogi: samo tło treści zostawia szkło przy strzałce i ciaśniejszym rogu obok niej.
    #expect(code.contains(".background(PopoverChrome())"), "modyfikator bez mostka do platformy popovera")
    #expect(code.contains("popover.backgroundColor = Palette.surface"), "mostek bez koloru platformy")
    #expect(code.contains("UIColorEffect(color: Palette.surface)"), "mostek bez efektu tła (iOS 26.1+)")
  }
}
