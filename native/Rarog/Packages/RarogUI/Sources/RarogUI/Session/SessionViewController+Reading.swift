#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

// Czytanie transkryptu: karty narzędzi i serie, linia „NOWE" z pamięcią urządzenia
// i pigułka „N nowych wiadomości" nad nią, pasek „Przewiń na dół",
// przygaszenie pod decyzją. Rdzeń woła stąd `buildReading`, `prepareReading`, `finishReading`
// i `leaveReading` po jednej linii. Przypięcie i powrót na miejsce: `+Pinning`. Właściciel: transkrypt.

/// Pamięć czytania poza ekranem sesji: pozycje w procesie, „dotąd przeczytane" na urządzeniu.
@MainActor
enum TranscriptMemory {
  static var positions = TranscriptPositionMemory()
  static var preferences: PreferenceStore = UserDefaults.standard
}

/// UIKit-owy stan czytania jednego ekranu sesji (rozszerzenia nie mają pól).
@MainActor
final class ReadingChrome {
  let jumpBar = JumpToBottomBar()
  /// Pasek „na dół” nad listą podpowiedzi komend, gdy ta stoi, i jego sufit pod górą safe area
  /// (`+CommandSuggestions`).
  var jumpAboveSuggestions: NSLayoutConstraint?
  var jumpUnderTop: NSLayoutConstraint?
  /// Pigułka „N nowych wiadomości" i jej dwa miejsca: pod górą safe area albo pod paskiem cytatu, gdy ten
  /// stoi. Drugie powstaje przy pierwszym pasku (`placeNewPill`): pasek cytatu buduje się po czytaniu.
  let newPill = NewMessagesPill()
  var newPillAtTop: NSLayoutConstraint?
  var newPillUnderBar: NSLayoutConstraint?
  /// Ocena pigułki zaplanowana na następny obrót pętli (`scheduleNewPill`) i ocena po ciszy (`NewPillState.wait`).
  var newPillPending = false
  var newPillQuiet: Task<Void, Never>?
  /// Gest człowieka w toku (od `scrollViewWillBeginDragging` do końca przeciągnięcia albo wytracania) i ślad, że
  /// od ostatniej oceny pigułki listę przesunął gest — tylko taki ruch gasi pigułkę (`+Pinning`).
  var gesture = false
  var movedByGesture = false
  /// Animowany skok do linii „NOWE" w toku: koniec animacji (albo zapas 1 s) dociąga linię i zapisuje miejsce
  /// (`finishLineJump`), gest go odwołuje.
  var lineJumping = false
  var lineJumpDeadline: Task<Void, Never>?
  /// Przygaszenie, z którym skonfigurowano komórki; zbocze = przekonfiguruj wszystkie.
  var dimmed = false
  /// Miejsce do odtworzenia przy pierwszej treści (powrót do odpiętej sesji).
  var restore: TranscriptAnchor?
  /// Wiersz trzymany pod palcem przy rozwinięciu serii albo długiego promptu: id i położenie na ekranie jego góry
  /// (`bottom == false`) albo dołu.
  var hold: (rowId: String, screenY: CGFloat, bottom: Bool)?
  /// Wymiary listy przy poprzednim układzie — zmiana to obrót, klawiatura albo Cmd+Tab.
  var layoutSize: CGSize = .zero
  /// Szerokość listy, przy której policzono miejsce godziny przy dymku (obok albo pod, `refreshPromptClocks`).
  var clockWidth: CGFloat = 0
  /// `settleAtBottom` w toku — blokada ponownego wejścia (zmiana wysokości treści w środku układu).
  var settling = false
  /// Animowany skok „Przewiń na dół" w toku: automatyczne zejście na dno (układ, render, wysokość treści)
  /// czeka, inaczej przerwałoby animację skokiem bez niej. Kasuje go koniec animacji, gest albo zapas czasu.
  var jumpAnimating = false
  /// Zapas: animacja, która nie zgłosiła końca (okno poza ekranem, apka w tle), nie blokuje dna na zawsze.
  var jumpDeadline: Task<Void, Never>?
  /// Motyw i pismo, z którymi skonfigurowano komórki (`+Look`); `nil` = przed pierwszym renderem.
  var look: TranscriptLook?
  /// Zmiana cech przyszła w tle (zrzuty przełącznika aplikacji w obu motywach): rozstrzyga powrót na wierzch.
  var lookPending = false
  /// Ekran stał w oknie przy zejściu w tło (i zapisał wtedy „doczytane"): powrót na wierzch zaczyna nową wizytę
  /// czytania.
  var backgrounded = false
  /// Liczniki dla testów UIKit (brak rekursji, przebudowy przy wejściu i powrocie z tła) i śladu wejścia do sesji;
  /// w apce tylko rosną.
  var counters = TranscriptCounters()
  /// Okno wejścia do sesji (``SessionEntryWindow``): od `buildReading` do ciszy po pierwszej ramce. Wiadomości
  /// pierwszej ramki czekają na linię (rozmiar liczy się dopiero po oknie, żeby kodowanie nie wpadło w pomiar).
  var entry: SessionEntryWindow?
  var entryMessages: [TranscriptMessage] = []
  var entryCheck: Task<Void, Never>?
  /// Rozmiar ramki liczony poza głównym aktorem, zanim linia wyjdzie (`traceEntry`).
  var entryEncode: Task<Void, Never>?
  /// Podbudżet śladów wejścia, wspólny dla procesu (``SessionEntryTraceBudget``).
  static var entryBudget = SessionEntryTraceBudget()

