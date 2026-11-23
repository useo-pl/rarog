import Foundation
import RarogContract
import RarogCore

/// Stan czytania transkryptu w JEDNEJ wizycie ekranu sesji: rozwinięcia kart narzędzi i serii,
/// jednorazowe zwinięcie mini-diffów przy decyzji i linia „NOWE". Żyje w
/// ``TranscriptUIState``, więc `TranscriptRows.build` składa wiersze z niego bez UIKit.
/// Właściciel: transkrypt.
public struct TranscriptReading: Sendable, Equatable {
  /// Karty przestawione ręką: id wiersza → rozwinięta. Stan człowieka wygrywa ze wszystkim.
  public var touched: [String: Bool] = [:]
  /// Mini-diffy zwinięte przy wejściu decyzji — raz, tylko nieruszone ręką.
  public var autoCollapsed: Set<String> = []
  /// Długie mini-diffy z rozwiniętym ogonem.
  public var diffTails: Set<String> = []
  /// Serie rozwinięte w tej wizycie (id = `seq` pierwszej wiadomości: rosnąca seria się nie zwija).
  public var expandedRuns: Set<Int> = []
  /// Długie prompty rozwinięte w tej wizycie, kluczem wiersza: `m<seq>.<blok>` echa albo `o<wpis>` wpisu w locie.
  public var expandedPrompts: Set<String> = []
  /// Na ekranie stoi karta decyzji: transkrypt przygasa, pasek mówi „do decyzji".
  public private(set) var decisionShown = false
  public var newMarker: NewMarkerDecision
  /// Serie z poprzedniego `prepare`: po nich rozwinięcie przechodzi na serię, która zachowała
  /// wiadomości rozwiniętej, gdy ta zmieniła identyfikator.
  private var knownRuns: [ToolRun] = []

  public init(newMarker: NewMarkerDecision = NewMarkerDecision()) {
    self.newMarker = newMarker
  }

  /// Rozwinięcie karty: ręka, a bez niej mini-diff otwarty (chyba że zwinęła go decyzja).
  public func isExpanded(_ id: String, diff: Bool) -> Bool {
    if let manual = touched[id] { return manual }
    return diff && !autoCollapsed.contains(id)
  }

  public mutating func toggle(_ id: String, diff: Bool) {
    touched[id] = !isExpanded(id, diff: diff)
    moved = true
  }

  public mutating func toggleRun(_ id: Int) {
    if expandedRuns.remove(id) == nil { expandedRuns.insert(id) }
    moved = true
  }

  /// Długi prompt: „Pokaż całość” ↔ „Zwiń”. Przestawia treść ręką, więc miejsce czytania zapisuje się od nowa.
  public mutating func togglePrompt(_ rowId: String) {
    if expandedPrompts.remove(rowId) == nil { expandedPrompts.insert(rowId) }
    moved = true
  }

  public mutating func openDiffTail(_ id: String) {
    diffTails.insert(id)
    moved = true
  }

  /// Ręka przestawiła treść (karta, ogon diffu, seria — a seria jeszcze przesuwa ekran, żeby
  /// rozwijak został pod palcem): zapamiętany wiersz-kotwica opisuje ekran SPRZED przestawienia,
  /// a obrót albo klawiatura wróciłyby na niego. Po renderze miejsce zapisuje się od nowa.
  public private(set) var moved = false

  /// Po renderze: `true` raz na przestawienie — wtedy zapisać miejsce czytania.
  public mutating func takeMoved() -> Bool {
    defer { moved = false }
    return moved
  }

