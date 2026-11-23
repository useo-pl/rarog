import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

@Suite("formatowanie: czas, liczebniki, ścieżki")
struct FormattingTests {
  @Test("czas względny krótki i mówiony")
  func relative() {
    let now = Sample.now
    #expect(RelativeTime.short(since: now.addingTimeInterval(-12), now: now) == "12\u{00A0}s")
    #expect(RelativeTime.short(since: now.addingTimeInterval(-240), now: now) == "4\u{00A0}min")
    #expect(RelativeTime.short(since: now.addingTimeInterval(-7500), now: now) == "2\u{00A0}h\u{00A0}05")
    #expect(RelativeTime.short(since: now.addingTimeInterval(-3 * 86_400), now: now) == "3\u{00A0}d")
    #expect(RelativeTime.short(since: now.addingTimeInterval(-36 * 3600), now: now) == "1\u{00A0}d", "days truncate, 36 h is 1 day")
    #expect(RelativeTime.short(since: now.addingTimeInterval(30), now: now) == "0\u{00A0}s", "zegar Maca do przodu")
    #expect(RelativeTime.spoken(since: now.addingTimeInterval(-240), now: now) == "4 minuty")
    #expect(RelativeTime.spoken(since: now.addingTimeInterval(-12 * 60), now: now) == "12 minut")
    #expect(RelativeTime.spokenSince(since: now.addingTimeInterval(-60), now: now) == "1 minuty")
    #expect(RelativeTime.spokenSince(since: now.addingTimeInterval(-240), now: now) == "4 minut")
    #expect(RelativeTime.spokenSince(since: now.addingTimeInterval(-86_400), now: now) == "1 dnia")
  }

  @Test("ile temu: zgrubnie, bez sekund i bez minut po godzinie; na głos biernik")
  func ago() {
    let now = Sample.now
    let ago = { (seconds: TimeInterval) in RelativeTime.ago(since: now.addingTimeInterval(-seconds), now: now) }
    #expect(ago(12) == "przed\u{00A0}chwilą")
    #expect(ago(240) == "4\u{00A0}min\u{00A0}temu")
    #expect(ago(7500) == "2\u{00A0}h\u{00A0}temu", "po godzinie same godziny: dokładną chwilę mówi godzina obok")
    #expect(ago(3 * 86_400) == "3\u{00A0}d\u{00A0}temu")
    #expect(ago(-30) == "przed\u{00A0}chwilą", "zegar Maca do przodu")
    let spoken = { (seconds: TimeInterval) in RelativeTime.spokenAgo(since: now.addingTimeInterval(-seconds), now: now) }
    #expect(spoken(12) == "przed chwilą")
    #expect(spoken(60) == "1 minutę temu")
    #expect(spoken(240) == "4 minuty temu")
    #expect(spoken(3600) == "1 godzinę temu")
    #expect(spoken(5 * 3600) == "5 godzin temu")
    #expect(spoken(86_400) == "1 dzień temu")
  }

