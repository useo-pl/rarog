import CryptoKit
import Foundation
import RarogContract
import RarogCore

// Wiersze wiadomości: tekst, karty narzędzi, serie kroków, zdjęcia, załączniki, znaczniki (godzina
// po przerwie, data przy zmianie dnia, linia „NOWE") i otwarta (płynąca) odpowiedź. Właściciel: transkrypt; notki harnessu, zdjęcia i załączniki (`harnessNotice`, `media`,
// typy na końcu pliku) — notki i miniatury.
extension TranscriptRows {
  /// Wiersze treści i głos ostatniego wiersza (od niego zależy pierwszy wpis kolejki). Głos (`voice`) nie stoi już na
  /// ekranie — zostaje w modelu jako sygnał zmiany głosu (odstęp 12 pt poza granicą tury).
  // swiftlint:disable:next function_body_length cyclomatic_complexity
  /// `promptBlocked` — przycisk ponownej wysyłki z karty sesji; stoi pod notką o jego `seq`.
  /// `turnEnded`: the session's turn is over (``turnEnded(session:view:)``), so the last reply gets its time too.
  static func messageRows(
    _ view: TranscriptState, reading: TranscriptReading = TranscriptReading(), calendar: Calendar = deviceCalendar,
    promptBlocked: PromptBlockedAction? = nil, turnEnded: Bool = false
  ) -> (rows: [TranscriptRow], previous: MessageRole?) {
    var rows: [TranscriptRow] = []
    var previous: MessageRole?
    // The last agent text row of the reply being built and its message's time. A reply is closed by the next human
    // prompt, or at the end once the turn is over; only then the row gets the time.
    var replyEnd: (index: Int, clock: String?)?
    func closeReply() {
      guard let end = replyEnd else { return }
      replyEnd = nil
      var turn = rows[end.index].turn
      turn.clock = end.clock
      rows[end.index].setTurn(turn)
    }
    func voice(_ role: MessageRole) -> VoiceLabel? {
      defer { previous = role }
      return role == previous ? nil : role
    }
    // Seria zwinięta chowa kroki poprzednie, a nad ostatnim stawia rozwijak.
    // Ślady własnych decyzji stoją na miejscu decyzji: pod wiadomością z chwili decyzji, przed następną.
    // Seria kroków przerywa się na śladzie — ta sama granica co w `TranscriptReading.prepare`.
    var traces = TraceQueue(view)
    var tucked: Set<Int> = []
    var runAtTail: [Int: ToolRun] = [:]
    for run in ToolRuns.find(view.messages, breaks: traces.breaks) {
      runAtTail[run.tail] = run
      if !reading.expandedRuns.contains(run.id) { tucked.formUnion(run.tucked) }
    }
    let messages = view.messages
    var newMarkerPending = false
    var dayPending = false
    var turns = TurnBoundaries()
    func placeTraces(_ due: [TranscriptRow]) {
      for trace in due {
        var block = [trace]
        turns.mark(&block, prompt: false)
        rows += block
      }
    }
    for (index, message) in messages.enumerated() {
      if message.isHumanPrompt { closeReply() }
      placeTraces(traces.before(index: index))
      // Zmiana dnia liczy się po WSZYSTKICH wiadomościach, także schowanych w zwiniętej serii — zaległa zmiana dnia
      // czeka na pierwszy widoczny wiersz.
      if index > 0, TimeGap.dayChanged(previous: messages[index - 1].at, next: message.at, calendar: calendar) {
        dayPending = true
      }
      guard !tucked.contains(message.seq) else { continue }
      var produced: [TranscriptRow] = []
      var first = true
      func label() -> VoiceLabel? {
        guard first else { return nil }
        first = false
        return voice(message.role)
      }
      if let run = runAtTail[message.seq] {
        // Rozwijak przejmuje etykietę głosu: przy zwiniętej serii jest pierwszym wierszem tury.
        produced.append(.toolRun(ToolRunModel(
          id: run.id, voice: label(), hidden: run.hidden, expanded: reading.expandedRuns.contains(run.id))))
      }
      if let notice = message.notice {
        // Notka harnessu: rola efektywna to system, nie człowiek — bez dymka „ty" i bez
        // surowego wpisu; zdanie składa copy z faktów serwera.
        let copy = UICopy.harnessNotice(notice)
        produced.append(.harnessNotice(HarnessNoticeModel(
          id: "m\(message.seq).n", voice: voice(message.effectiveRole), text: copy.text, tone: copy.tone)))
      } else if let blocked = message.promptBlocked {
        // A prompt blocked by a hook gets its own row built from the server's facts, not from the note text in
        // the blocks (that text is there for older app builds).
        produced.append(.promptBlocked(PromptBlockedNote.row(
          message, blocked, voice: label(), reading: reading, action: promptBlocked)))
      } else {
        produced += contentRows(message, reading: reading, label: label)
      }
      if message.seq == reading.newMarker.seq { newMarkerPending = true }
      guard !produced.isEmpty else { continue }
      // Znaczniki stoją NAD wiadomością, w kolejności „NOWE", czas. Godzina po przerwie nigdy nad krokiem narzędzia
      // (bywa schowany w serii, a znacznik zniknąłby razem z nim) ani nad promptem (godzina stoi przy
      // dymku); data zmiany dnia — na pierwszym widocznym wierszu, także nad promptem i narzędziem.
      var block: [TranscriptRow] = []
      if newMarkerPending {
        block.append(.newMarker())
        newMarkerPending = false
      }
      if index > 0, let mark = TimeGap.mark(
        previous: messages[index - 1].at, next: message.at, dayChange: dayPending, prompt: message.isHumanPrompt,
        toolOnly: ToolRuns.isToolOnly(message), calendar: calendar)
      {
        block.append(.timeGap(id: "t\(message.seq)", mark: mark))
      }
      dayPending = false
      if message.isHumanPrompt {
        produced.markPrompt(
          clock: ServerTime.clock(message.at, timeZone: calendar.timeZone), expanded: reading.expandedPrompts)
      }
      block += produced
      // Granica tury idzie na pierwszy widoczny wiersz bloku: znacznik nad promptem, rozwijak serii, zdjęcie.
      turns.mark(&block, prompt: message.isHumanPrompt)
      if message.effectiveRole == .assistant, let last = block.lastIndex(where: \.isAgentText) {
        replyEnd = (rows.count + last, ServerTime.clock(message.at, timeZone: calendar.timeZone))
      }
      rows += block
    }
    placeTraces(traces.rest())
    if let open = view.open, !open.text.isEmpty {
      var block: [TranscriptRow] = [.open(voice: voice(.assistant), markdown: open.text)]
      turns.mark(&block, prompt: false)
      rows += block
    }
    if turnEnded, view.open == nil { closeReply() }
    // Sąsiednie narzędzia jako jedna karta — po granicach tur, bo granica tury kartę przerywa.
    ToolChains.mark(&rows)
    return (rows, previous)
  }

