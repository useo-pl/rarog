import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The macOS folder banners: the list banner in the global strip and the session banner over the transcript, their
// place in the strip and their texts (Polish, as every logic test).

private let utc = TimeZone(identifier: "UTC")!

private func session(_ id: String, cwd: String, title: String = "atlas", label: String? = nil) -> SessionSummary {
  let labelField = label.map { #""label":"\#($0)","# } ?? ""
  return Sample.decode(SessionSummary.self, #"""
    {"id":"\#(id)","cwd":"\#(cwd)","title":"\#(title)",\#(labelField)"state":"running",
     "stateSince":"\#(Sample.iso(30))","createdAt":"\#(Sample.iso(600))","lastActivityAt":"\#(Sample.iso(60))"}
    """#)
}

private func block(_ name: String, _ state: String = "waiting", since: String = "2026-10-03T14:32:00.000Z") -> String {
  #"{"name":"\#(name)","path":"/Users/demo/\#(name)","state":"\#(state)","since":"\#(since)"}"#
}

/// The state with these sessions (the viewed one is `s1`) and the closed folders from a `folder-access` frame.
private func state(_ sessions: [SessionSummary], blocked: [String]) -> AppState {
  var state = AppState(clientBuild: 1)
  for session in sessions { state.sessions[session.id] = session }
  state.sessionsLoaded = true
  state.global = .online
  state.compat = .ok
  state.viewedSessionId = sessions.first?.id
  let frame = Sample.decode(ServerEvent.self, #"{"type":"folder-access","blocked":[\#(blocked.joined(separator: ","))]}"#)
  state.apply(.frame(frame, source: .global, cursor: nil), now: Sample.now)
  return state
}

private func failed() -> ConnectionMemory {
  var memory = ConnectionMemory()
  memory.observe(.connecting(since: Sample.now.addingTimeInterval(-5)), now: Sample.now.addingTimeInterval(-5))
  memory.observe(.offline(since: Sample.now), now: Sample.now)
  return memory
}

private func cards(_ slots: [BannerSlot]) -> [MacFolderCard] {
  slots.compactMap { if case let .macFolders(card) = $0 { card } else { nil } }
}

private func listCard(_ state: AppState) -> MacFolderCard? {
  cards(state.bannerSlots(in: .list, global: ConnectionMemory(), transcript: ConnectionMemory(), timeZone: utc)).first
}

private func sessionCard(_ state: AppState, _ sessionId: String = "s1") -> MacFolderCard? {
  let column = BannerColumn.detail(sessionId: sessionId, listVisible: true)
  return cards(state.bannerSlots(in: column, global: ConnectionMemory(), transcript: ConnectionMemory(), timeZone: utc)).first
}

private let desktop = "/Users/demo/Desktop"

struct MacFolderBannerTests {
  @Test("list strip order: herdr, the folder banner, push notifications")
  func order() {
    var state = state([session("s1", cwd: "\(desktop)/atlas")], blocked: [block("Desktop")])
    state.herdr = HerdrStatus(available: false, agentCount: 0, readOnly: false, canLaunch: false, detail: "gniazdo milczy")
    state.apply(.push(.status(enabled: true, degradedSince: Sample.iso(900))), now: Sample.now)
    let slots = state.bannerSlots(in: .list, global: ConnectionMemory(), transcript: ConnectionMemory(), timeZone: utc)
    let kinds = slots.map { slot -> String in
      switch slot {
      case let .banner(banner): if case .herdrUnavailable = banner { "herdr" } else if case .pushDegraded = banner { "push" } else { "other" }
      case .macFolders: "folders"
      }
    }
    #expect(kinds == ["herdr", "folders", "push"])
    #expect(cards(slots).map(\.tone) == [.wait], "amber: the Mac waits for a click")
  }

  @Test("no server: no folder banner in any column; an older server (no frame): no folder banner")
  func noServer() {
    var down = state([session("s1", cwd: "\(desktop)/atlas")], blocked: [block("Desktop")])
    down.global = .offline(since: Sample.now)
    for column in [BannerColumn.list, .detail(sessionId: "s1", listVisible: false), .detail(sessionId: "s1", listVisible: true)] {
      #expect(cards(down.bannerSlots(in: column, global: failed(), transcript: failed(), timeZone: utc)).isEmpty)
    }
    let older = state([session("s1", cwd: "\(desktop)/atlas")], blocked: [])
    #expect(listCard(older) == nil)
    #expect(sessionCard(older) == nil)
    #expect(older.bannerSlots(in: .list, global: ConnectionMemory(), transcript: ConnectionMemory(), timeZone: utc).isEmpty)
  }

  @Test("three states, three texts; the list banner says the reach and what to do")
  func states() {
    let sessions = [session("s1", cwd: "\(desktop)/atlas")]
    #expect(listCard(state(sessions, blocked: [block("Desktop")])) == MacFolderCard(
      title: "Prawdopodobnie na Macu czeka okno",
      detail: "Zgoda macOS dla Biurka, od 14:32. Dotyczy sesji atlas; pozostałe działają normalnie. "
        + "Kliknij „Pozwól” przy Macu."))
    #expect(listCard(state(sessions, blocked: [block("Desktop", "denied")])) == MacFolderCard(
      title: "macOS nie wpuszcza Raroga do Biurka",
      detail: "Dotyczy sesji atlas; pozostałe działają normalnie. "
        + "Zmień w Ustawieniach Maca (Prywatność i ochrona → Pliki i foldery)."))
    #expect(listCard(state(sessions, blocked: [block("Desktop", "unchecked")])) == MacFolderCard(
      title: "Rarog nie umie sprawdzić dostępu do Biurka",
      detail: "Dotyczy sesji atlas; pozostałe działają normalnie. Szczegóły w logu serwera."))
  }

  @Test("the three folders by their Finder names in the app language; any other name as the server gives it")
  func names() {
    let documents = state([], blocked: [block("Documents", "denied")])
    #expect(listCard(documents)?.title == "macOS nie wpuszcza Raroga do Dokumentów")
    let downloads = state([], blocked: [block("Downloads", "unchecked")])
    #expect(listCard(downloads)?.title == "Rarog nie umie sprawdzić dostępu do Pobranych rzeczy")
    let movies = state([], blocked: [block("Movies", "denied")])
    #expect(listCard(movies)?.title == "macOS nie wpuszcza Raroga do Movies")
    #expect(listCard(movies)?.detail.hasPrefix("Sesje działają normalnie; Movies nie da się teraz otworzyć") == true)
  }

  @Test("reach of the list banner: one session by name, several by count, none in a sentence without sessions")
  func reach() {
    let one = state([session("s1", cwd: "\(desktop)/atlas", label: "logowanie"), session("s2", cwd: "/Users/demo/Projects/b")],
                    blocked: [block("Desktop")])
    #expect(listCard(one)?.detail.contains("Dotyczy sesji atlas · logowanie; pozostałe działają normalnie.") == true)
    let three = state([
      session("s1", cwd: "\(desktop)/a"), session("s2", cwd: "\(desktop)/b"), session("s3", cwd: desktop),
      session("s4", cwd: "/Users/demo/Projects/d"),
    ], blocked: [block("Desktop")])
    #expect(listCard(three)?.detail.contains("Dotyczy 3 sesji w Biurku; pozostałe działają normalnie.") == true)
    let none = state([session("s1", cwd: "/Users/demo/Projects/a")], blocked: [block("Desktop")])
    #expect(listCard(none)?.detail
      == "Zgoda macOS dla Biurka, od 14:32. Sesje działają normalnie; Biurka nie da się teraz otworzyć w nowej sesji. "
      + "Kliknij „Pozwól” przy Macu.")
  }

  @Test("session banner: the session's directory is the folder or under it; another folder or a lookalike name: none")
  func sessionBanner() {
    let waiting = MacFolderCard(
      title: "Rarog nie widzi plików tej sesji",
      detail: "Wiadomości i zgody działają; git, pliki i załączniki nie, bo prawdopodobnie na Macu czeka okno zgody "
        + "macOS dla Biurka. Kliknij „Pozwól” przy Macu.")
    #expect(sessionCard(state([session("s1", cwd: "\(desktop)/atlas")], blocked: [block("Desktop")])) == waiting)
    #expect(sessionCard(state([session("s1", cwd: desktop)], blocked: [block("Desktop")])) == waiting)
    #expect(sessionCard(state([session("s1", cwd: "/Users/demo/Desktop2")], blocked: [block("Desktop")])) == nil)
    #expect(sessionCard(state([session("s1", cwd: "/Users/demo/Documents/p")], blocked: [block("Desktop")])) == nil)
    let denied = sessionCard(state([session("s1", cwd: "\(desktop)/atlas")], blocked: [block("Desktop", "denied")]))
    #expect(denied?.detail == "Wiadomości i zgody działają; git, pliki i załączniki nie, bo macOS nie wpuszcza Raroga "
      + "do Biurka — zmień w Ustawieniach Maca (Prywatność i ochrona → Pliki i foldery).")
    let unchecked = sessionCard(state([session("s1", cwd: "\(desktop)/atlas")], blocked: [block("Desktop", "unchecked")]))
    #expect(unchecked?.detail == "Wiadomości i zgody działają; git, pliki i załączniki nie, bo Rarog nie umie sprawdzić "
      + "dostępu do Biurka — szczegóły w logu serwera.")
  }

  @Test("session column without the list (phone): the session banner alone; a session elsewhere gets the list banner")
  func phone() {
    let inside = state([session("s1", cwd: "\(desktop)/atlas")], blocked: [block("Desktop")])
    let alone = BannerColumn.detail(sessionId: "s1", listVisible: false)
    let here = cards(inside.bannerSlots(in: alone, global: ConnectionMemory(), transcript: ConnectionMemory(), timeZone: utc))
    #expect(here.map(\.title) == ["Rarog nie widzi plików tej sesji"])
    let outside = state([session("s1", cwd: "/Users/demo/Projects/a")], blocked: [block("Desktop")])
    let there = cards(outside.bannerSlots(in: alone, global: ConnectionMemory(), transcript: ConnectionMemory(), timeZone: utc))
    #expect(there.map(\.title) == ["Prawdopodobnie na Macu czeka okno"])
    #expect(cards(inside.bannerSlots(
      in: .detail(sessionId: "s1", listVisible: true), global: ConnectionMemory(), transcript: ConnectionMemory(),
      timeZone: utc)).map(\.title) == ["Rarog nie widzi plików tej sesji"], "beside the list: only the session banner")
  }

  @Test("several folders in one banner: the state that needs a click leads, the others follow in a sentence each")
  func severalFolders() {
    let mixed = state([], blocked: [block("Desktop"), block("Documents", "denied"), block("Downloads")])
    #expect(listCard(mixed) == MacFolderCard(
      title: "Prawdopodobnie na Macu czeka okno",
      detail: "Zgoda macOS dla Biurka, Pobranych rzeczy, od 14:32. Sesje działają normalnie; Biurka, Dokumentów, "
        + "Pobranych rzeczy nie da się teraz otworzyć w nowej sesji. Kliknij „Pozwól” przy Macu. "
        + "macOS nie wpuszcza Raroga do Dokumentów."))
  }

  @Test("the strip's clock: the connecting card waits for its moment, the folder card stands at once")
  func clock() {
    let due = Sample.now.addingTimeInterval(1)
    let slots: [BannerSlot] = [
      .banner(.connecting(visibleFrom: due)), .macFolders(MacFolderCard(title: "t", detail: "d")),
    ]
    #expect(slots.visible(at: Sample.now) == [.macFolders(MacFolderCard(title: "t", detail: "d"))])
    #expect(slots.visible(at: due) == slots)
    #expect(slots.pendingUntil(Sample.now) == due)
    #expect(slots.pendingUntil(due) == nil)
  }

  @Test("a time the app cannot read: the sentence without the time")
  func unreadableSince() {
    let odd = state([], blocked: [block("Desktop", since: "soon")])
    #expect(listCard(odd)?.detail.hasPrefix("Zgoda macOS dla Biurka. Sesje działają normalnie;") == true)
  }
}
