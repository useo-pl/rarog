import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Branches of the composer copy (`UICopy+Composer.swift`): the error state line with the
// server's detail, the slash-command row for VoiceOver, progress of an entry in flight, attachment announcements and
// labels, and the rejection sentences (one per reason, photos before files, names quoted and cut to 32 characters).
// Each test checks the part of the sentence that the input decides: the passed text, a count with its noun form,
// a weight or limit with its unit, a quoted name. A non-breaking space is `\u{00A0}`.

private func attachment(
  _ kind: ComposerAttachment.Kind, name: String = "IMG_0001.HEIC", bytes: Int = 1000
) -> ComposerAttachment {
  ComposerAttachment(
    kind: kind, name: name, mime: kind == .image ? "image/jpeg" : "application/pdf", bytes: bytes,
    file: URL(filePath: "/dev/null"))
}

private func rejectedImage(_ name: String, _ reason: AttachmentRejection.Reason) -> AttachmentRejection {
  AttachmentRejection(kind: .image, name: name, reason: reason)
}

private func rejectedFile(_ name: String, _ reason: AttachmentRejection.Reason) -> AttachmentRejection {
  AttachmentRejection(kind: .file, name: name, reason: reason)
}

/// The one sentence for `rejections`, or a failure when there is not exactly one.
private func sentence(_ rejections: [AttachmentRejection]) throws -> String {
  let lines = UICopy.attachmentRejections(rejections)
  try #require(lines.count == 1, "one sentence per reason, got \(lines)")
  return lines[0]
}

@Suite("UICopy branches: composer")
struct UICopyBranchesComposerTests {
  // MARK: State line

  @Test("a session error with a detail from the server carries the detail")
  func errorStateLineCarriesDetail() {
    let line = UICopy.stateCardLine(.error, detail: "⟦detail⟧")
    #expect(line.contains("⟦detail⟧"))
    #expect(line != UICopy.stateCardLine(.error, detail: nil))
  }

  // MARK: Slash commands

  @Test(
    "a command row says the name, then the argument hint and the description when present",
    arguments: [
      (CommandChoice(name: "compact", kind: .local, source: .builtin, description: "⟦description⟧", argumentHint: "⟦hint⟧"),
       "/compact, ⟦hint⟧, ⟦description⟧"),
      (CommandChoice(name: "compact", kind: .local, source: .builtin, description: "⟦description⟧", argumentHint: nil),
       "/compact, ⟦description⟧"),
      (CommandChoice(name: "pr-review-toolkit:review-pr", kind: .prompt, source: .plugin), "/pr-review-toolkit:review-pr"),
    ])
  func commandSuggestionLabel(choice: CommandChoice, expected: String) {
    #expect(UICopy.commandSuggestionLabel(choice) == expected)
  }

  // MARK: Progress

  @Test("progress of an entry in flight rounds down, so 99.9 % is not reported as sent")
  func progressRoundsDown() throws {
    let tile = try #require(UICopy.pendingTile(.progress(0.999), awaitingEcho: false))
    #expect(tile.contains("99\u{00A0}%"))
  }

  // MARK: Attachments in the field

  @Test("an announcement after adding names only the kinds that came, nothing when nothing came")
  func attachmentsAddedNamesTheKindsThatCame() throws {
    #expect(UICopy.attachmentsAdded(images: 0, files: 0) == nil)

    let photos = try #require(UICopy.attachmentsAdded(images: 2, files: 0))
    #expect(photos.contains("2\u{00A0}zdjęcia"))
    #expect(!photos.contains("plik"))

    let files = try #require(UICopy.attachmentsAdded(images: 0, files: 1))
    #expect(files.contains("1\u{00A0}plik"))
    #expect(!files.contains("zdję"))

    let both = try #require(UICopy.attachmentsAdded(images: 1, files: 2))
    #expect(both.contains("1\u{00A0}zdjęcie"))
    #expect(both.contains("2\u{00A0}pliki"))
  }

  @Test("after a removal the count left is of the removed kind only")
  func attachmentRemovedCountsTheSameKind() {
    let afterFile = UICopy.attachmentRemoved(
      .file, remaining: [attachment(.file), attachment(.file), attachment(.image)])
    #expect(afterFile.contains("2\u{00A0}pliki"))
    let afterImage = UICopy.attachmentRemoved(
      .image, remaining: [attachment(.image), attachment(.image), attachment(.file)])
    #expect(afterImage.contains("2\u{00A0}zdjęcia"))
  }

