import Foundation
import RarogContract
import RarogCore

// Pigułki sterowania sesją: model i effort z arkuszem i tryb w rzędzie
// pod polem wiadomości, nowszy Claude Code w linii statusu. Reguły nazw modeli
// z `formatModelLabel`/`modelAlias` w `shared/src/protocol.ts` — czyste funkcje, testowane na macOS.
// Właściciel: nagłówek.

/// Nazwa modelu do UI i alias rodziny.
public enum ModelLabel {
  /// `claude-fable-5-1` → „Fable 5.1", `claude-opus-5[1m]` → „Opus 5 (1M)" (wariant okna to część
  /// identyfikatora — zjedzenie go dawałoby dwa modele pod jedną nazwą). Najpierw etykieta z listy
  /// serwera; nieznany kształt wraca bez zmian.
  public static func format(_ model: String, choices: [ModelChoice]) -> String {
    if let known = choices.first(where: { $0.value == model }) { return known.label }
    guard let match = model.wholeMatch(of: /claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?(?:\[([a-z0-9]+)\])?/) else {
      return model
    }
    let family = String(match.output.1)
    let name = family.prefix(1).uppercased() + family.dropFirst()
    let version = match.output.3.map { "\(match.output.2).\($0)" } ?? String(match.output.2)
    let window = match.output.4.map { " (\($0.uppercased()))" } ?? ""
    return "\(name) \(version)\(window)"
  }

  /// Alias z listy, pod który podpada rozwiązany identyfikator (`claude-opus-5[1m]` → `opus[1m]`),
  /// albo identyfikator bez zmian. Wariant okna jest częścią dopasowania: `claude-opus-5` NIE
  /// zwija się do `opus[1m]` (inne okno). Silnik raportuje pełny identyfikator, lista ma aliasy —
  /// bez tego arkusz stawiałby „Opus 5" obok „Opus" jako dwa modele.
  public static func alias(_ model: String, choices: [ModelChoice]) -> String {
    if choices.contains(where: { $0.value == model }) { return model }
    guard let match = model.wholeMatch(of: /claude-([a-z]+)-\d[^\[]*(\[[a-z0-9]+\])?/) else { return model }
    let alias = String(match.output.1) + (match.output.2.map(String.init) ?? "")
    return choices.contains(where: { $0.value == alias }) ? alias : model
  }
}

/// The newer-CLI slot of the status line (``StatusPills/cli(_:restarting:)``).
public enum CliSlot: Sendable, Equatable {
  case offer(CliUpdate)
  case restarting
}

/// Pigułki linii statusu: „N w tle" i „↑ <wydanie>" (model i tryb stoją w rzędzie pod polem).
public enum StatusPills {
  /// Jest co pokazać — inaczej linia statusu bez gita i kontekstu nie stoi wcale. Codex nie ma
  /// restartu, więc nowszy CLI go nie dotyczy. Przy widocznym prawym panelu „w tle" stoi w panelu, więc
  /// pigułki nie ma (`backgroundInPanel`) — ta sama flaga idzie do ``StatusLine``.
  /// `restarting`: a restart of this session is in progress (`AppState.restartInProgress`) — its spinner holds the line.
  public static func visible(_ session: SessionSummary, backgroundInPanel: Bool = false, restarting: Bool = false)
    -> Bool
  {
    background(session, inPanel: backgroundInPanel) || cli(session, restarting: restarting) != nil
  }

  /// What the newer-CLI slot shows: the `↑ <release>` offer, or a lone spinner from the confirmed tap until the restart
  /// ends. The spinner stands also while the card carries no `cliUpdate` (the old process gone, the new one starting),
  /// and the offer comes back only when the restart failed. The same sessions as ``cliUpdate(_:)``.
  public static func cli(_ session: SessionSummary, restarting: Bool) -> CliSlot? {
    guard restartable(session) else { return nil }
    if restarting { return .restarting }
    return session.cliUpdate.map(CliSlot.offer)
  }

