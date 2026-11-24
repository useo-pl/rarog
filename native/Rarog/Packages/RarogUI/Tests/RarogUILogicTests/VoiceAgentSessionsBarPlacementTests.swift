import Foundation
@testable import RarogUI
import Testing

// Where the voice conversation across sessions stands (`VoiceAgentSessionsPlacement`), what stands above the screen
// and in the session screen's and the Inbox's header, and what the session list's header shows of it
// (`VoiceAgentSessionsListHeader`), without a view. The content itself: `VoiceAgentSessionsBarContentTests`.
// Owner: voice agent.

@Suite("voice conversation across sessions: the list header, the session header or the Inbox header")
struct VoiceAgentSessionsBarPlacementTests {
  static let running = VoiceAgentSessionsBarContent(indicator: .listening, running: true)
  static let prompt = VoiceAgentShownPrompt(project: "atlas", name: "demo", text: "Run the tests\nthen report")

  struct Layout: Sendable, CustomTestStringConvertible {
    let name: String
    let stacked: Bool
    let detailOnTop: Bool
    let listHidden: Bool
    let headerOnScreen: Bool
    var testDescription: String { name }
  }

  // Catches: a bar that stands over the list whose header already shows the state (the state twice and the list
  // pushed down), and a state that vanishes where the list header is off screen: a session pushed on iPhone keeps
  // `listHidden` false, so reading only that flag would lose the state there.
  @Test("the list header carries the conversation only where it is on screen", arguments: [
    Layout(name: "iPhone list", stacked: true, detailOnTop: false, listHidden: false, headerOnScreen: true),
    Layout(name: "iPhone session", stacked: true, detailOnTop: true, listHidden: false, headerOnScreen: false),
    Layout(name: "iPhone session, list collapsed", stacked: true, detailOnTop: true, listHidden: true,
           headerOnScreen: false),
    Layout(name: "iPad list beside the session", stacked: false, detailOnTop: true, listHidden: false,
           headerOnScreen: true),
    Layout(name: "iPad list alone", stacked: false, detailOnTop: false, listHidden: false, headerOnScreen: true),
    Layout(name: "iPad list column hidden", stacked: false, detailOnTop: true, listHidden: true,
           headerOnScreen: false),
  ])
  func placement(layout: Layout) {
    let onScreen = VoiceAgentSessionsPlacement.listHeaderOnScreen(
      stacked: layout.stacked, detailOnTop: layout.detailOnTop, listHidden: layout.listHidden)
    #expect(onScreen == layout.headerOnScreen)
  }

  /// A screen of the app: the window's layout, the detail route, and which headers stand on screen there. A stack
  /// shows its top screen alone; beside the list (iPad) the detail column always stands, and every route of
  /// `DetailView` (also the Inbox there) has the session header. In the stack the Inbox at the root has its own header,
  /// covered by the session header of a session opened from a card.
  struct Screen: Sendable, CustomTestStringConvertible {
    let name: String
    let stacked: Bool
    let detailOnTop: Bool
    let listHidden: Bool
    let inboxOnTop: Bool
    let place: VoiceAgentSessionsPlacement
    var testDescription: String { name }

    var listVisible: Bool { stacked ? !detailOnTop : !listHidden }
    var sessionVisible: Bool { stacked ? detailOnTop && !inboxOnTop : true }
    var inboxVisible: Bool { stacked && detailOnTop && inboxOnTop }
  }

  /// Every layout and route: the list on top or a detail route, the list column shown or hidden (a stack keeps
  /// `listHidden` from the wide window), the Inbox on the route or a session (also one opened from an Inbox card, and
  /// a terminal route, which stand on the session header alike).
  static let screens: [Screen] = [
    Screen(name: "iPhone list", stacked: true, detailOnTop: false, listHidden: false, inboxOnTop: false,
           place: .listHeader),
    Screen(name: "iPhone list, list collapsed before", stacked: true, detailOnTop: false, listHidden: true,
           inboxOnTop: false, place: .listHeader),
    Screen(name: "iPhone session or terminal", stacked: true, detailOnTop: true, listHidden: false, inboxOnTop: false,
           place: .sessionHeader),
    Screen(name: "iPhone session, list collapsed before", stacked: true, detailOnTop: true, listHidden: true,
           inboxOnTop: false, place: .sessionHeader),
    Screen(name: "iPhone Inbox at the stack's root", stacked: true, detailOnTop: true, listHidden: false,
           inboxOnTop: true, place: .inboxHeader),
    Screen(name: "iPhone Inbox, list collapsed before", stacked: true, detailOnTop: true, listHidden: true,
           inboxOnTop: true, place: .inboxHeader),
    Screen(name: "iPad list beside a session", stacked: false, detailOnTop: true, listHidden: false,
           inboxOnTop: false, place: .listHeader),
    Screen(name: "iPad list beside the Inbox", stacked: false, detailOnTop: true, listHidden: false, inboxOnTop: true,
           place: .listHeader),
    Screen(name: "iPad list beside nothing chosen", stacked: false, detailOnTop: false, listHidden: false,
           inboxOnTop: false, place: .listHeader),
    Screen(name: "iPad session, list column hidden", stacked: false, detailOnTop: true, listHidden: true,
           inboxOnTop: false, place: .sessionHeader),
    Screen(name: "iPad Inbox, list column hidden", stacked: false, detailOnTop: true, listHidden: true,
           inboxOnTop: true, place: .sessionHeader),
  ]

