import Foundation

// Ślad powrotu terminala z tła w `client.log`: po aktywacji sceny po tle ekran terminala skakał (treść na pół
// ekranu, po ~2 s znów dobrze), a serwer i herdr nie zmieniały rozmiaru — skok powstaje w apce. Ślad mówi liczbami,
// co działo się z układem: od dezaktywacji sceny do aktywacji zmiany siatki i pominięte układy (ze stanem sceny),
// potem przez pierwsze 3 s próbki układu (wysokość i pozycja kontenera,
// siatka, przesunięcie i wstawka widoku powierzchni, prowadnica klawiatury, fokus), chwila pierwszego ekranu nowego
// gniazda i porcje bajtów po nim. Do 3 linii, każda w granicy `RarogStore.trace` (200 znaków). Zbiera i odmierza czas
// `TerminalScreenViewController`. Same liczby i słowa stałe, zero treści terminala. Logika bez
// UIKit testuje się na macOS. Właściciel: terminal.

/// Układ ekranu terminala w jednej chwili okna powrotu. Liczby w pełnych punktach.
public struct TerminalReturnLayout: Sendable, Equatable {
  /// Wysokość kontenera powierzchni.
  public var height: Int
  /// Lewy górny róg kontenera powierzchni we współrzędnych okna: przesunięcie całego ekranu przez rodzica.
  public var x: Int
  public var y: Int
  public var cols: Int
  public var rows: Int
  /// `contentOffset.y` widoku powierzchni (0, gdy widok nie jest `UIScrollView`).
  public var offset: Int
  /// `adjustedContentInset.bottom` widoku powierzchni (0, gdy widok nie jest `UIScrollView`).
  public var inset: Int
  /// Prowadnica klawiatury nad dołem widoku ekranu.
  public var keyboard: Int
  /// Powierzchnia jest pierwszym responderem.
  public var focused: Bool

  public init(
    height: Int, x: Int, y: Int, cols: Int, rows: Int, offset: Int, inset: Int, keyboard: Int, focused: Bool
  ) {
    self.height = height
    self.x = x
    self.y = y
    self.cols = cols
    self.rows = rows
    self.offset = offset
    self.inset = inset
    self.keyboard = keyboard
    self.focused = focused
  }

  /// Punkty z układu do pełnej liczby: zaokrąglone, przycięte do ±1 000 000, NaN = 0 — ślad nigdy nie przewraca apki.
  public static func points(_ value: Double) -> Int {
    guard value.isFinite else { return 0 }
    return Int(min(1_000_000, max(-1_000_000, value)).rounded())
  }
}

/// Stan sceny w chwili układu przed powrotem: `a` aktywna, `n` nieaktywna na pierwszym planie, `t` tło.
public enum TerminalReturnSceneState: Sendable, Equatable {
  case active
  case inactive
  case background

  var letter: String {
    switch self {
    case .active: "a"
    case .inactive: "n"
    case .background: "t"
    }
  }
}

/// Zbieranie jednego powrotu z tła: od dezaktywacji sceny zmiany siatki i pominięte układy, od ``begin(at:)``
/// (aktywacja sceny) próbki, pierwszy ekran i bajty. Linie składa ``lines()``.
public struct TerminalReturnTrace: Sendable {
  /// Okno próbek od aktywacji sceny.
  public static let window: Duration = .seconds(3)
  /// Odstęp próbek w oknie (oprócz próbki przy każdej zmianie siatki).
  public static let sampleInterval: Duration = .milliseconds(50)
  /// Najwięcej elementów sekcji „tło", próbek i porcji bajtów w pamięci.
  static let gridCap = 6
  static let sampleCap = 12
  static let portionCap = 6
  /// Porcje bajtów bliższe niż tyle sklejają się w jedną.
  static let portionGap: Duration = .milliseconds(100)
  /// Najdłuższa linia, jaką przepuszcza `RarogStore.trace` (dłuższą ucina) — co się nie mieści, idzie do licznika
  /// „+N dalszych".
  static let maxLength = 200
  /// Najwięcej linii układu (próbki rozłożone po kolei).
  static let layoutLineCap = 2
  static let prefix = "terminal: powrót z tła; "

  private struct Sample: Sendable {
    let ms: Int
    let layout: TerminalReturnLayout
  }

  private struct Portion: Sendable {
    let ms: Int
    var bytes: Int
  }

  /// Element sekcji „tło": zmiana siatki albo pominięty układ (wysokość widoku powierzchni), ze stanem sceny.
  private enum Pause: Sendable, Equatable {
    case grid(TerminalReturnSceneState, cols: Int, rows: Int)
    case skipped(TerminalReturnSceneState, height: Int)

    var text: String {
      switch self {
      case let .grid(state, cols, rows): "\(state.letter)\(cols)×\(rows)"
      case let .skipped(state, height): "\(state.letter)~\(height)pt"
      }
    }
  }