  /// The turn is over: the session is outside the turn states (the same set as the activity band: not starting,
  /// not working, not waiting on a decision), no card waits for a decision and no reply is streaming. An unknown
  /// session counts as not over, so the last reply never shows a time that the turn may still move.
  static func turnEnded(session: SessionSummary?, view: TranscriptState) -> Bool {
    guard let session, !ActivityBand.turnStates.contains(session.state) else { return false }
    return view.open == nil && view.pendingPermissions.isEmpty && view.pendingQuestions.isEmpty
  }

  /// Bloki i załączniki wiadomości. Kolejne obrazki z treści stoją jedną galerią, załączniki
  /// pod treścią jednym wierszem miniatur i chipów. `label` oddaje etykietę głosu
  /// tylko pierwszemu wierszowi wiadomości.
  static func contentRows(
    _ message: TranscriptMessage, reading: TranscriptReading, label: () -> VoiceLabel?
  ) -> [TranscriptRow] {
    var rows: [TranscriptRow] = []
    var gallery: (id: String, thumbnails: [MediaThumbnail])?
    func closeGallery() {
      guard let open = gallery else { return }
      rows.append(.media(MediaRowModel(id: open.id, voice: label(), thumbnails: open.thumbnails, chips: [])))
      gallery = nil
    }
    for (blockIndex, block) in message.blocks.enumerated() {
      let id = blockId(seq: message.seq, index: blockIndex)
      if case let .image(image) = block {
        var open = gallery ?? (id, [])
        open.thumbnails.append(MediaThumbnail.inline(image, rowId: open.id, index: open.thumbnails.count))
        gallery = open
        continue
      }
      closeGallery()
      switch block {
      case let .text(text, _):
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
        rows.append(.text(id: id, role: message.role, voice: label(), markdown: text))
      case let .toolCall(tool):
        rows.append(.tool(toolRow(tool, id: id, voice: label(), reading: reading)))
      case .unsupported:
        rows.append(.unsupported(id: id, voice: label()))
      case .image:
        break
      }
    }
    closeGallery()
    let attached = attachmentMedia(message.attachments ?? [])
    // Zdjęcie z historii (`name: ""`, `bytes: 0`) bez pliku nie daje niczego do pokazania —
    // wiersza bez treści nie ma.
    if !attached.thumbnails.isEmpty || !attached.chips.isEmpty {
      rows.append(.media(MediaRowModel(
        id: "m\(message.seq).a", voice: label(), thumbnails: attached.thumbnails, chips: attached.chips)))
    }
    return rows
  }

