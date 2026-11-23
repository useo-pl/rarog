import Foundation
import Testing

// Every font of the app's views goes through the text scaling contract (`Theme/TextStyle/`): on a Mac every text
// style has one size, so a font taken from the system's text styles directly stays at that size when the app's text
// size changes. The guard stays as long as the app has its own text size path on the Mac. Owner: text size.

@Suite("fonts of the views go through the text scaling contract")
struct FontContractSourceTests {
  struct Rule {
    let name: String
    let replacement: String
    let breaks: @Sendable (String) -> Bool

    init(name: String, pattern: String, replacement: String) {
      self.name = name
      self.replacement = replacement
      breaks = { $0.range(of: pattern, options: .regularExpression) != nil }
    }

    init(name: String, replacement: String, breaks: @escaping @Sendable (String) -> Bool) {
      self.name = name
      self.replacement = replacement
      self.breaks = breaks
    }
  }

  struct Exemption {
    let file: String
    let line: String
    let reason: String
  }

  static let styles =
    "largeTitle|extraLargeTitle2|extraLargeTitle|title3|title2|title|headline|subheadline|body|callout|footnote"
    + "|caption2|caption1|caption"

  /// The first rule a line breaks is the one reported.
  static let rules: [Rule] = [
    Rule(
      name: "text style font assigned",
      pattern: #"\.font\s*=\s*(?:UIFont|Font)?\.(?:preferredFont\(|(?:\#(styles))\b)"#,
      replacement: "TextStyleScaling.font(_:category:) or Fonts.text(_:) in UIKit, setAppFont(_:_:) on AttributedString"),
    Rule(
      name: "SwiftUI text style font", replacement: ".appFont(_:) with the same style, or Text.appFont(_:_:)",
      breaks: { fontArguments(in: $0).contains { $0.range(of: styleToken, options: .regularExpression) != nil } }),
    Rule(
      name: "text style font value",
      pattern: #"\bFont\.(?:system\(\s*)?\.?(?:\#(styles))\b|:\s*Font\??\s*=\s*\.(?:\#(styles))\b"#,
      replacement: "an AppFont value (AppFont.body, .body typed as AppFont) passed to .appFont(_:)"),
    Rule(name: "@ScaledMetric", pattern: #"@ScaledMetric\b"#, replacement: "@AppScaledMetric(relativeTo:)"),
    Rule(
      name: "preferredFont", pattern: #"preferredFont\("#,
      replacement: "TextStyleScaling.font(_:category:) or Fonts.text(_:)"),
    Rule(
      name: "UIFontMetrics", pattern: #"\bUIFontMetrics\b"#,
      replacement: "TextStyleScaling.scale(_:relativeTo:category:) or TextStyleScaling.font(_:relativeTo:category:)"),
  ]

  /// The contract itself: the two paths of text style scaling are written here.
  static let contractFiles: Set<String> = [
    "Theme/TextStyle/TextStyleScaling.swift",
    "Theme/TextStyle/TextStyleTable.swift",
    "Theme/TextStyle/AppFont.swift",
    "Theme/TextStyle/AppScaledMetric.swift",
  ]

  /// Lines outside the contract allowed to break a rule, matched by their code without the comment.
  static let exemptions: [Exemption] = [
    Exemption(
      file: "Terminal/TerminalFontSize+TextScale.swift",
      line: "return UIFont.preferredFont(forTextStyle: .body, compatibleWith: traits).pointSize",
      reason: "the standard path of the terminal's ratio; the flat path takes TextStyleTable one line above"),
  ]

  /// A text style named in an argument: `.body`, `Font.body`, the style of `.system(.body, design:)`.
  static let styleToken = #"(?<![A-Za-z0-9_])(?:Font)?\.(?:\#(styles))\b"#

  /// The functions named `font` that are not SwiftUI's modifier: the contract's UIKit fonts and local helpers.
  static let ownFontFunctions: Set<String> = ["TextStyleScaling", "Self"]

  /// The whole argument list of every SwiftUI `.font(…)` call on the line, nested parentheses included.
  static func fontArguments(in code: String) -> [Substring] {
    var found: [Substring] = []
    var rest = code.startIndex
    while let call = code.range(of: ".font(", range: rest..<code.endIndex) {
      rest = call.upperBound
      let owner = code[..<call.lowerBound].reversed().prefix { $0.isLetter || $0.isNumber || $0 == "_" }
      if ownFontFunctions.contains(String(owner.reversed())) { continue }
      var depth = 1
      var end = call.upperBound
      while end < code.endIndex, depth > 0 {
        if code[end] == "(" { depth += 1 } else if code[end] == ")" { depth -= 1 }
        end = code.index(after: end)
      }
      found.append(code[call.upperBound..<end])
    }
    return found
  }

  /// The rule `code` breaks, if any.
  static func rule(for code: String) -> Rule? {
    rules.first { $0.breaks(code) }
  }

  /// The code of line `index`, with the following lines joined while a `.font(` call on it is still open, so an
  /// argument list spread over several lines is read whole.
  static func joined(_ lines: [Substring], from index: Int) -> String {
    var code = Self.code(of: lines[index])
    guard code.contains(".font(") else { return code }
    var next = index + 1
    while next < lines.count, next < index + 8, depth(of: code) > 0 {
      code += " " + Self.code(of: lines[next])
      next += 1
    }
    return code
  }

  /// Open parentheses minus closed ones.
  static func depth(of code: String) -> Int {
    code.reduce(0) { $1 == "(" ? $0 + 1 : $1 == ")" ? $0 - 1 : $0 }
  }

  static func code(of line: Substring) -> String {
    let code = line.range(of: "//").map { String(line[..<$0.lowerBound]) } ?? String(line)
    return code.trimmingCharacters(in: .whitespaces)
  }

  @Test(
    "each rule catches its spelling and lets the contract's spellings pass",
    arguments: [
      ("Text(title).font(.body)", "SwiftUI text style font"),
      (".font(.caption2.weight(.bold))", "SwiftUI text style font"),
      (".font(.system(.footnote, design: .monospaced))", "SwiftUI text style font"),
      (".font(compact ? .caption : .body)", "SwiftUI text style font"),
      (".font(Font.headline)", "SwiftUI text style font"),
      ("let labelFont: Font = Font.system(.body)", "text style font value"),
      ("let labelFont: Font = .body", "text style font value"),
      ("private var glyph: Font? = .caption", "text style font value"),
      ("return Font.footnote.weight(.semibold)", "text style font value"),
      ("label.font = .preferredFont(forTextStyle: .body)", "text style font assigned"),
      ("label.font = UIFont.preferredFont(forTextStyle: .body)", "text style font assigned"),
      ("container.font = .callout", "text style font assigned"),
      ("@ScaledMetric(relativeTo: .body) private var gap = 8.0", "@ScaledMetric"),
      ("let size = UIFont.preferredFont(forTextStyle: .title3).pointSize", "preferredFont"),
      ("let metrics = UIFontMetrics(forTextStyle: .body)", "UIFontMetrics"),
      (".appFont(.body)", nil),
      (".appFont(.caption2.monospaced().weight(.medium))", nil),
      (".font(.system(size: 15, weight: .medium))", nil),
      (".font(font.resolve(typeSize: size, flat: flat))", nil),
      ("label.font = Fonts.text(.footnote)", nil),
      ("view.font = TextStyleScaling.font(.body, category: TextScale.shared.effective)", nil),
      ("@AppScaledMetric(relativeTo: .body) private var gap = 8.0", nil),
      ("let base = UIFontDescriptor.preferredFontDescriptor(withTextStyle: .body)", nil),
      ("content.font(.system(size: size, weight: weight))", nil),
      ("let font = Self.font(.body, traits: traits)", nil),
      ("let glyph: AppFont = .caption", nil),
      ("init(relativeTo style: Font.TextStyle = .body)", nil),
    ] as [(String, String?)])
  func rules(line: String, broken: String?) {
    #expect(Self.rule(for: line)?.name == broken, "\(line)")
  }

  @Test("a .font( call spread over several lines is read whole")
  func multiLine() {
    let lines: [Substring] = ["Text(title).font(", "  .body", ")", "Text(other)"]
    #expect(Self.rule(for: Self.joined(lines, from: 0))?.name == "SwiftUI text style font")
    #expect(Self.joined(lines, from: 3) == "Text(other)")
  }

  @Test("no view takes a font from the system's text styles outside the contract; only listed lines may")
  func viewsUseTheContract() throws {
    let root = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appending(path: "Sources/RarogUI")
    let files = try #require(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
      .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
    #expect(files.count > 50, "the scan sees too few source files")
    var offenders: [String] = []
    var used = Set<String>()
    for file in files {
      let relative = String(file.path.dropFirst(root.path.count + 1))
      if Self.contractFiles.contains(relative) { continue }
      let lines = try String(contentsOf: file, encoding: .utf8).split(separator: "\n", omittingEmptySubsequences: false)
      for (index, line) in lines.enumerated() {
        let code = Self.joined(lines, from: index)
        guard let rule = Self.rule(for: code) else { continue }
        if Self.exemptions.contains(where: { $0.file == relative && $0.line == code }) {
          used.insert("\(relative): \(code)")
          continue
        }
        offenders.append("\(relative):\(index + 1): \(rule.name) in `\(code)` → \(rule.replacement)")
      }
    }
    #expect(
      offenders.isEmpty,
      "fonts outside the text scaling contract:\n\(offenders.sorted().joined(separator: "\n"))")
    let stale = Self.exemptions.map { "\($0.file): \($0.line)" }.filter { !used.contains($0) }
    #expect(stale.isEmpty, "exemptions that match no line any more, remove them:\n\(stale.joined(separator: "\n"))")
  }
}
