import Foundation
import RarogContract

// Selektory: czyste odczyty stanu dla widoku. Copy (zdania po polsku) składa RarogUI — tu są
// fakty i rozstrzygnięcia, z powodem przy każdym.

/// Ton kropki stanu: kolor znaczy stan, nigdy dekorację.
public enum StatusTone: Sendable, Equatable {
  /// Zieleń — agent sam się rusza (także zadanie w tle).
  case working
  /// Bursztyn — ktoś czeka na człowieka (zgoda, pytanie, przerwana tura).
  case waiting
  /// Czerwień — błąd albo limit.
  case failed
  /// Błękit — nieodebrany wynik.
  case unread
  /// Szarość — cisza (odebrane, done, do wznowienia, nieobsługiwana).
  case quiet
  /// Przydymiona zieleń — agent skończył turę i czeka na zadanie w tle, które nie jest pracą: subagent w postoju
  /// albo monitor. Zastępuje wyłącznie ciszę; ranga, push i kafel liczą go jak ciszę (``isCalm``).
  case backgroundWait

  /// Ton spokojny: cisza albo czekanie na zadanie w tle. Tak liczą wszystkie miejsca poza barwą, znakiem
  /// i zdaniem tonu (przełącznik sesji, licznik okna przełącznika).
  public var isCalm: Bool { self == .quiet || self == .backgroundWait }
}

/// Od kiedy liczy zegar karty.
public struct ListClock: Sendable, Equatable {
  public enum Kind: Sendable, Equatable {
    /// Sesja pracująca: czas tury (`stateSince`).
    case turn
    /// Decyzja: „czeka od" — liczone od ostatniej aktywności.
    case waiting
    /// Każda inna: cisza od ostatniej aktywności (`lastActivityAt` przeżywa restart serwera).
    case silence
  }

  public let kind: Kind
  public let since: String
}

/// Dlaczego pole wiadomości jest wygaszone. Kolejność = twardość przeszkody.
public enum SendBlock: Sendable, Equatable {
  case codex
  case unsupported
  case outOfScope
  case herdrUnavailable
  case herdrReadOnly
  /// Stoi zgoda albo pytanie: wpisana litera mogłaby trafić w dialog jako „tak".
  case decisionPending
  /// Agent jeszcze wstaje (`starting`): serwer odmawia do gotowości panelu, prompt startowy idzie bez pola.
  /// Pole zostaje do odczytu ze szkicem, pod nim zdanie powodu z kropkami pracy.
  case starting
  /// Stan, w którym serwer nie przyjmuje wiadomości (limit, błąd, przerwana, done, do wznowienia):
  /// zamiast pola stoi karta stanu. Lustro `SENDABLE_STATES` z `manager.ts`.
  case stateCard(SessionState)
}

/// Baner pod nagłówkiem — jedna awaria, jeden baner, w tej kolejności.
public enum Banner: Sendable, Equatable {
  case incompatible(Compatibility)
  /// Strumień globalny łączy się, a żadna próba jeszcze nie padła — szara karta „Łączę z serwerem…” w miejscu
  /// brakującego serwera, widoczna od `visibleFrom` (zerwanie w trakcie pracy apki od razu, start i powrót z tła
  /// po ~1 s). Stawia ją pamięć połączenia apki (`ConnectionMemory.connectionCard`
  /// w RarogUI), nie ten selektor: rdzeń nie ma zegara.
  case connecting(visibleFrom: Date)
  /// Strumień globalny zerwany — „Serwer nie odpowiada. Sprawdź Tailscale.".
  case serverUnreachable
  /// Tylko w otwartej sesji i tylko gdy globalny żyje — „Transkrypt nie dochodzi — ponawiam.".
  case transcriptStalled
  /// `staleSince` = najświeższy znany stan sesji bez kontaktu (zdanie „stany sprzed X").
  case herdrUnavailable(detail: String?, staleSince: String?)
  case herdrReadOnly(detail: String?)
  /// Dostawy APNs do TEGO urządzenia nie dochodzą od `since`; `reason` = przyczyna od serwera, `nil` = ogólna.
  case pushDegraded(since: String, reason: ApnsDegradedReason? = nil)
}

/// Co pokazać zamiast transkryptu.
public enum TranscriptPhase: Sendable, Equatable {
  /// Przed pierwszym stanem: szkielet, nie fałszywe zaproszenie.
  case loading
  /// Nie znam takiej sesji (nie w trakcie łączenia).
  case unknownSession
  /// Pusty transkrypt — zdanie zależy od stanu sesji.
  case empty(SessionState)
  case content
}

