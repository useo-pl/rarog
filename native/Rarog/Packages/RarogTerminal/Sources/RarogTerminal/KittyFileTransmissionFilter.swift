/// Odcina transmisje plikowe grafiki Kitty przed SwiftTerm: komenda APC `G` z kluczem `t` o wartości zaczynającej się
/// od `f` (plik), `t` (plik tymczasowy) albo `s` (pamięć współdzielona) nie dochodzi do jego obsługi grafiki. `t=d`
/// (obraz w treści sekwencji) i brak klucza `t` (domyślnie `d`) przechodzą bez zmian.
///
/// Po co: SwiftTerm 1.19.0 przy trybach plikowych robi `stat`, czyta, a przy `t=t` kasuje plik ze ścieżki, którą
/// przysyła program w panelu (`t=s`: `shm_open`, `fstat`, `shm_unlink`). Terminal apki jest zdalny, więc taka ścieżka
/// wskazuje plik komputera z panelem, nie urządzenia.
///
/// Jak: filtr idzie po bajtach tym samym automatem stanów co parser SwiftTerm 1.19.0 (`EscapeSequenceParser`: stany
/// VT500, łańcuchy OSC i APC z pętlą do BEL, CAN albo ESC, tabela przejść na początku łańcucha i każdego kawałka,
/// C1 w 8 bitach poza stanem `ground`). Komendę z trybem plikowym unieważnia na bajcie, który by ją wysłał: przed ESC
/// wstawia CAN, a BEL i 8-bitowy ST (0x9C) zastępuje CAN. CAN kończy łańcuch APC bez wysłania, więc SwiftTerm nie
/// widzi komendy, nie odpowiada programowi i nie dotyka pliku; stan jego parsera zostaje ten sam co w modelu.
/// Po unieważnionej komendzie z `m=1` filtr unieważnia też jej kontynuacje (kolejne komendy `G` do pierwszej bez
/// `m=1`, przerywa je komenda usuwania `a=d`/`a=D`), bo kontynuacja nie powtarza `t` i SwiftTerm wziąłby ją za nowy
/// obraz `t=d` z ułamkiem ścieżki.
///
/// Stan filtra żyje tyle co powierzchnia: `reset()` emulatora (`resetToInitialState`) nie zeruje parsera SwiftTerm,
/// więc model też się nie zeruje. Gorąca ścieżka: kawałek bez zmian wraca jako `nil` (bez kopii), w stanie `ground`
/// filtr szuka tylko ESC, a w łańcuchu bez analizy tylko BEL, CAN i ESC.
struct KittyFileTransmissionFilter {
  private static let bel: UInt8 = 0x07
  private static let can: UInt8 = 0x18
  private static let sub: UInt8 = 0x1A
  private static let esc: UInt8 = 0x1B
  /// 8-bitowy ST: kończy łańcuch tylko w pozycji tabeli (początek łańcucha albo kawałka), w pętli jest treścią.
  private static let st: UInt8 = 0x9C

  /// Stany parsera SwiftTerm 1.19.0 (`ParserState`).
  private enum State {
    case ground, escape, escapeIntermediate
    case csiEntry, csiParam, csiIntermediate, csiIgnore
    case dcsEntry, dcsParam, dcsIntermediate, dcsIgnore, dcsPassthrough
    case sosPm, osc, apc
  }

  private enum Edit {
    /// CAN przed bajtem pod indeksem (ESC zostaje: zaczyna następną sekwencję).
    case cancelBefore(Int)
    /// CAN zamiast bajtu pod indeksem (BEL, 8-bitowy ST).
    case cancelInstead(Int)
  }

  private var state = State.ground
  /// W łańcuchu OSC/APC trwa pętla SwiftTerm (`oscPut`): kończą ją tylko BEL, CAN i ESC, reszta to treść. Pętla
  /// zaczyna się od bajtu treści w pozycji tabeli i nie przechodzi przez granicę kawałka.
  private var inStringLoop = false
  private var command = CommandScan()
  /// Po unieważnionej komendzie z `m=1`: następne komendy `G` to kontynuacje tej transmisji.
  private var droppingContinuation = false

  init() {}

  /// Kawałek po filtrze albo `nil`, gdy przechodzi bez zmian. Kawałki idą do SwiftTerm w tej samej kolejności
  /// i z tymi samymi granicami, co tutaj: granica zmienia pozycję łańcucha z pętli na tabelę.
  mutating func filter(_ chunk: ArraySlice<UInt8>) -> [UInt8]? {
    inStringLoop = false
    var edits: [Edit] = []
    var index = chunk.startIndex
    let end = chunk.endIndex
    while index < end {
      switch state {
      case .ground:
        // W `ground` SwiftTerm drukuje każdy bajt powyżej 0x1F (także 0x80–0x9F z UTF-8); stan zmienia tylko ESC.
        guard let found = chunk[index..<end].firstIndex(of: Self.esc) else { return Self.apply(edits, to: chunk) }
        state = .escape
        index = found + 1
      case .osc, .apc:
        if inStringLoop, state == .osc || !command.wantsContent {
          let found = chunk[index..<end].firstIndex { $0 == Self.bel || $0 == Self.can || $0 == Self.esc }
          guard let found else { return Self.apply(edits, to: chunk) }
          index = found
        }
        stringByte(chunk[index], at: index, edits: &edits)
        index += 1
      default:
        controlByte(chunk[index])
        index += 1
      }
    }
    return Self.apply(edits, to: chunk)
  }