  private var pauses: [Pause] = []
  private var lastPause: Pause?
  private var extraPauses = 0
  /// Scena zeszła w tło w czasie zbierania — dopiero wtedy aktywacja daje linie.
  public private(set) var sawBackground = false
  /// Chwila aktywacji sceny po tle; `nil` = jeszcze w tle.
  public private(set) var started: ContinuousClock.Instant?
  private var samples: [Sample] = []
  private var lastLayout: TerminalReturnLayout?
  private var extraSamples = 0
  private var firstScreenMs: Int?
  private var portions: [Portion] = []
  private var extraPortions = 0
  private var lastChunk: ContinuousClock.Instant?

  public init() {}

  /// Okno próbek trwa (scena aktywna po tle).
  public var isRunning: Bool { started != nil }

  /// Scena zeszła w tło.
  public mutating func enteredBackground() {
    sawBackground = true
  }

  /// Siatka zgłoszona przez powierzchnię przed aktywacją.
  public mutating func grid(cols: Int, rows: Int, state: TerminalReturnSceneState) {
    pause(.grid(state, cols: cols, rows: rows))
  }

  /// Układ, który nie doszedł do renderera przed aktywacją: wysokość widoku powierzchni w pełnych punktach.
  public mutating func skippedLayout(height: Int, state: TerminalReturnSceneState) {
    pause(.skipped(state, height: height))
  }

  /// Element sekcji „tło": powtórzenie pod rząd zlewa się z poprzednim; ponad ``gridCap`` liczy się tylko.
  private mutating func pause(_ pause: Pause) {
    guard started == nil, pause != lastPause else { return }
    lastPause = pause
    if pauses.count < Self.gridCap {
      pauses.append(pause)
    } else {
      extraPauses += 1
    }
  }

  /// Aktywacja sceny po tle: t0 próbek, pierwszego ekranu i bajtów.
  public mutating func begin(at now: ContinuousClock.Instant) {
    guard started == nil else { return }
    started = now
  }

  /// Próbka układu: identyczna z poprzednią (poza czasem) zlewa się z nią; ponad ``sampleCap`` liczy się tylko.
  public mutating func sample(_ layout: TerminalReturnLayout, at now: ContinuousClock.Instant) {
    guard let started, layout != lastLayout else { return }
    lastLayout = layout
    if samples.count < Self.sampleCap {
      samples.append(Sample(ms: TerminalOpenTrace.milliseconds(now - started), layout: layout))
    } else {
      extraSamples += 1
    }
  }

  /// Narysowany pierwszy ekran nowego gniazda — liczy się pierwszy po aktywacji.
  public mutating func firstScreen(at now: ContinuousClock.Instant) {
    guard let started, firstScreenMs == nil else { return }
    firstScreenMs = TerminalOpenTrace.milliseconds(now - started)
  }

  /// Porcja bajtów po pierwszym ekranie (wcześniejsze należą do niego). Bliżej niż ``portionGap`` od poprzedniej
  /// sklejają się; ponad ``portionCap`` porcji liczy się tylko ich liczba.
  public mutating func bytes(_ count: Int, at now: ContinuousClock.Instant) {
    guard let started, firstScreenMs != nil else { return }
    defer { lastChunk = now }
    if let lastChunk, now - lastChunk < Self.portionGap {
      if extraPortions == 0, !portions.isEmpty { portions[portions.count - 1].bytes += count }
      return
    }
    if portions.count < Self.portionCap {
      portions.append(Portion(ms: TerminalOpenTrace.milliseconds(now - started), bytes: count))
    } else {
      extraPortions += 1
    }
  }

  /// Linie śladu, każda najwyżej ``maxLength`` znaków (tyle przepuszcza `RarogStore.trace`) i każda od
  /// „terminal: powrót z tła; ". Czasy „+N" to ms od aktywacji sceny.
  /// - linia 1: „tło n~374pt t97×70 a134×51; ekran +640 ms; bajty +710 2100B, +1930 15300B" — sekcja „tło" to
  ///   zmiany siatki (`<stan><kolumny>×<wiersze>`) i pominięte układy (`<stan>~<wysokość>pt`) od dezaktywacji sceny,
  ///   stan `a`/`n`/`t` (``TerminalReturnSceneState``); za długa linia traci porcje bajtów od końca, potem elementy
  ///   sekcji „tło", na rzecz licznika „+N dalszych";
  /// - linie układu (najwyżej ``layoutLineCap``): „układ +0 748pt x0 y74 134×51 p0 w0 k0 fokus, +85 374pt 134×25 k374".
  ///   Próbka: wysokość kontenera, `x`/`y` jego rogu w oknie, siatka, `p` przesunięcie (`contentOffset.y`), `w` wstawka
  ///   (`adjustedContentInset.bottom`), `k` prowadnica klawiatury, fokus. Pierwsza próbka linii pełna, następne tylko
  ///   z polami zmienionymi. Próbki, które się nie mieszczą (i ponad ``sampleCap``), idą do „+N dalszych" ostatniej.
  public func lines() -> [String] {
    [summaryLine()] + layoutLines()
  }

