import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

@Suite("cache sesji czeka na transkrypt także po świeżej liście")
struct CachedSessionReviewTests {
  private func pendingState(_ session: SessionSummary) -> AppState {
    var state = Sample.state(session: session)
    state.listCache.awaitingTranscripts = [session.id]
    return state
  }

  @Test("karta limitu, błędu, wznowienia i „Nowa sesja” nie staje przed świeżym transkryptem",
        arguments: ["limit-reached", "error", "resumable", "done"])
  func stateCardsNeedTranscript(_ kind: String) {
    var state = pendingState(Sample.session(state: kind))
    #expect(!state.listStale, "świeża lista już przyszła")
    #expect(StateCards.make(state: state, sessionId: "s1") == nil)
    #expect(!ComposerModel.make(state: state, sessionId: "s1").editable)
    state.listCache.awaitingTranscripts.remove("s1")
    #expect(StateCards.make(state: state, sessionId: "s1") != nil)
  }

  @Test("pole pozostaje wygaszone z powodem do transkryptu; potem da się pisać")
  func composerNeedsTranscript() {
    var state = pendingState(Sample.session(state: "waiting-input"))
    #expect(ComposerModel.make(state: state, sessionId: "s1") == ComposerModel(editable: false, reason: UICopy.staleComposer))
    state.listCache.awaitingTranscripts.remove("s1")
    #expect(ComposerModel.make(state: state, sessionId: "s1").editable)
  }
}