  // Catches: a screen without a header that carries the circle (the running conversation could not be ended there),
  // the Inbox at the stack's root sent to the session header it does not have, and the iPad Inbox sent to the
  // Inbox's own header, which only the stack builds.
  @Test("every screen: the header on screen that shows the conversation", arguments: screens)
  func place(screen: Screen) {
    let place = VoiceAgentSessionsPlacement.of(
      stacked: screen.stacked, detailOnTop: screen.detailOnTop, listHidden: screen.listHidden,
      inboxOnTop: screen.inboxOnTop)
    #expect(place == screen.place)
    switch place {
    case .listHeader: #expect(screen.listVisible, "the list header on screen")
    case .sessionHeader: #expect(screen.sessionVisible && !screen.listVisible, "the session header alone")
    case .inboxHeader: #expect(screen.inboxVisible && !screen.listVisible, "the Inbox's header alone")
    }
  }

  // Catches: the lit circle twice (the list header beside the session header on iPad), nowhere, or in a header that
  // is off screen; an end sentence lost or shown twice; a waiting prompt's card missing or twice; and anything above
  // the screen while the conversation only runs, which would move the screen at every start.
  @Test("every screen: one circle while the conversation runs, one end sentence after it, one prompt card",
    arguments: screens)
  func invariant(screen: Screen) {
    let prompting = VoiceAgentSessionsBarContent(indicator: .listening, running: true, prompt: Self.prompt)
    let ended = VoiceAgentSessionsBarContent(indicator: .ended(.speechOff), running: false)
    let place = screen.place
    for content in [nil, Self.running, prompting, ended] {
      let name = "\(screen.name), \(String(describing: content))"
      // The list header and its strip do not read the place: they stand where the list is on screen.
      let list = screen.listVisible ? VoiceAgentSessionsListHeader.make(content: content, action: nil) : nil
      var circles = 0, sentences = 0, cards = 0
      if case .circle = list?.trailing { circles += 1 }
      if screen.sessionVisible, place.sessionHeaderCircle(content) != nil { circles += 1 }
      if screen.inboxVisible, place.inboxHeaderCircle(content) != nil { circles += 1 }
      switch list?.strip {
      case .prompt: cards += 1
      case .notice: sentences += 1
      case .none?, nil: break
      }
      switch place.above(content) {
      case let .notice(indicator):
        #expect(indicator == content?.indicator, "\(name): the end sentence's own state")
        sentences += 1
      case let .prompt(prompted):
        #expect(prompted.prompt != nil, "\(name): the card above the screen only with a waiting prompt")
        cards += 1
      case nil:
        break
      }
      let running = content?.running ?? false
      #expect(circles == (running ? 1 : 0), "\(name): \(circles) lit circles")
      #expect(sentences == (content != nil && !running ? 1 : 0), "\(name): \(sentences) end sentences")
      #expect(cards == (content?.prompt == nil ? 0 : 1), "\(name): \(cards) prompt cards")
      if content == Self.running {
        #expect(place.above(content) == nil, "\(name): nothing above the screen while the conversation only runs")
      }
    }
  }

  // Catches: an Inbox at the stack's root whose header loses the circle while a session opened from a card covers it
  // and while Back pops that session (the route names the session until the pop ends), so the circle would appear
  // late on the uncovered Inbox; and a circle in the Inbox's header where the list header carries it.
  @Test("the Inbox's header keeps the circle under a session opened from a card, not beside the list header")
  func inboxHeaderUnderAPushedSession() {
    let covered = VoiceAgentSessionsPlacement.of(stacked: true, detailOnTop: true, listHidden: false, inboxOnTop: false)
    #expect(covered == .sessionHeader)
    #expect(covered.inboxHeaderCircle(Self.running) == .listening)
    #expect(covered.sessionHeaderCircle(Self.running) == .listening)
    #expect(VoiceAgentSessionsPlacement.listHeader.inboxHeaderCircle(Self.running) == nil)
    #expect(VoiceAgentSessionsPlacement.inboxHeader.sessionHeaderCircle(Self.running) == nil)
  }