  @Test("a photo tile is named by its number, a file tile by its name")
  func attachmentLabelAndRemoveAction() {
    let photo = attachment(.image, name: "IMG_0001.HEIC", bytes: 0)
    let photoLabel = UICopy.attachmentLabel(photo, imageIndex: 2)
    #expect(photoLabel.contains("2"))
    #expect(photoLabel.hasSuffix("0\u{00A0}kB"))
    #expect(!photoLabel.contains("IMG_0001.HEIC"))

    let report = attachment(.file, name: "raport.pdf", bytes: 0)
    #expect(UICopy.attachmentLabel(report, imageIndex: 1) == "raport.pdf, 0\u{00A0}kB")

    let removePhoto = UICopy.removeAttachment(photo, imageIndex: 3)
    #expect(removePhoto.hasSuffix("3"))
    #expect(!removePhoto.contains("IMG_0001.HEIC"))
    #expect(UICopy.removeAttachment(report, imageIndex: 1).hasSuffix("raport.pdf"))
  }

  // MARK: Rejections

  @Test("too many attachments: the limit and the skipped count, in the noun of the kind")
  func tooManySentence() throws {
    let files = try sentence([rejectedFile("n1", .tooMany), rejectedFile("n2", .tooMany)])
    #expect(files.contains("4\u{00A0}pliki"))
    #expect(files.contains("2\u{00A0}pliki"))
    // A single skipped photo still gets its sentence.
    let photo = try sentence([rejectedImage("n1", .tooMany)])
    #expect(photo.contains("5\u{00A0}zdjęć"))
    #expect(photo.contains("1\u{00A0}zdjęcie"))
  }

  @Test("one photo too large: its weight when known, always the photo limit; an unnamed photo is not quoted")
  func onePhotoTooLarge() throws {
    let weighed = try sentence([rejectedImage("", .tooLarge(bytes: 2_500_000))])
    #expect(weighed.contains("2,4\u{00A0}MB"))
    #expect(weighed.contains("1,5\u{00A0}MB"))
    #expect(!weighed.contains("„"))

    let unweighed = try sentence([rejectedImage("", .tooLarge(bytes: nil))])
    #expect(unweighed.contains("1,5\u{00A0}MB"))
    #expect(!unweighed.contains("„"))
    #expect(unweighed != weighed)
  }

  @Test("one file too large without a weight: the quoted name and the file limit")
  func oneFileTooLargeWithoutWeight() throws {
    let line = try sentence([rejectedFile("IMG_0001.HEIC", .tooLarge(bytes: nil))])
    #expect(line.contains("„IMG_0001.HEIC”"))
    #expect(line.contains("20\u{00A0}MB"))
  }

  @Test("several too large: one sentence with the count and the limit of the kind, no names")
  func severalTooLarge() throws {
    let files = try sentence([rejectedFile("n1", .tooLarge(bytes: nil)), rejectedFile("n2", .tooLarge(bytes: nil))])
    #expect(files.contains("2\u{00A0}pliki"))
    #expect(files.contains("20\u{00A0}MB"))
    #expect(!files.contains("n1"))

    let photos = try sentence([rejectedImage("n1", .tooLarge(bytes: nil)), rejectedImage("n2", .tooLarge(bytes: nil))])
    #expect(photos.contains("2\u{00A0}zdjęcia"))
    #expect(photos.contains("1,5\u{00A0}MB"))
    #expect(!photos.contains("n1"))
  }

  @Test("several unreadable: one sentence with the count in the noun of the kind, no names")
  func severalUnreadable() throws {
    let files = try sentence([rejectedFile("n1", .unreadable), rejectedFile("n2", .unreadable)])
    #expect(files.contains("2\u{00A0}pliki"))
    #expect(!files.contains("n1"))

    let photos = try sentence([rejectedImage("n1", .unreadable), rejectedImage("n2", .unreadable)])
    #expect(photos.contains("2\u{00A0}zdjęcia"))
    #expect(!photos.contains("n1"))
  }

  @Test("a nameless attachment is called by its kind: a file in quotes, a photo without")
  func namelessAttachmentInRejection() throws {
    #expect(try sentence([rejectedFile("", .unreadable)]).contains("„plik”"))
    let photo = try sentence([rejectedImage("", .unreadable)])
    #expect(photo.contains("Zdjęcie"))
    #expect(!photo.contains("„"))
  }

  @Test(
    "a name of up to 32 characters stays whole, a longer one is cut to 31 and an ellipsis",
    arguments: [
      (rejectedFile("bbbbbbbbbbbbbbbbbbbbbbbbbbbb.pdf", .unreadable), "„bbbbbbbbbbbbbbbbbbbbbbbbbbbb.pdf”"),
      (rejectedImage("bbbbbbbbbbbbbbbbbbbbbbbbbbbb.pdf", .tooLarge(bytes: nil)), "„bbbbbbbbbbbbbbbbbbbbbbbbbbbb.pdf”"),
      (rejectedFile("ccccccccccccccccccccccccccccc.pdf", .unreadable), "„ccccccccccccccccccccccccccccc.p…”"),
      (rejectedImage("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg", .tooLarge(bytes: nil)), "„aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa…”"),
    ])
  func quotedNameCutAt32(rejection: AttachmentRejection, quoted: String) throws {
    #expect(try sentence([rejection]).contains(quoted))
  }
}