/// Flagi możliwości serwera z ustalonym znaczeniem braku pola.
public struct Capabilities: Sendable, Equatable {
  public let voice: Bool
  public let terminal: Bool
  public let notes: Bool
  /// Serwer ma kanał APNs apki natywnej: baner „Włącz powiadomienia" i status tokenu.
  public let apns: Bool
  /// Agent głosowy przy sesji: serwer ma flagę i klucz OpenAI. Brak pola (starszy serwer) = wyłączony.
  public let companion: Bool
  /// The voice agent speaks with a Soniox voice: the server gives speech keys. Missing field (older server) =
  /// the OpenAI voice.
  public let companionSpeech: Bool
  /// The voice agent's mode across sessions: the server says `companionSessions` and lists the capability
  /// `companion-sessions`. Either missing = off.
  public let companionSessions: Bool
  /// The server keeps an Inbox: the capability `inbox`. Missing = no Inbox.
  public let inbox: Bool
  /// The server serves session directories and files: the capability `files`. Missing = no file routes.
  public let files: Bool
  /// The server sends the file index of a session: the capability `file-index`. Missing = the search covers the
  /// loaded listings only.
  public let fileIndex: Bool

  /// The capability name of the mode across sessions in `/api/version` `capabilities`.
  public static let companionSessionsCapability = "companion-sessions"
  /// The capability name of the Inbox in `/api/version` `capabilities`.
  public static let inboxCapability = "inbox"
  /// The capability name of the session file routes in `/api/version` `capabilities`.
  public static let filesCapability = "files"
  /// The capability name of the session file index in `/api/version` `capabilities`.
  public static let fileIndexCapability = "file-index"

  public init(_ version: VersionInfo) {
    // Brak `voiceEnabled` = WŁĄCZONE (starszy serwer); brak pozostałych flag = wyłączone.
    voice = version.voiceEnabled ?? true
    terminal = version.termEnabled ?? false
    notes = version.notesEnabled ?? false
    apns = version.apnsEnabled ?? false
    companion = version.companionEnabled ?? false
    companionSpeech = version.companionSpeech ?? false
    companionSessions =
      version.companionSessions == true && version.capabilities.contains(Self.companionSessionsCapability)
    inbox = version.capabilities.contains(Self.inboxCapability)
    files = version.capabilities.contains(Self.filesCapability)
    fileIndex = version.capabilities.contains(Self.fileIndexCapability)
  }
}

extension AppState {
  /// Słowo maszyny serwera w zdaniach apki (``ServerMachine``): ostatni znany system, a po odpięciu (klucza i
  /// związania już nie ma) — system zapisany w odpięciu.
  public var serverMachine: ServerMachine { ServerMachine(serverSystem ?? pairing.revoked?.serverSystem) }
}

extension SessionSummary {
  /// Sesja, której ta wersja apki nie rozumie: nieznany stan albo silnik.
  public var isUnsupported: Bool { state == .unsupported || engine == .unsupported }

  /// Sesja z ekranem transkryptu: nie wpis Codexa (sam stan) i nie agent stojący w terminalu Raroga
  /// (`termId` — jego ekranem jest terminal). Bez ekranu nie ma strumienia
  /// transkryptu, więc taka sesja na nic po odtworzeniu z pamięci podręcznej nie czeka.
  public var showsTranscript: Bool { engine != .codex && termId == nil }

  /// Stoi decyzja (zgoda, pytanie) — tylko to jest „czekaniem" (`waiting-input` = skończył).
  public var isWaitingForDecision: Bool { state == .waitingPermission || state == .waitingQuestion }

  /// Wynik bieżącej tury odebrany (`seen == true`); brak i `false` = jest co odebrać.
  public var resultSeen: Bool { seen == true }

  /// Ranga na liście: 0 decyzja, 1 nieodebrany wynik i awarie, 2 praca,
  /// 3 odebrany wynik, 4 done. Zadanie w tle podnosi do pracy rangi spokojniejsze; czy lista zadań
  /// trzyma wiersz przy pracy, rozstrzyga `BackgroundTaskRules.tasksKeepRowWorking` (`BackgroundTaskRules.swift`).
  /// Subagent w postoju wiersza przy pracy nie trzyma: sesja, której całe tło czeka, ma rangę jak bez tła.
  public var listRank: Int {
    switch state {
    case .waitingPermission, .waitingQuestion:
      return 0
    case .waitingInput, .error, .limitReached, .interrupted, .resumable:
      let rank = state == .waitingInput && resultSeen ? 3 : 1
      return rank > 2 && BackgroundTaskRules.tasksKeepRowWorking(backgroundTasks) ? 2 : rank
    case .done:
      return BackgroundTaskRules.tasksKeepRowWorking(backgroundTasks) ? 2 : 4
    case .unsupported:
      // Nic nie stoi na człowieku, karta bez akcji — cisza na dole (jak `done`).
      return 4
    case .starting, .running:
      return 2
    }
  }

