import Foundation
import RarogCore
@testable import RarogUI
import Testing

// Texts of the jump pill of the session list: the parts the view colors by state and the VoiceOver
// sentence, in Polish and English, at counts 1, 2 and 5. The rule: `ListJumpPillTests`. Owner: list.

@Suite("list jump pill: texts")
struct ListJumpPillCopyTests {
  private typealias Pill = ListJumpPill
  private typealias Segment = ListJumpPill.Segment

  private func text(_ segments: [Segment]) -> String { segments.map(\.text).joined() }

  @Test("one session: the state phrase in its color, the direction and the name in ink")
  func oneSession() {
    let waiting = Pill.Side(waiting: 1, name: "rotate keys", target: "a")
    let en = UICopy.listJumpSegments(waiting, .below, language: .en)
    #expect(text(en) == "1 waiting below ↓ · rotate keys")
    #expect(en == [
      Segment("1 waiting", .state(.waiting)), Segment(" below ↓", .plain), Segment(" · ", .plain),
      Segment("rotate keys", .name),
    ])
    #expect(text(UICopy.listJumpSegments(waiting, .below, language: .pl)) == "1 czeka poniżej ↓ · rotate keys")

    let unread = Pill.Side(unread: 1, name: "note saving", target: "b")
    #expect(text(UICopy.listJumpSegments(unread, .above, language: .en)) == "1 unread above ↑ · note saving")
    #expect(text(UICopy.listJumpSegments(unread, .above, language: .pl)) == "1 nieodebrany powyżej ↑ · note saving")
    let failed = Pill.Side(failed: 1, name: "deploy", target: "c")
    #expect(text(UICopy.listJumpSegments(failed, .above, language: .pl)) == "1 błąd powyżej ↑ · deploy")
    #expect(UICopy.listJumpSegments(failed, .above, language: .pl).first == Segment("1 błąd", .state(.failed)))
  }

  @Test("several sessions: the count and direction in ink, then only the non-zero states, waiting, failed, unread")
  func severalSessions() {
    let three = Pill.Side(waiting: 1, failed: 1, unread: 1, target: "a")
    let en = UICopy.listJumpSegments(three, .below, language: .en)
    #expect(text(en) == "3 below ↓ · 1 waiting, 1 failed, 1 unread")
    #expect(en == [
      Segment("3 below ↓", .plain), Segment(" · ", .plain), Segment("1 waiting", .state(.waiting)),
      Segment(", ", .plain), Segment("1 failed", .state(.failed)), Segment(", ", .plain),
      Segment("1 unread", .state(.unread)),
    ])
    #expect(text(UICopy.listJumpSegments(three, .below, language: .pl))
      == "3 poniżej ↓ · 1 czeka, 1 błąd, 1 nieodebrany")

    let twoWaiting = Pill.Side(waiting: 2, target: "a")
    #expect(text(UICopy.listJumpSegments(twoWaiting, .above, language: .en)) == "2 above ↑ · 2 waiting")
    #expect(text(UICopy.listJumpSegments(twoWaiting, .above, language: .pl)) == "2 powyżej ↑ · 2 czekają")

    let unreadAndFailed = Pill.Side(failed: 2, unread: 5, target: "a")
    let pl = UICopy.listJumpSegments(unreadAndFailed, .below, language: .pl)
    #expect(text(pl) == "7 poniżej ↓ · 2 błędy, 5 nieodebranych", "no waiting part, failed before unread")
    let states: [ListJumpPill.Attention] = pl.compactMap { segment in
      if case let .state(state) = segment.role { return state }
      return nil
    }
    #expect(states == [.failed, .unread])
    #expect(text(UICopy.listJumpSegments(unreadAndFailed, .below, language: .en))
      == "7 below ↓ · 2 failed, 5 unread")
  }

  @Test("Polish plurals of the state parts at 1, 2 and 5")
  func polishPlurals() {
    let cases: [(Pill.Side, String)] = [
      (Pill.Side(waiting: 5, target: "a"), "5 poniżej ↓ · 5 czeka"),
      (Pill.Side(failed: 5, target: "a"), "5 poniżej ↓ · 5 błędów"),
      (Pill.Side(unread: 2, target: "a"), "2 poniżej ↓ · 2 nieodebrane"),
      (Pill.Side(waiting: 2, failed: 2, unread: 1, target: "a"),
       "5 poniżej ↓ · 2 czekają, 2 błędy, 1 nieodebrany"),
    ]
    for (side, expected) in cases {
      #expect(text(UICopy.listJumpSegments(side, .below, language: .pl)) == expected)
    }
  }

  @Test("VoiceOver: a full sentence without arrows and dots, the session count in plural")
  func spoken() {
    let three = Pill.Side(waiting: 1, failed: 1, unread: 1, target: "a")
    #expect(UICopy.listJumpSpoken(three, .below, language: .pl) == "3 sesje poniżej: 1 czeka, 1 błąd, 1 nieodebrany")
    #expect(UICopy.listJumpSpoken(three, .below, language: .en) == "3 sessions below: 1 waiting, 1 failed, 1 unread")
    let five = Pill.Side(waiting: 5, target: "a")
    #expect(UICopy.listJumpSpoken(five, .above, language: .pl) == "5 sesji powyżej: 5 czeka")
    #expect(UICopy.listJumpSpoken(five, .above, language: .en) == "5 sessions above: 5 waiting")
    let one = Pill.Side(waiting: 1, name: "rotate keys", target: "a")
    #expect(UICopy.listJumpSpoken(one, .below, language: .pl) == "1 sesja poniżej: 1 czeka, rotate keys")
    #expect(UICopy.listJumpSpoken(one, .below, language: .en) == "1 session below: 1 waiting, rotate keys")
   }
}