  /// Pigułka „↑ <wydanie>" (restart na nowszym Claude Code). Nie ma jej Codex ani agent stojący
  /// w terminalu Raroga: restart z Raroga założyłby mu nowy panel poza terminalem,
  /// a tam, gdzie człowiek sam uruchomił `claude`, sam go też uruchamia ponownie.
  public static func cliUpdate(_ session: SessionSummary) -> CliUpdate? {
    restartable(session) ? session.cliUpdate : nil
  }

  private static func restartable(_ session: SessionSummary) -> Bool {
    session.engine != .codex && session.termId == nil
  }

  /// Pigułka „N w tle": są zadania, a prawy panel ich nie pokazuje. „Są zadania" mówi reguła rdzenia
  /// (`BackgroundTaskRules.hasTasks`): liczy się wszystko, co stoi na liście, także subagent w postoju
  /// — ma być widoczny razem z tym, na co czeka. Znak pracy na pigułce to osobna reguła
  /// (``BackgroundBadge``).
  public static func background(_ session: SessionSummary, inPanel: Bool) -> Bool {
    !inPanel && BackgroundTaskRules.hasTasks(session.backgroundTasks)
  }
}

/// Ultracode: ustawienie sesji Claude Code, osobne od poziomu effortu. W pigułce i w podsumowaniu startu
/// stoi słowo CLI bez tłumaczenia, jak poziomy effortu (`xhigh`); etykiety kontrolek mówi katalog copy.
public enum Ultracode {
  public static let name = "ultracode"
}

/// Pigułka modelu: `Opus 5.5 · xhigh`, sam model bez effortu albo wygaszone `model?`; `· ultracode` na końcu, gdy
/// serwer ma dowód, że sesja go ma.
public struct ModelPillModel: Sendable, Equatable {
  public let text: String
  public let spoken: String
  /// Nie wiemy, na czym sesja chodzi — wygaszone, bez zgadywania.
  public let unknown: Bool
  /// A model change is on its way: the pill shows the target set with a spinner.
  public var switching = false

  /// Pigułki modelu i trybu stoją w rzędzie pod polem przy każdej znanej sesji poza Codexem: u niego Rarog widzi
  /// sam stan, modelu i trybu nie ma czym ruszyć. Ta sama reguła rozstrzyga komendę apki `/model`.
  public static func shows(_ session: SessionSummary) -> Bool {
    session.engine != .codex
  }

  /// UI test switch of a Debug build: with `RAROG_UI_TEST_HIDE_MODEL=1` the model pill stays out of the row under the
  /// message field (screenshot scenes whose demo sessions name no model); the mode pill stays. A
  /// Release build always shows the pill.
  public static let hideForUITestsKey = "RAROG_UI_TEST_HIDE_MODEL"

  public static func hiddenForUITests(environment: [String: String]) -> Bool {
    #if DEBUG
    environment[hideForUITestsKey] == "1"
    #else
    false
    #endif
  }

  /// `target`: the sent body of the model change in flight (`AppState.modelChangeTarget`). Its values stand over the
  /// session's until the list shows them all, so model and effort change on the pill together.
  public static func make(_ session: SessionSummary?, choices: [ModelChoice], target: SessionModelBody? = nil)
    -> ModelPillModel
  {
    guard let target else { return settled(session, choices: choices) }
    var shown = session
    if let model = target.model { shown?.model = model }
    if let effort = target.effort { shown?.effort = effort }
    if let ultracode = target.ultracode { shown?.ultracode = ultracode }
    let pill = settled(shown, choices: choices)
    return ModelPillModel(
      text: pill.text, spoken: UICopy.modelSwitchingSpoken(pill.spoken), unknown: pill.unknown, switching: true)
  }

