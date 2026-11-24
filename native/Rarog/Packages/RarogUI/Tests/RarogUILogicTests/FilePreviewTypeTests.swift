import Foundation
@testable import RarogUI
import Testing

// Which extension a fetched file keeps for QuickLook: text files QuickLook would not show by their own extension get
// a `.txt` copy, text it shows, documents and images keep theirs, binaries without a type stay as they are.
// Owner: panel.

@Suite("file preview: the type of the copy")
struct FilePreviewTypeTests {
  private let source = Data("export function route() {\n  return 'ż'\n}\n".utf8)
  private let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52])
  private let binary = Data([0x7F, 0x45, 0x4C, 0x46, 0x02, 0x01, 0x01, 0x00, 0xFF, 0xFE])

  @Test("router.ts, main.go and Makefile with text content are shown as text", arguments: ["router.ts", "main.go", "Makefile"])
  func sourceAsText(_ name: String) {
    #expect(FilePreviewType.showsAsText(name: name, head: source, complete: true))
  }

  /// QuickLook on iOS shows plain text, source code, HTML, XML, JSON and RTF by their own extension and nothing for
  /// YAML, CSS, TOML or INI. Only names whose type is the same on macOS and iOS stand here; the rest are checked on
  /// the device.
  @Test("text QuickLook cannot show by its extension gets a .txt copy, text it can show keeps its type", arguments: [
    ("config.yaml", true), ("ci.yml", true), ("styles.css", true), ("Cargo.toml", true), ("setup.ini", true),
    ("setup.cfg", true), ("package.json", false), ("README.md", false), ("main.swift", false), ("notes.txt", false),
    ("page.html", false), ("feed.xml", false), ("brief.pdf", false), ("logo.png", false),
  ])
  func textByQuickLook(_ name: String, _ copiedToText: Bool) {
    #expect(FilePreviewType.showsAsText(name: name, head: source, complete: true) == copiedToText, "\(name)")
  }

  @Test("PNG, PDF and .docx keep their type, even when their bytes read as text",
        arguments: ["logo.png", "brief.pdf", "offer.docx"])
  func documentsKeep(_ name: String) {
    #expect(!FilePreviewType.showsAsText(name: name, head: png, complete: true))
    #expect(!FilePreviewType.showsAsText(name: name, head: Data("%PDF-1.4 plain ascii".utf8), complete: true))
  }

  @Test("a binary file without a known type is not text; neither is text with a NUL")
  func binaryStays() {
    #expect(!FilePreviewType.showsAsText(name: "firmware", head: binary, complete: true))
    #expect(!FilePreviewType.showsAsText(name: "dump.ts", head: binary, complete: true), "a real transport stream")
    #expect(!FilePreviewType.showsAsText(name: "notes", head: Data("a\u{0}b".utf8), complete: true))
  }

  @Test("a cut inside the last character counts as text only when the file goes on")
  func cutCharacter() {
    let head = Data("abc".utf8) + Data("ż".utf8).prefix(1)
    #expect(FilePreviewType.showsAsText(name: "main.go", head: head, complete: false))
    #expect(!FilePreviewType.showsAsText(name: "main.go", head: head, complete: true))
  }

  @Test("a 4-byte character cut after 1, 2 or 3 bytes at the end of a longer file stays text", arguments: [1, 2, 3])
  func cutAfter(_ kept: Int) {
    let head = Data("abc".utf8) + Data("🐢".utf8).prefix(kept)
    #expect(FilePreviewType.showsAsText(name: "main.go", head: head, complete: false))
  }

  @Test("an end that is no start of a UTF-8 character is not text, even when the file goes on",
        arguments: [
          [0xFF], [0x80], [0xC0], [0xC1], [0xF5], [0xC3, 0x28], [0xE0, 0x80], [0xED, 0xA0], [0xF0, 0x80],
          [0xF4, 0x90], [0xE2, 0x82, 0x28], [0xF0, 0x9F, 0x41], [0xFF, 0xFF, 0xFF],
        ] as [[UInt8]])
  func brokenEnd(_ tail: [UInt8]) {
    let head = Data("abc".utf8) + Data(tail)
    #expect(!FilePreviewType.showsAsText(name: "main.go", head: head, complete: false), "\(tail)")
  }

  @Test("the second byte ranges of 0xE0, 0xED, 0xF0 and 0xF4 at a cut stay text", arguments: [
    [0xE0, 0xA0], [0xED, 0x9F], [0xF0, 0x90], [0xF4, 0x8F], [0xF4, 0x8F, 0xBF], [0xE1, 0x80],
  ] as [[UInt8]])
  func validCutRanges(_ tail: [UInt8]) {
    let head = Data("abc".utf8) + Data(tail)
    #expect(FilePreviewType.showsAsText(name: "main.go", head: head, complete: false), "\(tail)")
  }

  @Test("prepare moves a text source to .txt and leaves a PNG and a binary in place")
  func prepareMoves() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "rarog-ui-preview-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    // The 8 KB head ends inside "ż": the file is still text.
    let long = Data(String(repeating: "a", count: FilePreviewType.sniffLength - 1).utf8) + Data("żółw\n".utf8)
    let cases: [(copy: String, name: String, bytes: Data, kept: Bool)] = [
      ("A.ts", "router.ts", long, false), ("B", "Makefile", source, false), ("C.png", "logo.png", png, true),
      ("D", "firmware", binary, true), ("E.yaml", "config.yaml", source, false),
    ]
    for item in cases {
      let copy = directory.appending(path: item.copy)
      try item.bytes.write(to: copy)
      let prepared = FilePreviewType.prepare(copy, name: item.name)
      if item.kept {
        #expect(prepared == copy, "\(item.name)")
      } else {
        #expect(prepared.pathExtension == "txt", "\(item.name)")
        #expect(!FileManager.default.fileExists(atPath: copy.path(percentEncoded: false)), "moved, not copied")
      }
      #expect(try Data(contentsOf: prepared) == item.bytes)
    }
  }
}