  /// Wizytówki załączników → miniatury (zdjęcie z `file`) i chipy (plik; zdjęcie bez pliku,
  /// którego podglądu nie ma skąd wziąć). Kolejność: najpierw miniatury, potem chipy.
  static func attachmentMedia(_ attachments: [MessageAttachment]) -> (thumbnails: [MediaThumbnail], chips: [MediaChip]) {
    var thumbnails: [MediaThumbnail] = []
    var chips: [MediaChip] = []
    var photo = 0
    for attachment in attachments {
      switch attachment.kind {
      case .image:
        photo += 1
        if let file = attachment.file {
          thumbnails.append(MediaThumbnail(
            key: MediaThumbnail.uploadKey(file: file), source: .upload(file: file), label: UICopy.photoLabel(photo),
            bytes: attachment.bytes))
        } else {
          chips.append(MediaChip(name: UICopy.imagePlaceholder, bytes: attachment.bytes, image: true))
        }
      case .file:
        let name = attachment.name.isEmpty ? UICopy.fileFallbackName : attachment.name
        chips.append(MediaChip(name: name, bytes: attachment.bytes, image: false))
      }
    }
    return (thumbnails, chips)
  }

  /// Karta narzędzia: mini-diff tylko po `detailKind`, pusta treść = linia bez rozwinięcia. Treść uciętą przez
  /// serwer (`truncation`) kończy stopka apki zamiast angielskiej stopki z drutu.
  static func toolRow(_ tool: ToolCallBlock, id: String, voice: VoiceLabel?, reading: TranscriptReading) -> ToolRowModel {
    let detail = tool.detail.map { UICopy.truncated($0, tool.truncation) }.flatMap { $0.isEmpty ? nil : $0 }
    let diff = tool.detailKind == .diff ? detail.map(MiniDiff.init) : nil
    return ToolRowModel(
      id: id, voice: voice, toolName: tool.toolName, summary: PathText.shortenPaths(tool.summary),
      detail: detail, diff: diff, shell: tool.inputKind == .shell,
      expanded: detail != nil && reading.isExpanded(id, diff: diff != nil),
      diffTailOpen: reading.diffTails.contains(id))
  }
}


// MARK: - Notki harnessu i zdjęcia (właściciel: notki i miniatury)

/// Notka harnessu w transkrypcie: jedno ciche zdanie systemowe.
public struct HarnessNoticeModel: Sendable, Equatable {
  /// `m<seq>.n` — z numerem wiadomości, więc znaczniki i pozycja czytania działają jak dla treści.
  public let id: String
  public let voice: VoiceLabel?
  public let text: String
  public let tone: NoticeTone
  public var turn = TurnMark()
}

/// Ton notki: zwykła (zębatka), ostrzeżenie (trójkąt — sierota po restarcie CLI, los zadań
/// nieznany) i niepowodzenie (trójkąt w kolorze błędu). Zatrzymanie to nie awaria.
public enum NoticeTone: Sendable, Equatable {
  case quiet, warning, failure
}

/// Wiersz zdjęć wiadomości: miniatury o stałej wysokości i chipy plików.
public struct MediaRowModel: Sendable, Equatable {
  /// `m<seq>.<blok>` (galeria obrazków z treści) albo `m<seq>.a` (załączniki).
  public let id: String
  public let voice: VoiceLabel?
  public let thumbnails: [MediaThumbnail]
  public let chips: [MediaChip]
  public var turn = TurnMark()
}