  /// Zwolniony ekran nie czeka na ciszę i nie koduje ramki do linii, która już nie wyjdzie.
  isolated deinit {
    entryCheck?.cancel()
    entryEncode?.cancel()
  }
}

/// Ile pracy zrobił ekran transkryptu — odczyt dla testów i śladu wejścia do sesji, bez treści.
struct TranscriptCounters: Equatable {
  var renders = 0
  var reconfigures = 0
  var settles = 0
  var bottomScrolls = 0
  /// Najwięcej obrotów układu w jednym `settleAtBottom`.
  var maxSettleTurns = 0

  var entry: SessionEntryCounts { SessionEntryCounts(renders: renders, settles: settles, bottomScrolls: bottomScrolls) }
}

extension SessionViewController {
  // MARK: - Cykl życia

  /// `viewDidLoad`, przed pierwszym renderem: linia „NOWE" z pamięci urządzenia, miejsce czytania
  /// z pamięci procesu (odpięta sesja wraca na nie, przypięta na dno) i pasek „na dół".
  func buildReading() {
    beginEntryTrace()
    ui.reading = TranscriptReading(newMarker: visitMarker())
    if let anchor = TranscriptMemory.positions.recall(sessionId) {
      pinned = false
      readingChrome.restore = anchor
    }

    let bar = readingChrome.jumpBar
    bar.translatesAutoresizingMaskIntoConstraints = false
    bar.addAction(UIAction { [weak self] _ in self?.jumpToBottom() }, for: .primaryActionTriggered)
    view.addSubview(bar)
    // Nad wierszem aktywności i polem: unosi się nad transkryptem, nie zasłania pola. Przy liście podpowiedzi
    // komend wchodzi nad nią (`+CommandSuggestions`), więc to miejsce ustępuje więzowi listy — także jej wysokości
    // (999): przy równym priorytecie układ skraca listę do jednego pasa pod paskiem (zmierzone testem UIKit).
    let overTranscript = bar.bottomAnchor.constraint(equalTo: footTopAnchor, constant: -8)
    overTranscript.priority = .defaultHigh - 1
    NSLayoutConstraint.activate([
      // Oś kolumny w safe area, jak karta pola, tekst transkryptu i dymek nad promptem (`+Toast`).
      bar.centerXAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerXAnchor),
      overTranscript,
      bar.leadingAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
    ])
    buildNewPill()

