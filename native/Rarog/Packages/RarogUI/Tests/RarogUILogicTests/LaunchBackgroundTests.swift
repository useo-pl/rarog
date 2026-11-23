import Foundation
@testable import RarogUI
import Testing

// The system launch screen color against the app background. Owner: app launch (`RarogRootView`, `LaunchView`).

@Suite("launch screen: background color")
struct LaunchBackgroundTests {
  /// `Rarog/Assets.xcassets/LaunchBackground.colorset` in the app target.
  static let colorset = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appending(path: "Rarog/Assets.xcassets/LaunchBackground.colorset/Contents.json")

  private struct Catalog: Decodable {
    struct Entry: Decodable {
      struct Appearance: Decodable { let value: String }
      struct Color: Decodable { let components: [String: String] }
      let appearances: [Appearance]?
      let color: Color
    }
    let colors: [Entry]
  }

  /// `UILaunchScreen` reads only a named catalog color, not `PaletteTokens`, so `LaunchBackground` is a second copy
  /// of `PaletteTokens.background`. A token change without the catalog would flash on every launch: the system launch
  /// screen in one color, `LaunchView` right after it in another.
  @Test("LaunchBackground equals PaletteTokens.background in light and dark mode")
  func matchesPalette() throws {
    let catalog = try JSONDecoder().decode(Catalog.self, from: Data(contentsOf: Self.colorset))
    var found: [String: UInt32] = [:]
    for entry in catalog.colors {
      let mode = entry.appearances?.first?.value ?? "light"
      let channel = { (name: String) throws -> UInt32 in
        let text = try #require(entry.color.components[name], "\(mode): \(name)")
        return try #require(UInt32(text.replacingOccurrences(of: "0x", with: ""), radix: 16), "\(mode): \(name) = \(text)")
      }
      found[mode] = try channel("red") << 16 | channel("green") << 8 | channel("blue")
      #expect(entry.color.components["alpha"] == "1.000", "\(mode): opaque")
    }
    #expect(found == ["light": PaletteTokens.background.light, "dark": PaletteTokens.background.dark])
  }
}