  private static func apply(_ edits: [Edit], to chunk: ArraySlice<UInt8>) -> [UInt8]? {
    guard !edits.isEmpty else { return nil }
    var out: [UInt8] = []
    out.reserveCapacity(chunk.count + edits.count)
    var cursor = chunk.startIndex
    for edit in edits {
      switch edit {
      case .cancelBefore(let at):
        out.append(contentsOf: chunk[cursor..<at])
        out.append(can)
        cursor = at
      case .cancelInstead(let at):
        out.append(contentsOf: chunk[cursor..<at])
        out.append(can)
        cursor = at + 1
      }
    }
    out.append(contentsOf: chunk[cursor..<chunk.endIndex])
    return out
  }

  // MARK: - Stany poza łańcuchami OSC/APC

  /// Bajt w stanie innym niż `ground`, OSC i APC — przejścia z tabeli SwiftTerm.
  private mutating func controlByte(_ byte: UInt8) {
    switch byte {
    case Self.esc:
      state = .escape
      return
    case Self.sub, 0x19:
      // SUB: reguła „wszędzie”; EM (0x19) nie ma reguły, więc błąd i `ground`. CAN zostaje w stanie (C0 wykonywane).
      state = .ground
      return
    case 0x80...0x9F:
      c1(byte)
      return
    case 0xA0...:
      switch state {
      case .csiIgnore, .dcsIgnore, .dcsPassthrough: break
      default: state = .ground
      }
      return
    case 0x00...0x1F, 0x7F:
      return
    default:
      break
    }
    switch state {
    case .escape:
      switch byte {
      case 0x20...0x2F: state = .escapeIntermediate
      case 0x5B: state = .csiEntry
      case 0x5D: enterOSC()
      case 0x5F: enterAPC()
      case 0x50: state = .dcsEntry
      case 0x58, 0x5E: state = .sosPm
      default: state = .ground
      }
    case .escapeIntermediate:
      if byte >= 0x30 { state = .ground }
    case .csiEntry:
      switch byte {
      case 0x20...0x2F: state = .csiIntermediate
      case 0x3A: state = .ground
      case 0x30...0x3F: state = .csiParam
      default: state = .ground
      }
    case .csiParam:
      switch byte {
      case 0x20...0x2F: state = .csiIntermediate
      case 0x30...0x3B: break
      case 0x3C...0x3F: state = .csiIgnore
      default: state = .ground
      }
    case .csiIntermediate:
      switch byte {
      case 0x20...0x2F: break
      case 0x30...0x3F: state = .csiIgnore
      default: state = .ground
      }
    case .csiIgnore:
      if byte >= 0x40 { state = .ground }
    case .dcsEntry:
      switch byte {
      case 0x20...0x2F: state = .dcsIntermediate
      case 0x3A: state = .dcsIgnore
      case 0x30...0x3F: state = .dcsParam
      default: state = .dcsPassthrough
      }
    case .dcsParam:
      switch byte {
      case 0x20...0x2F: state = .dcsIntermediate
      case 0x30...0x39, 0x3B: break
      case 0x3A, 0x3C...0x3F: state = .dcsIgnore
      default: state = .dcsPassthrough
      }
    case .dcsIntermediate:
      switch byte {
      case 0x20...0x2F: break
      case 0x30...0x3F: state = .dcsIgnore
      default: state = .dcsPassthrough
      }
    case .dcsIgnore, .dcsPassthrough, .sosPm, .ground, .osc, .apc:
      break
    }
  }

  /// 8-bitowe C1 poza `ground` i poza pętlą łańcucha (reguły „wszędzie” tabeli SwiftTerm).
  private mutating func c1(_ byte: UInt8) {
    switch byte {
    case 0x90: state = .dcsEntry
    case 0x98, 0x9E: state = .sosPm
    case 0x9B: state = .csiEntry
    case 0x9D: enterOSC()
    case 0x9F: enterAPC()
    default: state = .ground
    }
  }

  private mutating func enterOSC() {
    state = .osc
    inStringLoop = false
  }

  private mutating func enterAPC() {
    state = .apc
    inStringLoop = false
    command = CommandScan()
  }

  // MARK: - Łańcuchy OSC i APC