    let previous = collectionView.onContentSizeChange
    collectionView.onContentSizeChange = { [weak self] in
      previous?()
      self?.updateJumpBar()
    }
    NotificationCenter.default.addObserver(
      self, selector: #selector(readingEnteredBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
    NotificationCenter.default.addObserver(
      self, selector: #selector(readingEnteredForeground), name: TranscriptAppPhase.foreground, object: nil)
  }

  /// Początek wizyty czytania: linia „NOWE" od tego, co urządzenie zapisało jako doczytane, z granicą „na żywo"
  /// w tej chwili i licznikiem pełnych stanów, po którym dopiero następny jest świeży (`NewMarkerDecision`).
  private func visitMarker() -> NewMarkerDecision {
    NewMarkerDecision(
      seenAt: LastSeenMemory.load(from: TranscriptMemory.preferences).seenAt(sessionId),
      snapshotsAtEntry: store.state.transcripts[sessionId]?.snapshots ?? 0, enteredAt: Date())
  }

  /// Przed składaniem wierszy: linia „NOWE", zbocze decyzji (jednorazowe zwinięcie mini-diffów), serie.
  func prepareReading(_ state: AppState) {
    // Przygaszenie z reguły stopy (`DecisionDock.dims`): z dokiem przy decyzji w doku albo w transkrypcie, bez doku
    // według kart z treścią w transkrypcie.
    let view = state.transcripts[sessionId]
    ui.reading.prepare(
      view, echoed: state.echoed, decision: DecisionDock.dims(foot: footContent, view: view, mode: decisionMode))
  }

  /// Po nałożeniu migawki: przygaszenie, napis paska, wiersz pod palcem, powrót na miejsce.
  func finishReading() {
    let dim = ui.reading.decisionShown
    if dim != readingChrome.dimmed {
      readingChrome.dimmed = dim
      var snapshot = dataSource.snapshot()
      snapshot.reconfigureItems(snapshot.itemIdentifiers)
      dataSource.apply(snapshot, animatingDifferences: false)
    }
    // Karta w doku stoi zawsze na widoku: pasek mówi „Przewiń na dół”, nie „Przewiń do decyzji”.
    readingChrome.jumpBar.setDecision(dim && dockModel == nil)
    keepHeldRow()
    restorePosition()
    if ui.reading.takeMoved() { rememberMovedPosition() }
    updateJumpBar()
  }

  /// Wyjście z ekranu (także zmiana zakładki): „dotąd przeczytane" i miejsce czytania.
  func leaveReading() {
    rememberLastSeen()
    rememberPosition()
    // Wyjście albo tło w trakcie okna wejścia psuje czasy: okno przepada bez linii.
    dropEntryTrace()
  }

  // MARK: - Ślad wejścia do sesji

  /// Otwarcie ekranu sesji: początek okna. Bez ramki do sufitu okno przepada (sprawdzenie na sufit).
  private func beginEntryTrace() {
    let now = ContinuousClock.now
    readingChrome.entry = SessionEntryWindow(
      opened: now, snapshotsAtEntry: store.state.transcripts[sessionId]?.snapshots ?? 0,
      counts: readingChrome.counters.entry)
    scheduleEntryCheck(at: now + SessionEntryWindow.ceiling)
  }

  /// Punkt obserwacji okna wejścia: render (początek i koniec), dojście do dna po renderze, układ ekranu, zmiana
  /// wysokości treści. Ramkę otwiera tylko początek renderu; pierwsza ramka zapamiętuje swoje wiadomości i planuje
  /// sprawdzenie ciszy.
  func observeEntry(_ point: SessionEntryWindow.Point = .layout) {
    guard var window = readingChrome.entry else { return }
    let view = store.state.transcripts[sessionId]
    let now = ContinuousClock.now
    let firstFrame = window.observe(
      point, snapshots: view?.snapshots ?? 0, counts: readingChrome.counters.entry, now: now)
    readingChrome.entry = window
    guard firstFrame else { return }
    readingChrome.entryMessages = view?.messages ?? []
    scheduleEntryCheck(at: now + SessionEntryWindow.quiet)
  }

  private func scheduleEntryCheck(at instant: ContinuousClock.Instant) {
    readingChrome.entryCheck?.cancel()
    readingChrome.entryCheck = Task { @MainActor [weak self] in
      var wake = instant
      while !Task.isCancelled {
        try? await Task.sleep(until: wake, clock: .continuous)
        guard !Task.isCancelled, let self, var window = self.readingChrome.entry else { return }
        let step = window.check(counts: self.readingChrome.counters.entry, now: .now)
        self.readingChrome.entry = window
        switch step {
        case let .wait(until): wake = until
        case let .done(result):
          self.traceEntry(result)
          return
        case .abandoned:
          self.dropEntryTrace()
          return
        }
      }
    }
  }

  /// Linia do `client.log`. Na głównym aktorze: podbudżet (najpierw — linii, której nie przepuści, nie ma po co
  /// kodować), przechwycenie wiadomości i wysłanie gotowej linii; kodowanie ramki (JSON, do kilku MiB) idzie poza
  /// nim (`SessionEntryWindow.kilobytes(of:)`). Wyjście z ekranu (`dropEntryTrace`) i zwolnienie ekranu anulują
  /// pracę i linia nie wychodzi.
  private func traceEntry(_ result: SessionEntryWindow.Result) {
    let messages = readingChrome.entryMessages
    readingChrome.entry = nil
    readingChrome.entryMessages = []
    readingChrome.entryCheck = nil
    guard ReadingChrome.entryBudget.admit(now: .now) else { return }
    let sessionId = sessionId
    readingChrome.entryEncode = Task { @MainActor [weak self] in
      let kilobytes = await SessionEntryWindow.kilobytes(of: messages)
      guard !Task.isCancelled, let self else { return }
      self.readingChrome.entryEncode = nil
      self.store.trace(DiagnosticsTrace.sessionEntry(sessionId: sessionId, result: result, kilobytes: kilobytes))
    }
  }

  private func dropEntryTrace() {
    readingChrome.entryCheck?.cancel()
    readingChrome.entryCheck = nil
    readingChrome.entryEncode?.cancel()
    readingChrome.entryEncode = nil
    readingChrome.entry = nil
    readingChrome.entryMessages = []
  }

  /// Zejście w tło liczy się jak wyjście: po nim apka bywa ubijana. Zapisuje WYŁĄCZNIE ekran w oknie:
  /// odłączony kontroler (przy życiu trzyma go trwająca wysyłka) opisuje ekran sprzed wyjścia — swoje
  /// zapisał w `viewWillDisappear`, a drugi zapis skasowałby nowszą kotwicę tej sesji z nowego ekranu.
  @objc private func readingEnteredBackground() {
    guard isViewLoaded, view.window != nil else { return }
    leaveReading()
    readingChrome.backgrounded = true
  }

  /// Powrót z tła z tą sesją na ekranie = nowa wizyta czytania, jak wejście do kanału
  /// w Slacku po przerwie: linia od tego, co ten ekran zapisał przy zejściu w tło, nad pierwszą wiadomością agenta,
  /// która przyszła pod nieobecność. Rozwinięcia, przypięcie i miejsce czytania zostają; lista nie jedzie do linii.
  /// Tylko ekran, który zapisał przy zejściu w tło — Stage Manager i Split View bez zejścia w tło niczego nie zmieniają.
  @objc private func readingEnteredForeground() {
    guard readingChrome.backgrounded else { return }
    readingChrome.backgrounded = false
    guard isViewLoaded, view.window != nil else { return }
    // Linia z poprzedniej wizyty znika; nad ekranem odpiętego transkryptu przesunęłaby treść o swoją wysokość.
    if ui.reading.newMarker.seq != nil, !pinned { holdTopRow() }
    ui.reading.newMarker = visitMarker()
    scheduleRender()
  }

  /// Odpięty transkrypt: pierwszy widoczny wiersz (poza samą linią) zostaje pod palcem w następnym renderze
  /// (`keepHeldRow`).
  private func holdTopRow() {
    guard let row = topRowOnScreen() else { return }
    readingChrome.hold = (row.rowId, row.screenY, false)
  }

  /// `at` najnowszej wyrenderowanej wiadomości — wpisy w locie nie mają jeszcze czasu serwera.
  private func rememberLastSeen() {
    guard let newest = store.state.transcripts[sessionId]?.messages.last?.at else { return }
    var memory = LastSeenMemory.load(from: TranscriptMemory.preferences)
    if memory.note(sessionId, at: newest) { memory.save(to: TranscriptMemory.preferences) }
  }

  // MARK: - Przygaszenie

  /// Krycie wiersza: pod stojącą decyzją przygasa wszystko poza samymi kartami, a wyciszony
  /// atrament słabiej niż tekst — przygaszona treść zostaje powyżej 7:1 (`TranscriptDim`).
  func dimAlpha(_ row: TranscriptRow) -> CGFloat {
    guard ui.reading.decisionShown else { return 1 }
    switch row {
    case .permission, .question: return 1
    default: return TranscriptDim.alpha(TranscriptDim.ink(row), traits: traitCollection)
    }
  }

  // MARK: - Karty narzędzi i serie

  func toolCardView(_ model: ToolRowModel) -> some View {
    ToolCardView(
      model: model,
      plainSyntax: ui.reading.decisionShown,
      toggle: { [weak self] in self?.toggleTool(model) },
      openDiffTail: { [weak self] in self?.openDiffTail(model.id) })
  }

  func toolRunView(_ model: ToolRunModel) -> some View {
    ToolRunChipView(model: model) { [weak self] in self?.toggleRun(model) }
  }

  private func toggleTool(_ model: ToolRowModel) {
    guard model.expandable else { return }
    ui.reading.toggle(model.id, diff: model.diff != nil)
    scheduleRender()
  }

  private func openDiffTail(_ id: String) {
    ui.reading.openDiffTail(id)
    scheduleRender()
  }

  /// Rozwinięcie wstawia kroki NAD rozwijakiem, więc ten zostaje pod palcem (odpięty transkrypt);
  /// przypięty zostaje przypięty. Bez animacji: ruch tylko po geście, a i tak byłby skokiem.
  private func toggleRun(_ model: ToolRunModel) {
    if !pinned, let index = dataSource.indexPath(for: model.rowId),
      let frame = collectionView.layoutAttributesForItem(at: index)?.frame
    {
      readingChrome.hold = (model.rowId, frame.minY - collectionView.contentOffset.y, false)
    }
    ui.reading.toggleRun(model.id)
    scheduleRender()
  }

  /// Długi prompt: rozwinięcie trzyma w miejscu GÓRĘ dymku — czyta się dalej od szóstej linii; zwinięcie trzyma
  /// pod palcem DÓŁ wiersza, czyli przycisk — inaczej po zwinięciu długiego tekstu ekran stałby gdzieś za nim. Bez
  /// animacji, przypięty zostaje przypięty (jak rozwijak serii).
  func togglePromptFold(_ rowId: String) {
    let expanding = !ui.reading.expandedPrompts.contains(rowId)
    if !pinned, let index = dataSource.indexPath(for: rowId),
      let frame = collectionView.layoutAttributesForItem(at: index)?.frame
    {
      let edge = expanding ? frame.minY : frame.maxY
      readingChrome.hold = (rowId, edge - collectionView.contentOffset.y, !expanding)
    }
    ui.reading.togglePrompt(rowId)
    scheduleRender()
  }

  /// Po przesunięciu na ekran wchodzą komórki, które miały dotąd wysokość szacunkową; ich prawdziwa wysokość przesuwa
  /// trzymany wiersz, więc kilka obrotów, aż krawędź stanie (zwinięcie długiego promptu przewija o setki punktów).
  private func keepHeldRow() {
    guard let hold = readingChrome.hold else { return }
    readingChrome.hold = nil
    guard !pinned, let index = dataSource.indexPath(for: hold.rowId) else { return }
    for _ in 0..<Self.holdTurns {
      collectionView.layoutIfNeeded()
      guard let frame = collectionView.layoutAttributesForItem(at: index)?.frame else { return }
      let target = (hold.bottom ? frame.maxY : frame.minY) - hold.screenY
      guard abs(collectionView.contentOffset.y - target) > 0.5 else { return }
      setClampedOffset(target)
    }
  }

  /// Najwięcej obrotów trzymania wiersza pod palcem w jednym renderze.
  static let holdTurns = 3

  // MARK: - Pasek „Przewiń na dół"

  /// Pasek stoi wyłącznie po odjechaniu od dna; dymek nad promptem staje nad nim (`+Toast`). Każda zmiana położenia
  /// listy planuje też ocenę pigułki „N nowych".
  func updateJumpBar() {
    readingChrome.jumpBar.setShown(!pinned && distanceFromBottom() > Self.pinThreshold)
    placeToast()
    scheduleNewPill()
  }

  /// Skok na dno przypina — jak gest, który kończy się przy dnie. Pasek znika od razu, bez krycia: informacją
  /// zwrotną jest ruch listy (`JumpToBottomBar.setShown(_:animated:)`). Animowany skok trzyma `jumpAnimating` do
  /// `scrollViewDidEndScrollingAnimation` (`+Pinning`): układ zaplanowany w międzyczasie (choćby przestawienie
  /// dymka nad pasek) nie stawia listy na dnie bez animacji w pół drogi.
  func jumpToBottom() {
    pinned = true
    cancelLineJump()
    takeOverFromGesture()
    TranscriptMemory.positions.remember(sessionId, nil)
    readingChrome.jumpBar.setShown(false, animated: false)
    placeToast()
    let inset = collectionView.adjustedContentInset
    let bottom = max(-inset.top, collectionView.contentSize.height + inset.bottom - collectionView.bounds.height)
    let animated = !UIAccessibility.isReduceMotionEnabled && abs(collectionView.contentOffset.y - bottom) > 0.5
    readingChrome.jumpAnimating = animated
    readingChrome.jumpDeadline?.cancel()
    if animated {
      readingChrome.jumpDeadline = Task { @MainActor [weak self] in
        try? await Task.sleep(for: .seconds(1))
        guard let self, !Task.isCancelled else { return }
        self.finishJump()
      }
    }
    collectionView.setContentOffset(CGPoint(x: collectionView.contentOffset.x, y: bottom), animated: animated)
  }

  /// Koniec animowanego skoku (zgłoszony przez listę albo po zapasie czasu): treść mogła urosnąć w trakcie,
  /// więc dojście do dna od nowa.
  func finishJump() {
    readingChrome.jumpDeadline?.cancel()
    readingChrome.jumpDeadline = nil
    guard readingChrome.jumpAnimating else { return }
    readingChrome.jumpAnimating = false
    if pinned, !collectionView.isUserScrolling { settleAtBottom() }
    updateJumpBar()
  }

  // MARK: - Pigułka „N nowych wiadomości"

  /// Odstęp pigułki od paska cytatu albo od góry safe area — ten sam, który po tapie zostaje nad linią.
  static let newPillGap = CGFloat(NewLineJump.gap)

  /// Na osi kolumny, jak pasek „na dół"; u góry safe area. Miejsce pod paskiem cytatu daje `placeNewPill`.
  private func buildNewPill() {
    let pill = readingChrome.newPill
    pill.translatesAutoresizingMaskIntoConstraints = false
    pill.addAction(UIAction { [weak self] _ in self?.jumpToNewLine() }, for: .primaryActionTriggered)
    pill.onDismiss = { [weak self] in self?.dismissNewLine() }
    view.addSubview(pill)
    let atTop = pill.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: Self.newPillGap)
    readingChrome.newPillAtTop = atTop
    NSLayoutConstraint.activate([
      atTop,
      pill.centerXAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerXAnchor),
      pill.leadingAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
    ])
  }

  /// Pod paskiem cytatu, gdy ten stoi (nie zasłania go), inaczej pod górą safe area — pasek chowa się przy dnie i przy
  /// samej górze. Woła je zmiana widoczności paska cytatu (`+PromptBar`).
  func placeNewPill() {
    guard let atTop = readingChrome.newPillAtTop else { return }
    let bar = turnChrome.promptBar.flatMap { $0.isHidden ? nil : $0 }
    if let bar, readingChrome.newPillUnderBar == nil {
      readingChrome.newPillUnderBar = readingChrome.newPill.topAnchor.constraint(
        equalTo: bar.bottomAnchor, constant: Self.newPillGap)
    }
    let under = readingChrome.newPillUnderBar
    if bar != nil {
      atTop.isActive = false
      under?.isActive = true
    } else {
      under?.isActive = false
      atTop.isActive = true
    }
  }

  /// Ocena na następnym obrocie pętli, raz na obrót: wołają ją przewinięcie, render i zmiana wysokości treści (ta —
  /// w środku układu listy), a przypięty transkrypt staje na dnie dopiero PO renderze (`settleAtBottom`). Oceniona
  /// w pół drogi pigułka mignęłaby: linia chwilę na ekranie, zaraz potem nad nim.
  func scheduleNewPill() {
    guard !readingChrome.newPillPending else { return }
    readingChrome.newPillPending = true
    Task { @MainActor [weak self] in
      guard let self else { return }
      self.readingChrome.newPillPending = false
      self.updateNewPill()
    }
  }

  /// Pigułka stoi, gdy linia „NOWE" leży nad ekranem, a człowiek do niej nie doszedł (`NewMarkerDecision.pill`:
  /// gaśnie tylko linia na ekranie pod gestem albo tap). Lista w drodze (przypięta, a jeszcze nie na dnie: skok „na
  /// dół", zaległe zejście; niedokończony powrót na miejsce; bez okna i wymiarów) niczego nie rozstrzyga — pigułka
  /// zostaje, jaka była. Przed zamrożeniem decyzji pigułka czeka na ciszę i wtedy ocenia się jeszcze raz.
  func updateNewPill() {
    let pill = readingChrome.newPill
    guard store.state.transcriptPhase(for: sessionId) == .content else { return pill.setShown(false) }
    guard isViewLoaded, collectionView.window != nil, collectionView.bounds.height > 0, readingChrome.restore == nil,
      !(pinned && distanceFromBottom() > Self.pinThreshold)
    else { return }
    // Tylko ruch listy pod gestem od ostatniej oceny; samo trwanie gestu czy dotyk bez ruchu linii nie odczytują.
    let gesture = readingChrome.movedByGesture
    readingChrome.movedByGesture = false
    switch ui.reading.newMarker.pill(newLinePlace(), gesture: gesture) {
    case .hidden:
      pill.setShown(false)
    case let .shown(count):
      pill.setCount(count)
      pill.setShown(true)
    case let .wait(seconds):
      pill.setShown(false)
      readingChrome.newPillQuiet?.cancel()
      readingChrome.newPillQuiet = Task { @MainActor [weak self] in
        try? await Task.sleep(for: .seconds(seconds + 0.02))
        guard let self, !Task.isCancelled else { return }
        self.updateNewPill()
      }
    }
  }

  /// Linia względem tego, co widać: od dołu paska cytatu (gdy stoi) albo pasków systemu do wstawki dna listy.
  private func newLinePlace() -> NewLinePlace? {
    guard let index = dataSource.indexPath(for: TranscriptRow.newMarker().id),
      let frame = collectionView.layoutAttributesForItem(at: index)?.frame
    else { return nil }
    let list = collectionView!
    var top = list.contentOffset.y + list.adjustedContentInset.top
    if let bar = turnChrome.promptBar, !bar.isHidden { top = max(top, list.convert(bar.bounds, from: bar).maxY) }
    let bottom = list.contentOffset.y + list.bounds.height - list.adjustedContentInset.bottom
    return NewLinePlace.of(
      lineMinY: Double(frame.minY), lineMaxY: Double(frame.maxY), top: Double(top), bottom: Double(bottom))
  }

  /// „×” na pigułce: pigułka i linia „NOWE” znikają do końca wizyty, „doczytane” idzie do pamięci od razu (bez
  /// czekania na wyjście z ekranu), a wynik oznaczony ręcznie jako nieprzeczytany — jako przeczytany. Lista
  /// stoi: linia leży nad ekranem, więc odpięty transkrypt trzyma pierwszy widoczny wiersz (jak przy powrocie z tła).
  func dismissNewLine() {
    readingChrome.newPill.setShown(false, animated: false)
    if ui.reading.newMarker.seq != nil, !pinned { holdTopRow() }
    ui.reading.newMarker.dismiss()
    rememberLastSeen()
    if store.state.readToggle(sessionId) == .markRead { store.setResultRead(sessionId, read: true) }
    scheduleRender()
  }

  /// Tap: animowane przewinięcie, linia staje u góry ekranu pod paskiem cytatu, który poza dnem się pokaże;
  /// transkrypt odpięty, pasek „na dół" jak przy każdym odjechaniu od dna. Pigułka gaśnie od razu, bez krycia
  /// (informacją zwrotną jest ruch listy), i w tej wizycie nie wraca.
  func jumpToNewLine() {
    readingChrome.newPill.setShown(false, animated: false)
    ui.reading.newMarker.reachLine()
    guard let index = dataSource.indexPath(for: TranscriptRow.newMarker().id) else { return }
    pinned = false
    takeOverFromGesture()
    // Skok „na dół” w toku przestaje się liczyć: od teraz lista jedzie do linii.
    readingChrome.jumpAnimating = false
    readingChrome.jumpDeadline?.cancel()
    readingChrome.jumpDeadline = nil
    let target = lineTarget(index)
    let list = collectionView!
    let animated = !UIAccessibility.isReduceMotionEnabled && abs(list.contentOffset.y - target) > 0.5
    readingChrome.lineJumping = animated
    readingChrome.lineJumpDeadline?.cancel()
    if animated {
      readingChrome.lineJumpDeadline = Task { @MainActor [weak self] in
        try? await Task.sleep(for: .seconds(1))
        guard let self, !Task.isCancelled else { return }
        self.finishLineJump()
      }
    }
    list.setContentOffset(CGPoint(x: list.contentOffset.x, y: target), animated: animated)
    updateJumpBar()
    if !animated { landOnLine() }
  }

  /// Gest odbiera listę skokowi do linii: koniec animacji i zapas czasu już jej nie ruszą.
  func cancelLineJump() {
    readingChrome.lineJumping = false
    readingChrome.lineJumpDeadline?.cancel()
    readingChrome.lineJumpDeadline = nil
  }

  /// Skok z kodu przejmuje listę w trakcie wytracania: ruch od teraz nie jest gestem, choć lista mogła nie zgłosić
  /// końca wytracania.
  func takeOverFromGesture() {
    readingChrome.gesture = false
    readingChrome.movedByGesture = false
  }

  /// Gdzie stanąć, żeby linia była pod paskiem cytatu: lista układa się przy linii (komórki poza ekranem mają
  /// wysokość szacunkową, a od wiersza nad linią zależy jej położenie), mierzy i wraca na wiersz, który czytelnik ma
  /// teraz u góry ekranu — w tej samej klatce, więc bez widocznego skoku. Animacja jedzie potem do zmierzonego miejsca.
  private func lineTarget(_ index: IndexPath) -> CGFloat {
    let list = collectionView!
    list.layoutIfNeeded()
    let held = topRowOnScreen()
    list.scrollToItem(at: index, at: .top, animated: false)
    for _ in 0..<Self.holdTurns {
      list.layoutIfNeeded()
      guard let frame = list.layoutAttributesForItem(at: index)?.frame else { break }
      let before = list.contentOffset.y
      setClampedOffset(lineOffset(lineMinY: frame.minY))
      // Na miejscu albo dociśnięte do krawędzi treści.
      if abs(list.contentOffset.y - before) <= 0.5 { break }
    }
    let target = list.contentOffset.y
    if let held, let row = dataSource.indexPath(for: held.rowId) {
      list.layoutIfNeeded()
      if let frame = list.layoutAttributesForItem(at: row)?.frame { setClampedOffset(frame.minY - held.screenY) }
      list.layoutIfNeeded()
    }
    return target
  }

  /// Przesunięcie listy, przy którym linia stoi pod paskiem cytatu (`NewLineJump.offset`); paska nie będzie bez
  /// promptów w transkrypcie.
  private func lineOffset(lineMinY: CGFloat) -> CGFloat {
    let prompts = !PromptBar.entries(store.state.transcripts[sessionId]?.messages ?? []).isEmpty
    let bar = prompts ? Double(turnChrome.promptBar?.bounds.height ?? 44) : nil
    return CGFloat(NewLineJump.offset(
      lineMinY: Double(lineMinY), insetTop: Double(collectionView.adjustedContentInset.top), bar: bar))
  }

  /// Pierwszy wiersz u góry ekranu (poza samą linią) i położenie jego góry na ekranie.
  private func topRowOnScreen() -> (rowId: String, screenY: CGFloat)? {
    let top = collectionView.contentOffset.y + collectionView.adjustedContentInset.top
    for index in collectionView.indexPathsForVisibleItems.sorted() {
      guard let rowId = dataSource.itemIdentifier(for: index), rowId != TranscriptRow.newMarker().id,
        let frame = collectionView.layoutAttributesForItem(at: index)?.frame, frame.maxY > top
      else { continue }
      return (rowId, frame.minY - collectionView.contentOffset.y)
    }
    return nil
  }

  /// Koniec animowanego skoku do linii (zgłoszony przez listę albo po zapasie czasu — animacja okna poza ekranem,
  /// apki w tle, nie zgłasza końca i bywa, że w ogóle nie rusza). Gest i skok „na dół" w trakcie go odwołują,
  /// a przypięcie w międzyczasie (wysłanie promptu) wygrywa: lista zostaje na dnie.
  func finishLineJump() {
    guard readingChrome.lineJumping else { return }
    cancelLineJump()
    guard !pinned, !collectionView.isUserScrolling else { return }
    landOnLine()
  }

  /// Linia u celu: dociągnięcie (komórki, które wjechały w trakcie, dostały prawdziwe wysokości), zapis miejsca
  /// czytania i fokus czytnika na pierwszej nowej wiadomości — pierwszy wiersz treści za linią, nie znacznik godziny
  /// po przerwie, który stoi między nimi.
  private func landOnLine() {
    guard let index = dataSource.indexPath(for: TranscriptRow.newMarker().id) else { return }
    collectionView.layoutIfNeeded()
    if let frame = collectionView.layoutAttributesForItem(at: index)?.frame {
      setClampedOffset(lineOffset(lineMinY: frame.minY))
    }
    rememberPosition()
    updateJumpBar()
    renderPromptBar(nil)
    let first = NewLineJump.focusRow(dataSource.snapshot().itemIdentifiers).flatMap { dataSource.indexPath(for: $0) }
    let cell = first.flatMap { collectionView.cellForItem(at: $0) } ?? collectionView.cellForItem(at: index)
    UIAccessibility.post(notification: .layoutChanged, argument: cell)
  }
}
#endif