  /// Ton kropki.
  public var statusTone: StatusTone {
    let base: StatusTone =
      switch state {
      case .starting, .running: .working
      case .waitingInput: resultSeen ? .quiet : .unread
      case .waitingPermission, .waitingQuestion, .interrupted: .waiting
      case .limitReached, .error: .failed
      case .done, .resumable, .unsupported: .quiet
      }
    // Proces w tle nikogo nie blokuje — barwa pracy; „czeka" i „błąd" wygrywają. Subagent
    // w postoju i monitor pracą nie są: reguła ich nie liczy.
    if base == .unread || base == .quiet, BackgroundTaskRules.tasksKeepRowWorking(backgroundTasks) { return .working }
    // Cisza z zadaniem na liście, które nie pracuje: agent czeka na zadanie w tle. Nieodebrany wynik zostaje
    // sobą, a sesja nieobsługiwana — ciszą.
    if base == .quiet, waitsOnBackground, BackgroundTaskRules.hasTasks(backgroundTasks) { return .backgroundWait }
    return base
  }

  /// Stany, w których agent po turze może czekać na zadanie w tle: odebrany wynik, done, do wznowienia.
  private var waitsOnBackground: Bool {
    state == .waitingInput || state == .done || state == .resumable
  }

  public var listClock: ListClock {
    switch state {
    case .starting, .running: ListClock(kind: .turn, since: stateSince)
    case .waitingPermission, .waitingQuestion: ListClock(kind: .waiting, since: lastActivityAt)
    default: ListClock(kind: .silence, since: lastActivityAt)
    }
  }
}

extension AppState {
  /// Lista płaska w kolejności rangi (bez pięter i grup). Remis: wiek sesji
  /// (lista nie skacze); wśród odebranych bezczynnych świeższa aktywność wyżej. Prawdziwa ranga
  /// — przycinanie pamięci podręcznej listy; wiersze na ekranie idą za ``listOrder``.
  public var sortedSessions: [SessionSummary] {
    ordered(rank: \.listRank)
  }

  /// Kolejność wierszy listy na ekranie: jak ``sortedSessions``, z rangą ``listOrderRank(_:)``.
  public var listOrder: [SessionSummary] {
    ordered(rank: listOrderRank)
  }

  /// Ranga w KOLEJNOŚCI listy: odczyt wyniku nie przesuwa wiersza. Wynik widziany na tym urządzeniu jako
  /// nieodebrany (``heldUnread``) trzyma rangę 1 także po `seen` — do zmiany stanu sesji, pełnego stanu listy
  /// albo zejścia apki w tło. Remis w randze 1 idzie dalej po wieku, więc wiersz stoi DOKŁADNIE na swoim
  /// miejscu. Styl wiersza (kropka, wyciszenie) idzie za prawdziwą ``SessionSummary/listRank``.
  public func listOrderRank(_ session: SessionSummary) -> Int {
    if session.state == .waitingInput, session.resultSeen, heldUnread[session.id] == session.stateSince { return 1 }
    return session.listRank
  }

  private func ordered(rank: (SessionSummary) -> Int) -> [SessionSummary] {
    sessions.values.sorted { a, b in
      let (rankA, rankB) = (rank(a), rank(b))
      if rankA != rankB { return rankA < rankB }
      if rankA == 3 {
        let (lastA, lastB) = (ISOTime.parse(a.lastActivityAt), ISOTime.parse(b.lastActivityAt))
        if lastA != lastB { return (lastA ?? .distantPast) > (lastB ?? .distantPast) }
      } else {
        let (bornA, bornB) = (ISOTime.parse(a.createdAt), ISOTime.parse(b.createdAt))
        if bornA != bornB { return (bornA ?? .distantPast) < (bornB ?? .distantPast) }
      }
      return a.id < b.id
    }
  }