  @Test("ścieżki: katalog domowy → ~, skracanie do 3 segmentów, adresy nietknięte")
  func paths() {
    #expect(PathText.shortPath("/Users/testowy/Projects/willow") == "~/Projects/willow")
    #expect(PathText.shortPath("/home/u/Projects/willow") == "~/Projects/willow", "server on Linux")
    #expect(PathText.projectName("/Users/demo/Projects/willow/") == "willow")
    #expect(PathText.projectName("/") == "/", "root: the short path, not an empty name")
    #expect(PathText.shortenPaths("Edit: /Users/d/Projects/ACME/rarog/web/src/views/composer.ts")
      == "Edit: …/src/views/composer.ts")
    #expect(PathText.shortenPaths("curl https://host/a/b/c/d/e") == "curl https://host/a/b/c/d/e")
    // A path right after `:` belongs to an address (`host:/path` of scp and rsync), so it stays whole.
    #expect(PathText.shortenPaths("scp host:/srv/app/logs/x.log .") == "scp host:/srv/app/logs/x.log .")
    #expect(PathText.shortenPaths("ls /Users/d/Projects") == "ls ~/Projects")
    // Exactly three segments stay whole; `~` of the home directory is not a segment.
    #expect(PathText.shortenPaths("ls /Users/x/a/b/c") == "ls ~/a/b/c")
    #expect(PathText.shortenPaths("ls /a/b/c") == "ls /a/b/c")
  }

  @Test("czas serwera: z milisekundami i bez")
  func serverTime() {
    #expect(ServerTime.parse("2026-10-04T10:00:00.123Z") != nil)
    #expect(ServerTime.parse("2026-10-04T10:00:00Z") != nil)
    #expect(ServerTime.parse("wczoraj") == nil)
    #expect(ServerTime.clock("2026-10-04T10:05:00Z", timeZone: TimeZone(identifier: "UTC")!) == "10:05")
  }

  /// Godzina idzie za regionem i preferencją urządzenia, data — za wzorcem z katalogu i językiem locale.
  /// Język, region i strefa jawnie: wynik nie zależy od Maca, na którym biegnie test.
  @Test("czas serwera z jawnym locale i strefą: 24 h w polskim regionie (także po angielsku), 12 h w amerykańskim")
  func serverTimeLocale() throws {
    let iso = "2026-10-09T19:40:00Z"
    let warsaw = try #require(TimeZone(identifier: "Europe/Warsaw"))
    let auckland = try #require(TimeZone(identifier: "Pacific/Auckland"))
    #expect(ServerTime.clock(iso, timeZone: warsaw, locale: Locale(identifier: "pl_PL")) == "21:40")
    #expect(ServerTime.clock(iso, timeZone: warsaw, locale: Locale(identifier: "en_PL")) == "21:40")
    #expect(ServerTime.clock(iso, timeZone: warsaw, locale: Locale(identifier: "pl_US")) == "9:40\u{202F}PM")
    #expect(ServerTime.clock(iso, timeZone: auckland, locale: Locale(identifier: "pl_PL")) == "08:40")
    let date = try #require(ServerTime.parse(iso))
    #expect(ServerTime.day(date, timeZone: warsaw, locale: Locale(identifier: "pl_PL")) == "9 paź")
    #expect(ServerTime.day(date, timeZone: auckland, locale: Locale(identifier: "pl_PL")) == "10 paź", "inny dzień w Auckland")
    #expect(ServerTime.dayClock(date, timeZone: warsaw, locale: Locale(identifier: "pl_PL")) == "9 paź 21:40")
    #expect(ServerTime.dayYear(date, timeZone: warsaw, locale: Locale(identifier: "pl_PL")) == "9 paź 2026")
    #expect(ServerTime.dayNumericClock(date, timeZone: warsaw, locale: Locale(identifier: "pl_PL")) == "09.10\u{00A0}21:40")
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = warsaw
    #expect(TimeGap.day(date, calendar: calendar, locale: Locale(identifier: "pl_PL")) == "pt. 9 paź")
    #expect(TimeGap.spokenDay(date, calendar: calendar, locale: Locale(identifier: "pl_PL")) == "Piątek, 9 października")
  }
}

@Suite("copy: wysyłka, decyzje")
struct CopyTests {
  @Test("wysyłka: odmowa oddaje tekst do pola ze zdaniem serwera, pusta bez zdania")
  func send() {
    let refused = UICopy.sendResult(.refused(UUID(), code: "refused", message: "Limit tempa."), session: nil)
    #expect(refused.text == "Limit tempa. Wiadomość wróciła do pola." && refused.restore && refused.isError)
    let empty = UICopy.sendResult(.empty, session: nil)
    #expect(empty.text == nil && !empty.isError && !empty.restore)
    #expect(UICopy.sendResult(.accepted(UUID()), session: nil).text == nil)
    #expect(UICopy.sendResult(.unconfirmed(UUID()), session: nil).restore == false, "wpis zostaje w transkrypcie")
  }

  @Test("decyzje: 409/410 bez zdania pod kartą (karta znika ze śladem), 422 i sieć zostają")
  func decisions() {
    #expect(UICopy.decisionResult(.alreadyDecided) == nil)
    #expect(UICopy.decisionResult(.expired) == nil)
    #expect(UICopy.decisionResult(.refused(message: "Panel nie przyjął.")) == "Panel nie przyjął.")
    #expect(UICopy.decisionResult(.failed) == "Nie udało się wysłać. Spróbuj ponownie.")
    #expect(UICopy.notice(.resolvedElsewhere(by: "iPhone")) == "Decyzja zapadła już na innym urządzeniu.")
  }