/// Jedna miniatura. Treść obrazka nie żyje w modelu wiersza dłużej niż w stanie rdzenia: obrazek
/// z treści niesie data URL ze stanu (współdzielona pamięć łańcucha), zdjęcie z serwera — nazwę pliku.
public struct MediaThumbnail: Sendable, Equatable {
  public enum Source: Sendable, Equatable {
    /// Blok `image` z treści: data URL png/jpeg (sprawdzony dekoderem kontraktu).
    case inline(dataUrl: String)
    /// Zdjęcie z `.rarog-uploads/` sesji — `GET …/uploads/<plik>` przez magazyn.
    case upload(file: String)
  }

  /// Tożsamość kafla w wierszu (`.id(key)`). Zdjęcie z serwera: nazwa pliku (unikalna, niezmienna).
  /// Obrazek z treści: wiersz, pozycja i SHA-256 całego data URL-a — numer wiadomości po restarcie
  /// serwera wskazuje inną treść, a długość z końcem base64 jej nie identyfikowały (dwa PNG tej
  /// samej długości z jednakowym końcowym blokiem `tEXt` dawały ten sam klucz). Pamięć podręczna
  /// miniatur jest wspólna dla procesu, więc bierze ``cacheKey(sessionId:)``, nie sam klucz.
  public let key: String
  public let source: Source
  /// Nazwa dla czytnika: „Zdjęcie 2" albo opis obrazka z treści.
  public let label: String
  /// Waga z wizytówki (0 = nieznana, np. historia z jsonl) — do kafla „Zdjęcie" po porażce.
  public let bytes: Int

  public init(key: String, source: Source, label: String, bytes: Int) {
    self.key = key
    self.source = source
    self.label = label
    self.bytes = bytes
  }

  static func inline(_ image: ImageBlock, rowId: String, index: Int) -> MediaThumbnail {
    // Obraz zastępczy serwera (`placeholder`): podpis to zdanie serwera, które apka składa w swoim języku.
    let alt = image.placeholder ? UICopy.snapshotImageAlt()
      : image.alt.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
    return MediaThumbnail(
      key: "i:\(rowId).\(index):\(contentDigest(image.dataUrl))", source: .inline(dataUrl: image.dataUrl),
      label: alt ?? UICopy.inlineImageLabel, bytes: 0)
  }

  /// SHA-256 całego data URL-a, szesnastkowo. Bez kopii bajtów: obrazek z treści waży do 1,5 MB
  /// (budżet ramki `transcript-snapshot` na serwerze), a wiersze składa każdy render.
  static func contentDigest(_ dataUrl: String) -> String {
    var text = dataUrl
    let digest = text.withUTF8 { SHA256.hash(data: UnsafeRawBufferPointer($0)) }
    return digest.map { String(format: "%02x", $0) }.joined()
  }

  /// Klucz pamięci podręcznej miniatur (jednej na proces): klucz kafla z identyfikatorem sesji,
  /// bo pozycja `m<seq>.<blok>` i nazwa pliku z `.rarog-uploads/` znaczą coś tylko w swojej sesji —
  /// bez niego kafel jednej sesji mógł pokazać miniaturę drugiej.
  public func cacheKey(sessionId: String) -> String {
    Self.cacheKey(sessionId: sessionId, key: key)
  }

  /// Klucz pamięci miniatur dla klucza kafla (wspólny z kaflami wpisu kolejki, `PendingTile`).
  static func cacheKey(sessionId: String, key: String) -> String {
    "\(sessionId)\n\(key)"
  }

  /// Klucz kafla zdjęcia z serwera: nazwa pliku w `.rarog-uploads/` (unikalna, niezmienna).
  static func uploadKey(file: String) -> String {
    "u:\(file)"
  }
}

/// Chip załącznika bez miniatury: plik albo zdjęcie, którego podglądu nie ma skąd wziąć.
public struct MediaChip: Sendable, Equatable {
  public let name: String
  /// „178 kB"; `nil` przy wadze nieznanej (0).
  public let size: String?
  public let image: Bool

  public init(name: String, bytes: Int, image: Bool) {
    self.name = name
    size = bytes > 0 ? UICopy.bytes(bytes) : nil
    self.image = image
  }
}