  /// Przed każdym renderem: linia „NOWE", zbocze decyzji, sprzątanie serii, których już nie ma, i rozwinięte prompty
  /// (`echoed`: wpis kolejki → `seq` jego echa, ze stanu rdzenia). `decision`: przygaszenie z reguły stopy
  /// (`DecisionDock.dims`, ekran sesji); `nil` = reguła bez doku.
  public mutating func prepare(_ view: TranscriptState?, echoed: [UUID: Int] = [:], decision: Bool? = nil) {
    newMarker.settle(view)
    let messages = view?.messages ?? []
    // Bez doku przygasa przy kartach z treścią w transkrypcie (`DecisionQueue.pending`), także przy karcie zamkniętej
    // i karcie kanału po decyzji; karta „dialog w terminalu” i trzymane potwierdzenie nie przygaszają. Z dokiem
    // rozstrzyga stopa (`DecisionDock.dims`).
    let decision = decision ?? !DecisionQueue.pending(in: view).isEmpty
    if decision, !decisionShown { collapseAutoDiffs(messages) }
    decisionShown = decision
    // Serie jak w wierszach (`messageRows`): przerwane na śladzie decyzji, inaczej rozwinięcie wskazałoby inną serię.
    let runs = ToolRuns.find(messages, breaks: view?.traceBreaks() ?? [])
    if !expandedRuns.isEmpty { expandedRuns = Self.carry(expandedRuns, from: knownRuns, to: runs) }
    knownRuns = runs
    if !expandedPrompts.isEmpty {
      expandedPrompts = Self.carryPrompts(expandedPrompts, messages: messages, echoed: echoed)
    }
  }

  /// Rozwinięte prompty po zmianie listy: rozwinięty wpis w locie, który zgasł echem, przekazuje rozwinięcie
  /// wierszom tekstu echa (dymek nie zwija się pod palcem przy potwierdzeniu); prompt, którego wiadomości już nie ma
  /// (przycięty początek transkryptu), wypada. Wpis jeszcze w drodze zostaje.
  static func carryPrompts(_ expanded: Set<String>, messages: [TranscriptMessage], echoed: [UUID: Int]) -> Set<String> {
    let bySeq = Dictionary(messages.map { ($0.seq, $0) }, uniquingKeysWith: { _, last in last })
    var out: Set<String> = []
    for key in expanded {
      if key.hasPrefix("o") {
        guard let entry = UUID(uuidString: String(key.dropFirst())), let seq = echoed[entry], let echo = bySeq[seq]
        else {
          out.insert(key)
          continue
        }
        for (index, block) in echo.blocks.enumerated() {
          if case .text = block { out.insert(TranscriptRows.blockId(seq: seq, index: index)) }
        }
      } else if let seq = TranscriptRows.messageSeq(key), bySeq[seq] != nil {
        out.insert(key)
      }
    }
    return out
  }

  /// Rozwinięcia na nowych seriach. Identyfikator serii to `seq` jej pierwszej wiadomości, a sufit
  /// 500 wiadomości ucina transkrypt od początku: seria na samej górze traci pierwszą wiadomość
  /// i zmienia numer. Rozwiniętą zostaje seria, która ma choć jedną wiadomość rozwiniętej; seria,
  /// której już nie ma, wypada.
  static func carry(_ expanded: Set<Int>, from old: [ToolRun], to new: [ToolRun]) -> Set<Int> {
    let carried = old.filter { expanded.contains($0.id) }.map { Set($0.tucked + [$0.tail]) }
    return Set(new.filter { run in
      expanded.contains(run.id) || carried.contains { !$0.isDisjoint(with: run.tucked + [run.tail]) }
    }.map(\.id))
  }

  /// Mini-diff nad kartą decyzji zajmuje 200–260 pt tą samą treścią, co karta. Zwijamy RAZ, na
  /// zboczu narastającym, i tylko te, których człowiek nie ruszył; nagłówek z `+N −M` zostaje.
  mutating func collapseAutoDiffs(_ messages: [TranscriptMessage]) {
    for message in messages {
      for (index, block) in message.blocks.enumerated() {
        guard case let .toolCall(tool) = block, tool.detailKind == .diff else { continue }
        let id = TranscriptRows.blockId(seq: message.seq, index: index)
        if touched[id] == nil { autoCollapsed.insert(id) }
      }
    }
  }
}

/// Miejsce czytania odpiętego transkryptu: wiersz i odległość górnej krawędzi ekranu od jego góry.
/// Wiersz, nie piksele — komórki samowymiarujące się przelewają przy innej szerokości.
public struct TranscriptAnchor: Sendable, Equatable {
  public let rowId: String
  public let offset: Double