  @Test("limit planu z godziną resetu albo bez")
  func limit() {
    #expect(UICopy.limitLine("tekst bez godziny") == "Limit planu — spróbuj później.")
    #expect(UICopy.limitLine("resetAt=2026-10-04T12:00:00Z").hasPrefix("Limit planu — spróbuj po "))
  }

  @Test("limit planu: godzina z `stateDetailRef.args[0]`, regex `resetAt=` jako zapas dla starego serwera")
  func limitFromRef() {
    let utc = TimeZone(identifier: "UTC")!
    let ref = SentenceRef(code: "state.limit-reached", args: ["2026-10-04T12:00:00Z"])
    #expect(UICopy.limitLine("resetAt=2026-10-04T12:00:00Z", ref: ref, timeZone: utc) == "Limit planu — spróbuj po 12:00.")
    #expect(UICopy.limitLine(nil, ref: ref, timeZone: utc) == "Limit planu — spróbuj po 12:00.")
    // Reducer podaje `stateDetail` już przetłumaczony: godzina idzie z `args[0]`, nie z tekstu.
    #expect(UICopy.limitLine("Limit planu — spróbuj po 09:41.", ref: ref, timeZone: utc) == "Limit planu — spróbuj po 12:00.")
    #expect(UICopy.limitLine("Plan limit reached. Try again after 9:41 AM.", ref: ref, timeZone: utc)
      == "Limit planu — spróbuj po 12:00.")
    // Stary serwer: sam token bez `ref`.
    #expect(UICopy.limitLine("resetAt=2026-10-04T12:00:00Z", ref: nil, timeZone: utc) == "Limit planu — spróbuj po 12:00.")
    #expect(UICopy.limitLine(nil, ref: nil, timeZone: utc) == "Limit planu — spróbuj później.")
    // `ref` innego kodu albo z nieczytelną chwilą nie daje godziny; token w tekście zostaje zapasem.
    let other = SentenceRef(code: "state.herdr-unknown")
    #expect(UICopy.limitLine("resetAt=2026-10-04T12:00:00Z", ref: other, timeZone: utc) == "Limit planu — spróbuj po 12:00.")
    let broken = SentenceRef(code: "state.limit-reached", args: ["jutro"])
    #expect(UICopy.limitLine("Limit planu", ref: broken, timeZone: utc) == "Limit planu — spróbuj później.")
  }
}

