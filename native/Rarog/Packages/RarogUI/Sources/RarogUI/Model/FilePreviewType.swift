import Foundation
import UniformTypeIdentifiers

// Which extension a fetched session file keeps for QuickLook. QuickLook picks its viewer from the copy's extension,
// so a text file whose extension maps to no type (`main.go`, `Makefile`), to a media type (`router.ts` is an MPEG
// transport stream) or to a text type QuickLook has no viewer for (`config.yaml`) would show an empty page; such a
// file with text content gets a `.txt` copy. Logic without UIKit, tested on macOS. Owner: panel.

/// The type rule of a file preview copy.
enum FilePreviewType {
  /// How many bytes from the start decide whether the content is text.
  static let sniffLength = 8 * 1024

  /// Whether the file `name` with content starting with `head` is shown as plain text. `complete`: `head` is the
  /// whole file, so an unfinished UTF-8 sequence at its end is not text; a longer file may be cut inside one.
  static func showsAsText(name: String, head: Data, complete: Bool) -> Bool {
    if let type = declaredType(of: name), keepsExtension(type) { return false }
    return isText(head, complete: complete)
  }

  /// The copy QuickLook gets: `copy` itself, or the same file moved to `.txt` (one file, so the one owner deletes the
  /// URL this returns). A copy that cannot be read or moved stays as it is.
  static func prepare(_ copy: URL, name: String) -> URL {
    guard let (head, complete) = readHead(copy), showsAsText(name: name, head: head, complete: complete),
      copy.pathExtension.lowercased() != "txt"
    else { return copy }
    let text = copy.deletingPathExtension().appendingPathExtension("txt")
    do {
      try FileManager.default.moveItem(at: copy, to: text)
      return text
    } catch {
      return copy
    }
  }

  /// The type of the name's extension; `nil` for a name without one (`Makefile`) or an extension no app declared.
  private static func declaredType(of name: String) -> UTType? {
    let parts = name.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count > 1, let suffix = parts.last, !suffix.isEmpty,
      let type = UTType(filenameExtension: String(suffix)), !type.isDynamic
    else { return nil }
    return type
  }

  /// The types QuickLook on iOS shows by their own extension keep it, and their bytes are never sniffed, so a PDF
  /// written in plain ASCII stays a PDF: plain text and source code, HTML, XML, JSON, RTF, calendar events and
  /// contacts, images and documents (PDF, office and iWork files). Other text (`public.yaml`, `public.css`) gets an
  /// empty page there, so it is sniffed like audio, video, archives and other types.
  private static func keepsExtension(_ type: UTType) -> Bool {
    [
      UTType.plainText, .html, .xml, .json, .rtf, .calendarEvent, .vCard, .image, .compositeContent, .threeDContent,
    ].contains { type.conforms(to: $0) }
  }

  /// Valid UTF-8 without NUL; a cut inside the last character counts when the file goes on.
  private static func isText(_ head: Data, complete: Bool) -> Bool {
    guard !head.contains(0) else { return false }
    if String(data: head, encoding: .utf8) != nil { return true }
    guard !complete else { return false }
    // A UTF-8 character is at most 4 bytes, so a cut leaves at most 3 of them at the end. Only a real start of a
    // character may be dropped: anything else at the end (0xFF, a lone continuation byte) makes the head binary.
    for drop in 1...3 where head.count > drop {
      guard isCutCharacter(Array(head.suffix(drop))) else { continue }
      if String(data: head.dropLast(drop), encoding: .utf8) != nil { return true }
    }
    return false
  }

  /// Whether `bytes` are the first bytes of one UTF-8 character, fewer than its full length: a lead byte
  /// 0xC2–0xF4 and continuation bytes 0x80–0xBF, the second one in the narrower range 0xE0, 0xED, 0xF0 and 0xF4
  /// allow.
  private static func isCutCharacter(_ bytes: [UInt8]) -> Bool {
    guard let lead = bytes.first else { return false }
    let length: Int
    switch lead {
    case 0xC2...0xDF: length = 2
    case 0xE0...0xEF: length = 3
    case 0xF0...0xF4: length = 4
    default: return false
    }
    guard bytes.count < length else { return false }
    for (index, byte) in bytes.enumerated().dropFirst() {
      let range: ClosedRange<UInt8> =
        switch (index, lead) {
        case (1, 0xE0): 0xA0...0xBF
        case (1, 0xED): 0x80...0x9F
        case (1, 0xF0): 0x90...0xBF
        case (1, 0xF4): 0x80...0x8F
        default: 0x80...0xBF
        }
      guard range.contains(byte) else { return false }
    }
    return true
  }

  /// The first ``sniffLength`` bytes and whether they are the whole file.
  private static func readHead(_ url: URL) -> (Data, Bool)? {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { try? handle.close() }
    guard let head = try? handle.read(upToCount: sniffLength + 1) ?? Data() else { return nil }
    return (head.prefix(sniffLength), head.count <= sniffLength)
  }
}