  private mutating func stringByte(_ byte: UInt8, at index: Int, edits: inout [Edit]) {
    if inStringLoop {
      switch byte {
      case Self.bel: endString(dispatching: .cancelInstead(index), edits: &edits, next: .ground)
      case Self.esc: endString(dispatching: .cancelBefore(index), edits: &edits, next: .escape)
      case Self.can:
        state = .ground
        inStringLoop = false
      default: if byte >= 0x20, state == .apc { command.consume(byte) }
      }
      return
    }
    switch byte {
    case Self.bel, Self.st: endString(dispatching: .cancelInstead(index), edits: &edits, next: .ground)
    case Self.esc: endString(dispatching: .cancelBefore(index), edits: &edits, next: .escape)
    case Self.can, Self.sub, 0x19: state = .ground
    case 0x80...0x9F: c1(byte)
    case 0x20...:
      inStringLoop = true
      if state == .apc { command.consume(byte) }
    default:
      break
    }
  }

  /// Koniec łańcucha bajtem, przy którym SwiftTerm go wysyła. Unieważniona komenda dostaje CAN zamiast wysyłki.
  private mutating func endString(dispatching edit: Edit, edits: inout [Edit], next: State) {
    if state == .apc, cancelsCommand() { edits.append(edit) }
    state = next
    inStringLoop = false
  }

  /// Decyzja dla komendy APC wysyłanej teraz do SwiftTerm.
  private mutating func cancelsCommand() -> Bool {
    command.finish()
    guard command.isGraphics else { return false }
    if droppingContinuation, !command.isDelete {
      if !command.continues { droppingContinuation = false }
      return true
    }
    droppingContinuation = command.isFileTransmission && command.continues
    return command.isFileTransmission
  }
}

/// Sekcja kluczy komendy APC tak, jak ją rozbiera SwiftTerm: treść to bajty od 0x20 (niższe parser pomija), pierwszy
/// bajt to komenda (`G` = grafika Kitty), klucze do pierwszego `;`, pary rozdziela `,`, klucz od wartości pierwsze `=`.
/// `t` liczy się w KAŻDEJ parze (SwiftTerm bierze ostatnią, która się dekoduje — „każda” jest szersza); `m` i `a` jak
/// w SwiftTerm: ostatnia para.
private struct CommandScan {
  private enum Phase { case command, key, value, payload, other }

  private var phase = Phase.command
  private var keyByte: UInt8 = 0
  private var keyLength = 0
  private var valueLength = 0
  private var firstValueByte: UInt8 = 0
  private var moreDigits: [UInt8] = []

  private(set) var isGraphics = false
  private(set) var isFileTransmission = false
  /// Ostatnie `m` (SwiftTerm: liczba albo 0).
  private var more = 0
  /// Pierwszy bajt ostatniego `a` (`nil` = domyślne `t`).
  private var action: UInt8?

  var continues: Bool { more == 1 }
  var isDelete: Bool { action == UInt8(ascii: "d") || action == UInt8(ascii: "D") }
  /// Treść jeszcze coś znaczy (komenda albo sekcja kluczy); dalej filtr szuka tylko końca łańcucha.
  var wantsContent: Bool { phase == .command || phase == .key || phase == .value }

  mutating func consume(_ byte: UInt8) {
    switch phase {
    case .command:
      isGraphics = byte == UInt8(ascii: "G")
      phase = isGraphics ? .key : .other
      startPair()
    case .key:
      switch byte {
      case UInt8(ascii: ";"): phase = .payload
      case UInt8(ascii: ","): startPair()
      case UInt8(ascii: "="): phase = .value
      default:
        if keyLength == 0 { keyByte = byte }
        keyLength = min(keyLength + 1, 2)
      }
    case .value:
      switch byte {
      case UInt8(ascii: ";"):
        finishPair()
        phase = .payload
      case UInt8(ascii: ","):
        finishPair()
        phase = .key
        startPair()
      default:
        if valueLength == 0 {
          firstValueByte = byte
          if keyLength == 1, keyByte == UInt8(ascii: "t"),
            byte == UInt8(ascii: "f") || byte == UInt8(ascii: "t") || byte == UInt8(ascii: "s")
          {
            isFileTransmission = true
          }
        }
        if keyLength == 1, keyByte == UInt8(ascii: "m"), moreDigits.count <= 32 { moreDigits.append(byte) }
        valueLength += 1
      }
    case .payload, .other:
      break
    }
  }

  /// Koniec łańcucha bez `;`: ostatnia para też się liczy.
  mutating func finish() {
    if phase == .value { finishPair() }
    phase = .payload
  }

  private mutating func startPair() {
    keyLength = 0
    valueLength = 0
    moreDigits.removeAll(keepingCapacity: true)
  }

  private mutating func finishPair() {
    guard keyLength == 1 else { return }
    switch keyByte {
    case UInt8(ascii: "m"):
      more = moreDigits.count > 32 ? 0 : Int(String(decoding: moreDigits, as: UTF8.self)) ?? 0
    case UInt8(ascii: "a"):
      action = valueLength > 0 ? firstValueByte : nil
    default:
      break
    }
  }
}