@Suite("wiersz listy")
struct SessionRowTests {
  @Test("czeka na zgodę: bursztyn, sam czas obok stanu (bez drugiego „czeka”), głos z „czeka od”, linia „na co czeka”")
  func waiting() {
    let session = Sample.session(
      state: "waiting-permission",
      extra: #""waitingFor":{"kind":"permission","tool":"Edit","text":"/Users/d/Projects/x/src/a/b.ts"}"#)
    let row = SessionRowModel(session, ordinal: nil)
    #expect(row.status.tone == .waiting && row.status.text == "czeka na zgodę")
    #expect(row.waiting == "zgoda: Edit · …/src/a/b.ts")
    // Linia stanu na ekranie: „czeka na zgodę · 1 min”; stan mówi już „czeka”, zegar nie powtarza.
    #expect(row.clock(now: Sample.now) == "1\u{00A0}min")
    #expect(UICopy.list([row.status.text, row.clock(now: Sample.now)], .dot) == "czeka na zgodę · 1\u{00A0}min")
    #expect(row.spoken(now: Sample.now).contains("czeka od 1 minuty"), "czytnik dalej z „czeka od”")
  }

  @Test("czeka bez znanego powodu: linia zarezerwowana, pusta; nieświeże dane gaszą linię")
  func reservedLine() {
    #expect(SessionRowModel(Sample.session(state: "waiting-question"), ordinal: nil).waiting == "")
    let stale = Sample.session(state: "waiting-question", extra: #""stale":true"#)
    #expect(SessionRowModel(stale, ordinal: nil).waiting == nil)
    let plan = Sample.session(state: "waiting-permission", extra: #""waitingFor":{"kind":"permission","subject":"plan"}"#)
    #expect(SessionRowModel(plan, ordinal: nil).waiting == "plan")
  }

  @Test("odebrany wynik: „bezczynna”, wyciszony; nieodebrany: błękit „gotowe”")
  func seen() {
    let seen = SessionRowModel(Sample.session(state: "waiting-input", extra: #""seen":true"#), ordinal: nil)
    #expect(seen.status == RowStatus(Sample.session(state: "waiting-input", extra: #""seen":true"#)))
    #expect(seen.status.text == "bezczynna" && seen.quiet)
    let unread = SessionRowModel(Sample.session(state: "waiting-input"), ordinal: nil)
    #expect(unread.status.text == "gotowe" && unread.status.tone == .unread && !unread.quiet)
  }

  @Test("zadanie w tle po turze: barwa pracy i „pracuje w tle”")
  func background() {
    let session = Sample.session(state: "waiting-input", extra: #""seen":true,"backgroundTasks":[{"id":"t","kind":"command"}]"#)
    let row = SessionRowModel(session, ordinal: nil)
    #expect(row.status.tone == .working && row.status.text == "pracuje w tle" && !row.quiet)
  }

  @Test("czeka na zadanie w tle: przydymiona zieleń, słowo stanu bez zmian, bez kropki pracy przy linii etapu")
  func backgroundWait() {
    let monitor = #""backgroundTasks":[{"id":"m","kind":"monitor","description":"log serwera"}]"#
    let seen = SessionRowModel(Sample.session(state: "waiting-input", extra: #""seen":true,"# + monitor), ordinal: nil)
    #expect(seen.status.tone == .backgroundWait && seen.status.text == "bezczynna" && seen.quiet)
    #expect(!seen.backgroundDot, "monitor nie jest pracą: kropki pracy nie ma")
    let agent = #""backgroundTasks":[{"id":"a","kind":"agent","waitingSince":"2026-10-03T08:00:00.000Z"}]"#
    let done = SessionRowModel(Sample.session(state: "done", extra: agent), ordinal: nil)
    #expect(done.status.tone == .backgroundWait && !done.backgroundDot)
    let unread = SessionRowModel(Sample.session(state: "waiting-input", extra: monitor), ordinal: nil)
    #expect(unread.status.tone == .unread, "nieodebrany wynik wygrywa")
  }

  @Test("Codex: sam stan z metką, tytuł z sufiksem #n przy duplikacie")
  func codexAndOrdinal() {
    var state = AppState(clientBuild: 1)
    for (id, ago) in [("a", 900.0), ("b", 300.0)] {
      state.sessions[id] = Sample.session(id: id, label: "to samo", state: "running", createdAgo: ago)
    }
    state.sessions["c"] = Sample.session(id: "c", title: "inne", label: nil, state: "running", extra: #""engine":"codex""#)
    let rows = Dictionary(uniqueKeysWithValues: state.sessionRows.map { ($0.id, $0) })
    #expect(rows["a"]?.title == "willow · to samo #1")
    #expect(rows["b"]?.title == "willow · to samo #2")
    #expect(rows["b"]?.project == "willow" && rows["b"]?.titleTail == " · to samo #2")
    #expect(rows["c"]?.isCodex == true && rows["c"]?.title == "inne" && rows["c"]?.titleTail == "")
    #expect(rows["c"]?.spoken(now: Sample.now).contains("Codex") == true)
  }
}

@Suite("pamięć połączenia")
struct ConnectionMemoryTests {
  @Test("„łączę…” po 1 s; baner dopiero po nieudanej próbie i stoi mimo kolejnych prób")
  func memory() {
    var memory = ConnectionMemory()
    let t0 = Sample.now
    memory.observe(.connecting(since: t0), now: t0)
    #expect(!memory.showsConnecting(now: t0.addingTimeInterval(0.5)))
    #expect(memory.showsConnecting(now: t0.addingTimeInterval(1.1)))
    #expect(!memory.showsServerUnreachable)
    memory.observe(.offline(since: t0.addingTimeInterval(2)), now: t0.addingTimeInterval(2))
    memory.observe(.connecting(since: t0.addingTimeInterval(3)), now: t0.addingTimeInterval(3))
    #expect(memory.showsServerUnreachable, "próba w toku nie gasi baneru")
    memory.observe(.online, now: t0.addingTimeInterval(4))
    #expect(!memory.showsServerUnreachable && !memory.showsConnecting(now: t0.addingTimeInterval(9)))
    memory.observe(.offline(since: t0), now: t0)
    memory.observe(.idle, now: t0)
    #expect(!memory.showsServerUnreachable, "tło i wylogowanie to nie awaria")
  }

  @Test("karta łączenia: zerwanie w trakcie pracy apki od razu szare, porażka próby czerwoni tę samą kartę")
  func cardAfterDrop() {
    let t0 = Sample.now
    // Nowa pętla po zmianie sieci (`reconnectNow`): status przechodzi z `online` prosto w `connecting`.
    var direct = ConnectionMemory()
    direct.observe(.online, now: t0)
    direct.observe(.connecting(since: t0), now: t0)
    #expect(direct.connectionCard == .connecting(visibleFrom: t0))
    // Zerwanie żywego strumienia (`online` → `offline` → `connecting`): samo zerwanie to jeszcze nie porażka.
    var memory = ConnectionMemory()
    memory.observe(.online, now: t0)
    memory.observe(.offline(since: t0), now: t0)
    #expect(memory.connectionCard == .connecting(visibleFrom: t0))
    memory.observe(.connecting(since: t0.addingTimeInterval(0.5)), now: t0.addingTimeInterval(0.5))
    #expect(memory.connectionCard == .connecting(visibleFrom: t0))
    memory.observe(.offline(since: t0.addingTimeInterval(3.5)), now: t0.addingTimeInterval(3.5))
    #expect(memory.connectionCard == .serverUnreachable, "próba padła")
    memory.observe(.connecting(since: t0.addingTimeInterval(4)), now: t0.addingTimeInterval(4))
    #expect(memory.connectionCard == .serverUnreachable, "kolejna próba nie gasi czerwieni")
    memory.observe(.online, now: t0.addingTimeInterval(5))
    #expect(memory.connectionCard == nil)
  }

  @Test("a drop in use whose attempt fails within 3 s stays gray; a failure past 3 s turns it red")
  func quickFailureAfterDrop() {
    let t0 = Sample.now
    // The VPN interface blinks: iOS reports a network change, the store starts a new loop (`online` → `connecting`),
    // the first attempt fails at once and the next one connects.
    var blink = ConnectionMemory()
    blink.observe(.online, now: t0.addingTimeInterval(-60))
    blink.observe(.connecting(since: t0), now: t0)
    blink.observe(.offline(since: t0.addingTimeInterval(0.4)), now: t0.addingTimeInterval(0.4))
    #expect(blink.connectionCard == .connecting(visibleFrom: t0), "gray at once, as any drop in use")
    blink.observe(.connecting(since: t0.addingTimeInterval(0.9)), now: t0.addingTimeInterval(0.9))
    blink.observe(.offline(since: t0.addingTimeInterval(2.5)), now: t0.addingTimeInterval(2.5))
    #expect(blink.connectionCard == .connecting(visibleFrom: t0), "a second quick failure is still gray")
    blink.observe(.connecting(since: t0.addingTimeInterval(3)), now: t0.addingTimeInterval(3))
    blink.observe(.online, now: t0.addingTimeInterval(3.2))
    #expect(blink.connectionCard == nil)
    // A live stream that drops and whose retry fails at once.
    var dropped = ConnectionMemory()
    dropped.observe(.online, now: t0)
    dropped.observe(.offline(since: t0.addingTimeInterval(1)), now: t0.addingTimeInterval(1))
    dropped.observe(.connecting(since: t0.addingTimeInterval(1.5)), now: t0.addingTimeInterval(1.5))
    dropped.observe(.offline(since: t0.addingTimeInterval(1.6)), now: t0.addingTimeInterval(1.6))
    #expect(dropped.connectionCard == .connecting(visibleFrom: t0.addingTimeInterval(1)))
    dropped.observe(.connecting(since: t0.addingTimeInterval(2.1)), now: t0.addingTimeInterval(2.1))
    dropped.observe(.offline(since: t0.addingTimeInterval(4.1)), now: t0.addingTimeInterval(4.1))
    #expect(dropped.connectionCard == .serverUnreachable, "still failing past the card delay: red")
  }

  @Test("a return whose first attempt fails at once and the next connects shows no red card; a failure past 3 s does")
  func quickFailureOnReturn() {
    let t0 = Sample.now
    var back = ConnectionMemory()
    back.observe(.online, now: t0.addingTimeInterval(-60))
    back.observe(.idle, now: t0.addingTimeInterval(-30))
    back.observe(.connecting(since: t0), now: t0)
    back.observe(.offline(since: t0.addingTimeInterval(0.2)), now: t0.addingTimeInterval(0.2))
    #expect(back.connectionCard == .connecting(visibleFrom: t0.addingTimeInterval(3)), "the dead tunnel's attempt")
    back.observe(.connecting(since: t0.addingTimeInterval(0.7)), now: t0.addingTimeInterval(0.7))
    back.observe(.online, now: t0.addingTimeInterval(0.9))
    #expect(back.connectionCard == nil)
    var down = ConnectionMemory()
    down.observe(.connecting(since: t0), now: t0)
    down.observe(.offline(since: t0.addingTimeInterval(0.2)), now: t0.addingTimeInterval(0.2))
    down.observe(.connecting(since: t0.addingTimeInterval(3.2)), now: t0.addingTimeInterval(3.2))
    down.observe(.offline(since: t0.addingTimeInterval(3.4)), now: t0.addingTimeInterval(3.4))
    #expect(down.connectionCard == .serverUnreachable, "still failing past the card delay: red")
  }

  @Test("connecting card: start and return from the background after 3 s; a failure in red, idle without a card")
  func cardAfterResume() {
    let t0 = Sample.now
    var start = ConnectionMemory()
    start.observe(.connecting(since: t0), now: t0)
    #expect(start.connectionCard == .connecting(visibleFrom: t0.addingTimeInterval(3)))
    start.observe(.offline(since: t0.addingTimeInterval(3.5)), now: t0.addingTimeInterval(3.5))
    #expect(start.connectionCard == .serverUnreachable)
    // Powrót z tła: tło zatrzymuje strumienie (`idle`), więc nowe łączenie nie jest zerwaniem.
    var back = ConnectionMemory()
    back.observe(.online, now: t0)
    back.observe(.idle, now: t0.addingTimeInterval(5))
    #expect(back.connectionCard == nil, "tło to nie awaria")
    back.observe(.connecting(since: t0.addingTimeInterval(60)), now: t0.addingTimeInterval(60))
    #expect(back.connectionCard == .connecting(visibleFrom: t0.addingTimeInterval(63)))
    #expect(back.showsServerUnreachable == false && back.showsConnecting(now: t0.addingTimeInterval(61)),
      "dotychczasowe reguły bez zmian")
  }

  @Test("karta łączenia: szara kropka `done` (bez bursztynu), brak serwera czerwony; zdanie karty")
  func cardTone() {
    #expect(Banner.connecting(visibleFrom: Sample.now).tone == .info)
    #expect(Banner.serverUnreachable.tone == .failure)
    #expect(Banner.pushDegraded(since: Sample.iso(60)).tone == .info)
    #expect(UICopy.banner(.connecting(visibleFrom: Sample.now)) == "Łączę z serwerem…")
  }

  @Test("banery: jedna awaria = jeden baner, niezgodność zostaje")
  func banners() {
    var state = AppState(clientBuild: 1)
    state.compat = .tooOld(minClientBuild: 5)
    state.global = .offline(since: Sample.now)
    var memory = ConnectionMemory()
    memory.observe(.connecting(since: Sample.now.addingTimeInterval(-5)), now: Sample.now.addingTimeInterval(-5))
    memory.observe(state.global, now: Sample.now)
    #expect(state.globalBanners(memory: memory) == [.incompatible(.tooOld(minClientBuild: 5)), .serverUnreachable])
    #expect(UICopy.banner(.incompatible(.tooOld(minClientBuild: 5))) == CoreCopy.updateApp)
    #expect(UICopy.banner(.incompatible(.protocolMismatch(server: 2))) == CoreCopy.updateServer)
  }
}