  private static func settled(_ session: SessionSummary?, choices: [ModelChoice]) -> ModelPillModel {
    guard let model = session?.model, !model.isEmpty else {
      return ModelPillModel(text: UICopy.modelUnknown, spoken: UICopy.modelUnknownSpoken, unknown: true)
    }
    let label = ModelLabel.format(model, choices: choices)
    // Ultracode tylko przy `true`: `false` i brak pola to dla pigułki to samo (bez dopisku), bo karta bez dowodu
    // pola nie ma, a „off” na pigułce byłoby zgadywaniem (ustawienia Claude Code mogą je włączyć bez Raroga).
    let ultracode = session?.ultracode == true
    // Bez effortu sam model („auto” nic nie mówi); effort spoza
    // tej wersji apki przemilczany — sam model dalej jest prawdą.
    guard let effort = session?.effort, effort != .unsupported else {
      return ultracode
        ? ModelPillModel(
          text: "\(label) · \(Ultracode.name)", spoken: UICopy.modelUltracodeSpoken(label), unknown: false)
        : ModelPillModel(text: label, spoken: UICopy.modelSpoken(label), unknown: false)
    }
    return ultracode
      ? ModelPillModel(
        text: "\(label) · \(effort.rawValue) · \(Ultracode.name)",
        spoken: UICopy.modelEffortUltracodeSpoken(label, effort: effort.rawValue), unknown: false)
      : ModelPillModel(
        text: "\(label) · \(effort.rawValue)", spoken: UICopy.modelEffortSpoken(label, effort: effort.rawValue),
        unknown: false)
  }
}

/// Model, effort and ultracode in the "Model and Effort" sheet (the session state, the drawn choice, the difference
/// to send): a tap on a chip or segment only chooses, Apply sends the DIFFERENCE.
public struct ModelSelection: Sendable, Equatable {
  /// Alias of the current model (the model chips are aliases); `nil` = unknown.
  public var model: String?
  /// `nil` = the level is unknown — no effort chip is selected (there is no "auto" chip).
  public var effort: EffortLevel?
  /// Ultracode; `nil` = unknown (no proof on the card) or the chosen model lacks it — no Ultracode segment is
  /// selected. In the difference: `nil` = no change.
  public var ultracode: Bool?

  public init(model: String?, effort: EffortLevel?, ultracode: Bool? = nil) {
    self.model = model
    self.effort = effort
    self.ultracode = ultracode
  }

  /// Stan sesji jako punkt odniesienia arkusza — po zwinięciu do aliasu z listy; nieznany effort
  /// (wartownik) to „nie wiem", nie poziom.
  public static func current(_ session: SessionSummary?, choices: [ModelChoice]) -> ModelSelection {
    ModelSelection(
      model: session?.model.flatMap { $0.isEmpty ? nil : ModelLabel.alias($0, choices: choices) },
      effort: session?.effort == .unsupported ? nil : session?.effort,
      ultracode: session?.ultracode)
  }
}

public enum ModelSheetModel {
  /// Pozycje modeli. „Model domyślny konta" (`value: ""`) należy do formularza nowej sesji — tu
  /// nie ma postaci komendy. Model sesji spoza listy (po zwinięciu do aliasu) stoi na początku,
  /// inaczej arkusz otwierałby się z zaznaczonym CUDZYM modelem; dostaje pełną skalę effortu
  /// (serwer i tak obniża to, czego model nie wspiera), a ultracode tylko wtedy, gdy serwer ogłosił je przy
  /// którejś pozycji listy: serwer bez tej możliwości zdjąłby pole z żądania i przyjął je bez skutku.
  public static func options(current model: String?, choices: [ModelChoice]) -> [ModelChoice] {
    let list = choices.filter { !$0.value.isEmpty }
    guard let model, !model.isEmpty, !list.contains(where: { $0.value == ModelLabel.alias(model, choices: list) }) else {
      return list
    }
    let all = EffortLevel.allCases.filter { $0 != .unsupported }
    let foreign = ModelChoice(
      value: model, label: ModelLabel.format(model, choices: choices), effortLevels: all,
      ultracode: choices.contains { $0.ultracode })
    return [foreign] + list
  }

