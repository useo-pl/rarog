import Foundation
@testable import RarogUI
import Testing

// The file a path in an inline code run of the transcript names: the candidate of the run's text (line suffixes and
// the session directory taken off, everything that cannot be a session file refused) and its resolution against the
// session's file index (an exact member, else the only path with that suffix). Owner: transcript.

@Suite("transcript file path: candidate and resolution")
struct TranscriptFilePathTests {
  private let cwd = "/Users/x/proj"

  private let index = FileSearchIndex(
    paths: [
      "server/src/files/path-rule.ts", "server/src/index.ts", "relay/src/index.ts", "a/b.ts", "docs/a.md",
      "native/Rarog/Packages/RarogUI/Sources/RarogUI/Markdown/MarkdownRenderer.swift", "docs/README",
      "README.md", "docs/nested/README.md",
    ],
    truncated: false, maxBytes: 1_048_576)

  @Test(
    "a relative path, its line suffixes and a leading ./ give the path",
    arguments: [
      ("server/src/files/path-rule.ts", "server/src/files/path-rule.ts"),
      ("server/src/files/path-rule.ts:42", "server/src/files/path-rule.ts"),
      ("server/src/files/path-rule.ts:42:5", "server/src/files/path-rule.ts"),
      ("server/src/files/path-rule.ts:3-9", "server/src/files/path-rule.ts"),
      ("./a/b.ts", "a/b.ts"),
    ])
  func relative(code: String, expected: String) {
    #expect(TranscriptFilePath.candidate(code, cwd: cwd) == expected)
  }

  @Test("an absolute path under the session directory becomes relative", arguments: ["/Users/x/proj", "/Users/x/proj/"])
  func absoluteUnderCwd(cwd: String) {
    #expect(TranscriptFilePath.candidate("/Users/x/proj/docs/a.md", cwd: cwd) == "docs/a.md")
  }

  @Test(
    "what cannot be a session file is no candidate",
    arguments: [
      "/Users/x/proj2/a.md", "/private/tmp/claude-501/x/scratchpad/r.md", "../a.md", "a/../b.md", "~/a.md",
      "git status", "https://x.y/a.md", "server/src/files/", "/Users/x/proj", "/Users/x/proj/", "", "./",
    ])
  func notCandidate(code: String) {
    #expect(TranscriptFilePath.candidate(code, cwd: cwd) == nil)
  }

  @Test("an absolute path with no known session directory is no candidate")
  func absoluteWithoutCwd() {
    #expect(TranscriptFilePath.candidate("/Users/x/proj/docs/a.md", cwd: "") == nil)
  }

  @Test("an exact member of the index is itself")
  func exactMember() {
    #expect(TranscriptFilePath.resolve("server/src/files/path-rule.ts", in: index) == "server/src/files/path-rule.ts")
  }

  @Test("a unique file name gives its full path")
  func uniqueName() {
    #expect(
      TranscriptFilePath.resolve("MarkdownRenderer.swift", in: index)
        == "native/Rarog/Packages/RarogUI/Sources/RarogUI/Markdown/MarkdownRenderer.swift")
    #expect(
      TranscriptFilePath.resolve("Markdown/MarkdownRenderer.swift", in: index)
        == "native/Rarog/Packages/RarogUI/Sources/RarogUI/Markdown/MarkdownRenderer.swift")
  }

  @Test("a suffix matches only on a segment boundary")
  func segmentBoundary() {
    #expect(TranscriptFilePath.resolve("Renderer.swift", in: index) == nil)
  }

  @Test("a name in two or more index paths is ambiguous")
  func ambiguous() {
    #expect(TranscriptFilePath.resolve("index.ts", in: index) == nil)
    #expect(TranscriptFilePath.resolve("src/index.ts", in: index) == nil)
    #expect(TranscriptFilePath.resolve("relay/src/index.ts", in: index) == "relay/src/index.ts")
  }

  @Test("an exact member wins over the same name deeper in the tree")
  func exactWinsOverSuffix() {
    #expect(TranscriptFilePath.resolve("README.md", in: index) == "README.md")
  }

  @Test("code that names no file of the index resolves to nothing")
  func noFile() {
    #expect(TranscriptFilePath.resolve("UICopy.terminalHistory", in: index) == nil)
  }

  @Test("a bare name without an extension is not looked up as a suffix")
  func bareNameWithoutExtension() {
    #expect(TranscriptFilePath.resolve("README", in: index) == nil)
  }

  @Test("a truncated index proves no suffix unique: only an exact member resolves")
  func truncatedIndex() {
    let index = FileSearchIndex(paths: ["a/index.ts"], truncated: true, maxBytes: 1)
    #expect(TranscriptFilePath.match("index.ts", in: index) == .truncated)
    #expect(TranscriptFilePath.resolve("index.ts", in: index) == nil)
    #expect(TranscriptFilePath.resolve("a/index.ts", in: index) == "a/index.ts")
  }

  @Test("paths compare by bytes, the way the tree search does")
  func unicodeForm() {
    let decomposed = "docs/zo\u{0301}lw.md"
    let composed = "docs/z\u{00F3}lw.md"
    let index = FileSearchIndex(paths: [decomposed], truncated: false, maxBytes: 1)
    #expect(TranscriptFilePath.resolve(decomposed, in: index) == decomposed)
    #expect(TranscriptFilePath.resolve(composed, in: index) == nil)
    #expect(TranscriptFilePath.resolve("zo\u{0301}lw.md", in: index) == decomposed)
    #expect(TranscriptFilePath.resolve("z\u{00F3}lw.md", in: index) == nil)
  }

  @Test("the reason of a miss tells an unknown path from an ambiguous one")
  func missReason() {
    #expect(TranscriptFilePath.match("index.ts", in: index) == .ambiguous)
    #expect(TranscriptFilePath.match("UICopy.terminalHistory", in: index) == .notFound)
    #expect(TranscriptFilePath.match("a/b.ts", in: index) == .found("a/b.ts"))
  }
}