  @Test("the headers' circle takes the state's indicator")
  func headerCircleIndicator() {
    let answering = VoiceAgentSessionsBarContent(indicator: .answering, running: true)
    #expect(VoiceAgentSessionsPlacement.sessionHeader.sessionHeaderCircle(answering) == .answering)
    #expect(VoiceAgentSessionsPlacement.inboxHeader.inboxHeaderCircle(answering) == .answering)
  }


  // Catches: a header that swaps the title for the state or leaves the waveform glyph while the conversation runs,
  // so the lit circle that ends it is nowhere on the list screen, and a strip that pushes the list down while the
  // conversation only runs.
  @Test("a running conversation: the title stays and the lit circle in the state's tone stands in place of the glyph",
    arguments: [VoiceAgentIndicator.connecting, .listening, .answering, .muted])
  func running(indicator: VoiceAgentIndicator) {
    let content = VoiceAgentSessionsBarContent(indicator: indicator, running: true)
    let header = VoiceAgentSessionsListHeader.make(content: content, action: .running)
    #expect(header == VoiceAgentSessionsListHeader(trailing: .circle(indicator), strip: .none))
  }

  // Catches: a waiting prompt whose card does not stand under the header, and a card that does not say what the
  // user answers now that no state sentence stands in the header.
  @Test("a waiting prompt: the lit circle stays and the card in the strip opens with the question")
  func waitingPrompt() throws {
    let content = VoiceAgentSessionsBarContent(
      indicator: .listening, running: true, prompt: Self.prompt)
    let header = VoiceAgentSessionsListHeader.make(content: content, action: .running)
    #expect(header == VoiceAgentSessionsListHeader(trailing: .circle(.listening), strip: .prompt(Self.prompt)))
    let caption = try #require(content.stripPromptCaption)
    #expect(caption.question == UICopy.voiceAgentSessionsPromptQuestion)
    #expect(caption.question + caption.tail == UICopy.list([caption.question, "atlas", "demo"], .dot))
    let plain = VoiceAgentSessionsBarContent(indicator: .listening, running: true)
    #expect(plain.stripPromptCaption == nil)
  }

  // Catches: an end sentence with no place on the list screen, and a header that keeps the lit circle after the
  // end.
  @Test("after the end: the glyph comes back and the end sentence stands in the strip",
    arguments: [VoiceAgentIndicator.closed(.background), .ended(.speechFailed)])
  func ended(indicator: VoiceAgentIndicator) {
    let header = VoiceAgentSessionsListHeader.make(
      content: VoiceAgentSessionsBarContent(indicator: indicator, running: false), action: .start)
    #expect(header == VoiceAgentSessionsListHeader(trailing: .glyph, strip: .notice(indicator)))
    #expect(indicator.tone == .err, "the strip's dot in the error tone")
  }

  @Test("no conversation: the glyph where the mode is offered, nothing where it is not, no strip")
  func idle() {
    for action in [VoiceAgentSessionsListAction.start, .consent] {
      #expect(
        VoiceAgentSessionsListHeader.make(content: nil, action: action)
          == VoiceAgentSessionsListHeader(trailing: .glyph, strip: .none))
    }
    for action in [VoiceAgentSessionsListAction.hidden, nil] {
      #expect(
        VoiceAgentSessionsListHeader.make(content: nil, action: action)
          == VoiceAgentSessionsListHeader(trailing: .none, strip: .none))
    }
  }

  // Catches: a conversation that still runs after the mode stopped being offered (its end follows the store's next
  // change) losing the circle that ends it, and an owner that runs before the slot hands its state on showing the
  // waveform glyph, whose tap would end it.
  @Test("a running conversation keeps the lit circle where the mode is no longer offered and before its state")
  func runningWithoutTheMode() {
    let action = VoiceAgentSessionsListAction.make(entry: .hidden, isActive: true)
    #expect(action == .running)
    #expect(VoiceAgentSessionsListHeader.make(content: Self.running, action: action).trailing == .circle(.listening))
    #expect(VoiceAgentSessionsListHeader.make(content: nil, action: action).trailing == .circle(.connecting))
  }
}