  /// Effort levels of the chosen model; an empty list = a sentence stands in place of the Effort chips.
  public static func efforts(for model: String?, options: [ModelChoice]) -> [EffortLevel] {
    options.first { $0.value == model }?.effortLevels ?? []
  }

  /// The server can switch ultracode for this model (`ModelChoice.ultracode`); `false` = the Ultracode row is
  /// hidden.
  public static func ultracodeAvailable(for model: String?, options: [ModelChoice]) -> Bool {
    options.first { $0.value == model }?.ultracode ?? false
  }

  /// Co „Zatwierdź" ma wysłać — RÓŻNICA wobec sesji, i to wyłącznie w polach, których człowiek
  /// dotknął (każde pole to osobna komenda w panelu, a niezmieniony model zapisałby ustawienia
  /// konta bez żadnej zmiany). Poziom, którego wybrany model nie zna, nie leci; ultracode przy modelu bez tej
  /// możliwości też nie (także po odświeżeniu listy bez pola). `nil` = nie ma czego wysyłać i przycisk jest
  /// wygaszony.
  public static func patch(current: ModelSelection, draft: ModelDraft, options: [ModelChoice]) -> ModelSelection? {
    let selected = draft.selection(current: current, options: options)
    let model = draft.model.flatMap { $0.isEmpty || $0 == current.model ? nil : $0 }
    let effort = draft.effort.flatMap { $0 == current.effort || $0 != selected.effort ? nil : $0 }
    let ultracode = draft.ultracode.flatMap { $0 == current.ultracode || $0 != selected.ultracode ? nil : $0 }
    return model == nil && effort == nil && ultracode == nil
      ? nil : ModelSelection(model: model, effort: effort, ultracode: ultracode)
  }

  /// Zdanie czytnika przy „Zatwierdź”, zależne od paczki jak `warning` serwera: paczka z modelem albo effortem
  /// mówi o skutku globalnym `/model`, paczka z samym ultracode — o koszcie tury.
  public static func applyHint(_ patch: ModelSelection?) -> String {
    guard let patch, patch.model == nil, patch.effort == nil, patch.ultracode != nil else {
      return UICopy.modelChangeWarning
    }
    return UICopy.ultracodeHint
  }
}

/// Wybór człowieka w arkuszu — TYLKO pola, których dotknął. Pole nieruszone nadąża za sesją
/// (strumień listy, także zmiana z innego urządzenia), więc „Zatwierdź" nie odsyła starej
/// wartości, której nikt nie wybierał (inaczej wybór samego effortu cofałby
/// model przestawiony w międzyczasie na Macu i nadpisywał domyślny model konta).
public struct ModelDraft: Sendable, Equatable {
  /// Model wybrany tapnięciem; `nil` = nieruszony.
  public private(set) var model: String?
  /// Poziom wybrany tapnięciem; `nil` = nieruszony.
  public private(set) var effort: EffortLevel?
  /// Ultracode wybrane tapnięciem; `nil` = nieruszone.
  public private(set) var ultracode: Bool?

  public init() {}

  /// Co rysuje arkusz: wybór na tle bieżącego stanu sesji. Poziom, którego wybrany model nie zna,
  /// nie jest zaznaczony; ultracode przy modelu bez tej możliwości też nie.
  public func selection(current: ModelSelection, options: [ModelChoice]) -> ModelSelection {
    let model = self.model ?? current.model
    let levels = ModelSheetModel.efforts(for: model, options: options)
    let ultracode =
      ModelSheetModel.ultracodeAvailable(for: model, options: options) ? self.ultracode ?? current.ultracode : nil
    return ModelSelection(
      model: model, effort: (effort ?? current.effort).flatMap { levels.contains($0) ? $0 : nil }, ultracode: ultracode)
  }