  public init(rowId: String, offset: Double) {
    self.rowId = rowId
    self.offset = offset
  }

  /// Kotwica ekranu: pierwszy wiersz, którego dół jest pod górną krawędzią (`top`), i jak głęboko
  /// w nim stoi ekran. Wiersz wiadomości przeżywa przebudowę, wpis w locie i płynąca odpowiedź —
  /// nie, więc wygrywa pierwszy wiersz wiadomości. `rows` w kolejności listy.
  public static func capture(_ rows: [(id: String, minY: Double, maxY: Double)], top: Double) -> TranscriptAnchor? {
    let visible = rows.filter { $0.maxY > top }
    guard let pick = visible.first(where: { TranscriptRows.messageSeq($0.id) != nil }) ?? visible.first else { return nil }
    return TranscriptAnchor(rowId: pick.id, offset: top - pick.minY)
  }

  /// Wiersz, do którego wrócić, gdy zapamiętanego już nie ma (zwinięta seria, przycięty ogon):
  /// pierwszy wiersz wiadomości o tym samym albo późniejszym `seq`. `nil` = na dół.
  public func fallback(in ids: [String]) -> String? {
    guard let seq = TranscriptRows.messageSeq(rowId) else { return nil }
    return ids.first { (TranscriptRows.messageSeq($0) ?? .min) >= seq }
  }

  /// Ile wiersza zostaje na ekranie, gdy zapamiętane przesunięcie wypada za jego dzisiejszym końcem.
  public static let keepVisible: Double = 44

  /// Przesunięcie w wierszu o DZISIEJSZEJ wysokości. Zapisane przy innej (karta rozwinięta ręką,
  /// a rozwinięć nowa wizyta nie pamięta; tekst przelany przy innej szerokości) wypadłoby za
  /// wierszem — na późniejszą wiadomość albo na dno, które przypina. Wtedy na górze ekranu staje
  /// koniec wiersza: niski (zwinięta karta) cały, wysoki ostatnimi `keepVisible` punktami.
  public func offset(inRowOfHeight height: Double) -> Double {
    guard offset >= height else { return offset }
    return max(0, height - Self.keepVisible)
  }
}

/// Pozycje transkryptów MIĘDZY wizytami, w pamięci procesu: odpięty wraca na swoje
/// miejsce, przypięty wpisu nie ma i wraca na dno. Sufit 32, wypada najdawniej zapisana. Bez dysku:
/// po ubiciu apki transkrypt przychodzi od nowa, a stara pozycja nie opisuje już tego samego.
public struct TranscriptPositionMemory: Sendable, Equatable {
  public static let capacity = 32

  private var entries: [(id: String, anchor: TranscriptAnchor)] = []

  public init() {}

  public func recall(_ sessionId: String) -> TranscriptAnchor? {
    entries.last { $0.id == sessionId }?.anchor
  }

  /// `nil` = przypięty: wpis znika.
  public mutating func remember(_ sessionId: String, _ anchor: TranscriptAnchor?) {
    entries.removeAll { $0.id == sessionId }
    guard let anchor, !sessionId.isEmpty else { return }
    entries.append((sessionId, anchor))
    if entries.count > Self.capacity { entries.removeFirst(entries.count - Self.capacity) }
  }

  public static func == (a: Self, b: Self) -> Bool {
    a.entries.map(\.id) == b.entries.map(\.id) && a.entries.map(\.anchor) == b.entries.map(\.anchor)
  }
}

extension TranscriptRows {
  /// Identyfikator wiersza bloku wiadomości — ten sam, który niesie wiersz w `messageRows`.
  static func blockId(seq: Int, index: Int) -> String { "m\(seq).\(index)" }

  /// `seq` wiadomości z identyfikatora wiersza treści (`m<seq>.…`, znacznik `t<seq>`, seria `r<seq>`).
  static func messageSeq(_ rowId: String) -> Int? {
    guard let first = rowId.first, "mtr".contains(first) else { return nil }
    let digits = rowId.dropFirst().prefix { $0.isNumber }
    return Int(digits)
  }
}