  /// Sufiks `#n` dla wierszy o identycznej parze „projekt · nazwa" — numer od najstarszej
  /// (`createdAt`), więc nie skacze przy przestawianiu listy. Brak = bez sufiksu.
  public var duplicateOrdinals: [String: Int] {
    let buckets = Dictionary(grouping: sessions.values) { "\($0.title)\u{0}\($0.label ?? "")" }
    var out: [String: Int] = [:]
    for bucket in buckets.values where bucket.count > 1 {
      let byAge = bucket.sorted { a, b in
        let (bornA, bornB) = (ISOTime.parse(a.createdAt), ISOTime.parse(b.createdAt))
        if bornA != bornB, let bornA, let bornB { return bornA < bornB }
        return a.id < b.id
      }
      for (index, session) in byAge.enumerated() { out[session.id] = index + 1 }
    }
    return out
  }

  /// Powód wygaszenia pola wiadomości albo `nil` = wolno pisać. Do pracującego
  /// agenta pisać wolno — CLI kolejkuje. Pole gaśnie DOKŁADNIE wtedy, gdy serwer by odmówił
  /// (lustro `SENDABLE_STATES` z `manager.ts`: `running` i `waiting-input`).
  public func sendBlock(for sessionId: String) -> SendBlock? {
    guard let session = sessions[sessionId] else { return nil }
    if session.engine == .codex { return .codex }
    if session.isUnsupported { return .unsupported }
    if session.outOfScope == true { return .outOfScope }
    if session.stale == true || herdr.map({ !$0.available }) == true { return .herdrUnavailable }
    if let herdr, herdr.available, herdr.readOnly { return .herdrReadOnly }
    if session.isWaitingForDecision { return .decisionPending }
    switch session.state {
    case .running, .waitingInput: return nil
    case .starting: return .starting
    default: return .stateCard(session.state)
    }
  }

  /// Banery w kolejności: zgodność, brak serwera, potem reszta.
  public var banners: [Banner] {
    var out: [Banner] = []
    switch compat {
    case .tooOld, .protocolMismatch: out.append(.incompatible(compat))
    case .unknown, .ok: break
    }
    if case .offline = global {
      // Jedna awaria = jeden baner: przy braku serwera herdr i transkrypt milczą.
      out.append(.serverUnreachable)
      return out
    }
    if viewedSessionId != nil, global == .online, case .offline = sessionStream {
      out.append(.transcriptStalled)
    }
    if let herdr {
      if !herdr.available {
        out.append(.herdrUnavailable(detail: herdr.detail, staleSince: herdrStaleSince))
      } else if herdr.readOnly {
        out.append(.herdrReadOnly(detail: herdr.detail))
      }
    }
    // Dostawy APNs do TEGO urządzenia nie dochodzą (status tokenu).
    if let since = notificationsDegradedSince {
      out.append(.pushDegraded(since: since, reason: push.apnsDegradedReason))
    }
    return out
  }

  /// Faza ekranu sesji. „Nie znam" nie w trakcie łączenia.
  public func transcriptPhase(for sessionId: String) -> TranscriptPhase {
    guard let session = sessions[sessionId] else {
      // Lista z pamięci podręcznej nie wie, czy sesja istnieje — „nie znam" dopiero po świeżej liście.
      return sessionsLoaded && !listStale && global == .online ? .unknownSession : .loading
    }
    guard let view = transcripts[sessionId], view.snapshots > 0 else { return .loading }
    if view.messages.isEmpty && view.open == nil { return .empty(session.state) }
    return .content
  }

  /// Granica wiadomości znanych teraz w sesji — zapisywana przy wpisie kolejki (``OutboxEntry/EchoBoundary``).
  ///
  /// `lastAt` to NAJPÓŹNIEJSZY znany czas, nie czas wiadomości o największym `seq`: transkrypt odtworzony
  /// z pliku daje promptowi wchłoniętemu w turę czas wysyłki, więc `at` nie rośnie razem z `seq`
  /// — niższa granica wpuściłaby po restarcie serwera archiwalne echo o tym samym podpisie.
  public func echoBoundary(for sessionId: String) -> OutboxEntry.EchoBoundary? {
    guard let view = transcripts[sessionId], view.snapshots > 0 else { return nil }
    let last = view.messages.max { $0.seq < $1.seq }
    let latest = view.messages.max { (ISOTime.parse($0.at) ?? .distantPast) < (ISOTime.parse($1.at) ?? .distantPast) }
    return OutboxEntry.EchoBoundary(serverStartId: serverStartId, maxSeq: last?.seq, lastAt: latest?.at)
  }

  /// Wpisy kolejki tej sesji jeszcze bez echa (w locie, niepotwierdzone, odrzucone).
  public func outboxEntries(for sessionId: String) -> [OutboxEntry] {
    outbox.filter { $0.sessionId == sessionId }
  }
}