  /// Choosing a model: a chosen level the new model does not know stops being chosen; the ultracode choice goes
  /// with the row when the new model lacks it.
  public mutating func pick(model: String, options: [ModelChoice]) {
    self.model = model
    if let effort, !ModelSheetModel.efforts(for: model, options: options).contains(effort) { self.effort = nil }
    if !ModelSheetModel.ultracodeAvailable(for: model, options: options) { ultracode = nil }
  }

  /// Wybór poziomu.
  public mutating func pick(effort: EffortLevel) {
    self.effort = effort
  }

  /// A tap on Yes or No in the Ultracode row.
  public mutating func pick(ultracode: Bool) {
    self.ultracode = ultracode
  }
}

/// Pigułka trybu: tekst, ton, zdanie i cel tapnięcia.
public struct ModePillModel: Sendable, Equatable {
  public enum Tone: Sendable, Equatable {
    /// Szarość jak każda pigułka (manual).
    case neutral
    /// Bursztyn: panel nie pyta o zgody (auto).
    case wait
    /// Czerwień: panel nie pyta o nic (bypass).
    case err
    /// Błękit: potwierdzenie wejścia w plan.
    case plan
    /// Wyciszone: nie wiemy.
    case muted
  }

  public let text: String
  public let tone: Tone
  public let spoken: String
  /// Cel tapnięcia; `nil` = tap tylko mówi, dlaczego nic się nie stanie.
  public let target: ModeCycleTarget?
  public let busy: Bool
  /// Dlaczego przełączenie teraz nie wyjdzie (sesja przed świeżym stanem): tap i podpowiedź czytnika
  /// mówią to zdanie, pigułka jest wyciszona, ale klikalna.
  public let blockedReason: String?

  /// `nil` = tryb nieodczytany wcale (pole nieobecne) — pigułki nie ma. `stale` = sesja przed świeżym
  /// stanem (`AppState.sessionStale`).
  public static func make(_ session: SessionSummary?, busy: Bool, stale: Bool = false) -> ModePillModel? {
    guard let mode = session?.herdrMode else { return nil }
    let tone: Tone =
      switch mode {
      case _ where stale: .muted
      case .bypass: .err
      case .auto: .wait
      case .plan: .plan
      case .manual: .neutral
      case .unknown: .muted
      }
    let target = ModeCycleTarget.toggle(from: mode)
    return ModePillModel(
      text: UICopy.modeText(mode), tone: tone,
      spoken: UICopy.modePillSpoken(mode, target: stale ? nil : target, busy: busy), target: target, busy: busy,
      blockedReason: stale ? UICopy.staleAction : nil)
  }
}

extension AppState {
  /// Dlaczego zmiana modelu teraz nie wyjdzie: przeszkoda rdzenia albo sesja przed świeżym
  /// stanem, której rdzeń odmówiłby w bramce. Pigułka zostaje klikalna, a arkusz mówi to zdanie.
  /// A change in flight stops a new one too: the core answers `.inFlight` until the list shows the target.
  func modelChangeReason(for sessionId: String, now: Date = Date()) -> String? {
    modelSheetReason(for: sessionId, ownRequest: false, now: now)
  }

  /// What the open sheet says instead of its form. The in-flight entry starts before the POST, so the sheet that sent
  /// Apply (`ownRequest`) keeps its form with the sending spinner until the reply; a stale state and a block still
  /// win. A sheet opened while another change is in flight gets the in-flight sentence.
  func modelSheetReason(for sessionId: String, ownRequest: Bool, now: Date = Date()) -> String? {
    if sessionStale(sessionId) { return UICopy.staleAction }
    if !ownRequest, modelChangeInFlight(sessionId, now: now) { return UICopy.modelChanging }
    return modelChangeBlock(for: sessionId).map(UICopy.modelBlock)
  }
}