  private func summaryLine() -> String {
    var gridsShown = pauses.count
    var portionsShown = portions.count
    func render() -> String {
      let background = pauses.isEmpty ? "brak" : Self.list(
        pauses.prefix(gridsShown).map(\.text), separator: " ", hidden: pauses.count - gridsShown + extraPauses)
      let screen = firstScreenMs.map { "+\($0) ms" } ?? "brak"
      let bytes = portions.isEmpty ? "brak" : Self.list(
        portions.prefix(portionsShown).map { "+\($0.ms) \($0.bytes)B" }, separator: ", ",
        hidden: portions.count - portionsShown + extraPortions)
      return Self.prefix + "tło \(background); ekran \(screen); bajty \(bytes)"
    }
    var line = render()
    while line.count > Self.maxLength, portionsShown > 0 {
      portionsShown -= 1
      line = render()
    }
    while line.count > Self.maxLength, gridsShown > 0 {
      gridsShown -= 1
      line = render()
    }
    return line
  }

  private func layoutLines() -> [String] {
    let head = Self.prefix + "układ "
    guard !samples.isEmpty else { return [head + (extraSamples > 0 ? "+\(extraSamples) dalszych" : "brak")] }
    var groups: [[String]] = []
    var index = 0
    while index < samples.count, groups.count < Self.layoutLineCap {
      var parts = [Self.describe(samples[index], after: nil)]
      index += 1
      while index < samples.count {
        let next = Self.describe(samples[index], after: samples[index - 1].layout)
        guard (head + (parts + [next]).joined(separator: ", ")).count <= Self.maxLength else { break }
        parts.append(next)
        index += 1
      }
      groups.append(parts)
    }
    var hidden = samples.count - index + extraSamples
    var last = groups.removeLast()
    while hidden > 0, last.count > 1,
      (head + last.joined(separator: ", ") + " +\(hidden) dalszych").count > Self.maxLength {
      last.removeLast()
      hidden += 1
    }
    groups.append(last)
    return groups.enumerated().map { position, parts in
      let tail = position == groups.count - 1 && hidden > 0 ? " +\(hidden) dalszych" : ""
      return head + parts.joined(separator: ", ") + tail
    }
  }

  /// Elementy listy i licznik tych, które się nie zmieściły.
  private static func list(_ items: [String], separator: String, hidden: Int) -> String {
    let shown = items.joined(separator: separator)
    guard hidden > 0 else { return shown }
    return shown + (items.isEmpty ? "" : " ") + "+\(hidden) dalszych"
  }

  /// Próbka ze wszystkimi polami (`previous == nil`) albo z polami zmienionymi względem poprzedniej.
  private static func describe(_ sample: Sample, after previous: TerminalReturnLayout?) -> String {
    let now = sample.layout
    var fields = ["+\(sample.ms)"]
    if now.height != previous?.height { fields.append("\(now.height)pt") }
    if now.x != previous?.x { fields.append("x\(now.x)") }
    if now.y != previous?.y { fields.append("y\(now.y)") }
    if now.cols != previous?.cols || now.rows != previous?.rows { fields.append("\(now.cols)×\(now.rows)") }
    if now.offset != previous?.offset { fields.append("p\(now.offset)") }
    if now.inset != previous?.inset { fields.append("w\(now.inset)") }
    if now.keyboard != previous?.keyboard { fields.append("k\(now.keyboard)") }
    if now.focused != previous?.focused { fields.append(now.focused ? "fokus" : "bez fokusu") }
    return fields.joined(separator: " ")
  }
}

/// Podbudżet śladów powrotu z tła: najwyżej ``cap`` powrotów (każdy do 3 linii) na ``window`` w budżecie śladów apki
/// (`ContractReporter.traceCap`, 20 linii na godzinę) — powrót z tła zdarza się często.
public struct TerminalReturnTraceBudget: Sendable, Equatable {
  public static let cap = 4
  public static let window: Duration = .seconds(3600)
  private var windowStart: ContinuousClock.Instant?
  private var admitted = 0

  public init() {}

  /// `true` = zapisać ślad (i odliczyć go z budżetu). Okno liczy się od pierwszego śladu po poprzednim oknie.
  public mutating func admit(now: ContinuousClock.Instant) -> Bool {
    if let start = windowStart, now - start < Self.window {
      guard admitted < Self.cap else { return false }
    } else {
      windowStart = now
      admitted = 0
    }
    admitted += 1
    return true
  }
}
