import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Branches of the card copy (`UICopy+Cards.swift`): a question card in flight and after
// success without a summary, the section head of a single question, the sentence after an accepted or refused
// dialog decision and after a refused resume. Each test checks the part of the sentence that the input or the
// condition decides, not the wording around it.

@Suite("UICopy branches: cards")
struct UICopyBranchesCardsTests {
  @Test("a question card without a summary names nothing; with one it quotes the summary")
  func questionInFlightAndSentWithoutSummary() {
    for sentence in [UICopy.questionSending, UICopy.questionSent] {
      let bare = sentence("")
      #expect(!bare.isEmpty)
      #expect(!bare.contains("„"), "no empty quote for a missing summary: \(bare)")
      #expect(sentence("⟦summary⟧").contains("„⟦summary⟧”"))
    }
  }

  @Test("a single question shows its header alone; an empty header leaves the head empty")
  func singleQuestionHeadHasNoNumber() {
    // One question (total 1) and the degenerate total 0: no "question n/m" eyebrow, no separator.
    #expect(UICopy.questionSectionHead(index: 0, total: 1, header: "⟦header⟧") == "⟦header⟧")
    #expect(UICopy.questionSectionHead(index: 0, total: 0, header: "⟦header⟧") == "⟦header⟧")
    #expect(UICopy.questionSectionHead(index: 0, total: 1, header: "").isEmpty)
  }

  @Test("an accepted approval speaks the option's own sentence, the fallback only when it is empty")
  func acceptedApprovalSentence() throws {
    let spoken = try #require(UICopy.dialogResult(.accepted, decision: .allow, allowSpoken: "⟦allowSpoken⟧"))
    #expect(spoken.text == "⟦allowSpoken⟧")
    #expect(!spoken.isError)
    let fallback = try #require(UICopy.dialogResult(.accepted, decision: .allow, allowSpoken: ""))
    #expect(fallback.text == UICopy.dialogAllowedFallback)
    #expect(!fallback.isError)
  }

  @Test("a refused dialog decision shows the server's sentence as an error")
  func refusedDialogDecisionKeepsServerSentence() throws {
    let result = try #require(UICopy.dialogResult(.refused(message: "⟦message⟧"), decision: .allow, allowSpoken: ""))
    #expect(result.text == "⟦message⟧")
    #expect(result.isError)
  }

  @Test("a refused resume shows the server's sentence")
  func refusedResumeKeepsServerSentence() {
    #expect(UICopy.resumeResult(.refused(message: "⟦message⟧")) == "⟦message⟧")
  }
}
