import Foundation
import RarogContract
import RarogCore

// Modele kart dialogu w panelu i karty stanu — czyste
// funkcje stanu rdzenia, testowane na macOS. Kartę zgody składa `TranscriptRows+Tail`.
// Właściciel: karty.

/// Sufit bloku treści na karcie decyzji w liniach. Komenda: 10, szeroko 16.
/// Treść do PRZECZYTANIA przed decyzją — plan na karcie zgody i podgląd opcji pytania — dostaje wyższy
/// sufit: 20, szeroko 32. Zawsze z przewijaniem w bloku i wierszem „⌄ widzisz N z M linii", gdy sufit
/// faktycznie ucina; linia rośnie z pismem, więc sufit też.
public enum CardBlockCeiling {
  public static func lines(readable: Bool, regular: Bool) -> Int {
    switch (readable, regular) {
    case (true, true): 32
    case (true, false): 20
    case (false, true): 16
    case (false, false): 10
    }
  }
}

/// Faza karty dialogu na tym urządzeniu: żądanie w drodze zastępuje stopkę wierszem
/// stanu; po odpowiedzi stopka wraca, a pod nią zostaje zdanie wyniku (karta znika, gdy sesja ruszy).
public enum DialogCardPhase: Sendable, Equatable {
  case idle
  case sending(PermissionDecision)
}

/// Lokalny stan karty dialogu (`TranscriptUIState.dialog`). Dotyczy JEDNEGO czekania sesji
/// (`identity`): nowy dialog po ruszeniu sesji zaczyna od czystej karty. Uzbrojenie wiąże się
/// węziej — z dialogiem, który karta pokazywała przy pierwszym tapnięciu (`armedFor`): serwer
/// podmienia dialog pod tym samym czekaniem, a każdy dialog wymaga własnych dwóch tapnięć.
public struct DialogCardUI: Sendable, Equatable {
  public var identity: String
  public var phase: DialogCardPhase = .idle
  /// Zdanie wyniku pod stopką („Wysłałem Esc…", zdanie serwera po odmowie).
  public var status: String?
  public var statusIsError = false
  /// Pierwszy tap w zatwierdzenie rozpoznanego dialogu uzbraja je do tej chwili …
  public private(set) var armedUntil: Date?
  /// …i tylko dla tego dialogu.
  public private(set) var armedFor: HerdrDialogSignature?

  public init(identity: String) {
    self.identity = identity
  }

  public mutating func arm(_ signature: HerdrDialogSignature, until: Date) {
    armedFor = signature
    armedUntil = until
  }

  public mutating func disarm() {
    armedFor = nil
    armedUntil = nil
  }

  public func isArmed(for signature: HerdrDialogSignature, now: Date) -> Bool {
    armedFor == signature && (armedUntil.map { $0 > now } ?? false)
  }
}

/// Karta „dialog w terminalu" — rozpoznany (zaufanie katalogu, zmiana modelu) albo nie.
public struct HerdrDialogCardModel: Sendable, Equatable {
  public let sessionId: String
  /// Tożsamość czekania (sesja + początek stanu) — klucz lokalnego stanu karty.
  public let identity: String
  /// Który dialog karta pokazuje (rodzaj i treść) — adres uzbrojenia i zatwierdzenia.
  public let signature: HerdrDialogSignature
  public let eyebrow: String
  public let text: String
  /// „Co widać w terminalu" — wycinek ekranu od serwera; `nil` = bloku nie ma.
  public let screen: String?
  /// Od kiedy sesja czeka (zegar karty).
  public let since: Date?
  /// Dosłowna etykieta zatwierdzenia rozpoznanego dialogu; `nil` = przycisk NIE ISTNIEJE (fail-closed).
  public let allowLabel: String?
  /// Pierwszy tap już padł — przycisk pyta „Na pewno?".
  public let allowArmed: Bool
  public let denyLabel: String
  /// Kanał do panelu martwy: „Odrzuć" gaśnie.
  public let channelDead: Bool
  public let phase: DialogCardPhase
  public let status: String?
  public let statusIsError: Bool
  /// Karta bez decyzji (sesja nieobsługiwana, apka niezgodna) — jak na karcie zgody.
  public let lockedReason: String?

  /// Nagłówek dla czytnika: rodzaj i powód.
  public var spokenHeader: String { "\(eyebrow). \(text)" }
}

public enum HerdrDialogCards {
  /// Karta dialogu tej sesji albo `nil`, gdy jej nie ma (sesja nie czeka albo stoi karta z treścią).
  public static func make(
    state: AppState, sessionId: String, ui: DialogCardUI?, locked: String?, now: Date = Date()
  ) -> HerdrDialogCardModel? {
    guard state.herdrDialogShown(for: sessionId, now: now), let session = state.sessions[sessionId] else { return nil }
    let identity = identity(session)
    let signature = HerdrDialogSignature(session)
    let local = ui?.identity == identity ? ui : nil
    let copy = UICopy.herdrDialog(
      session.herdrDialog, reason: session.herdrDialogReason, cliDialog: session.cliDialog)
    // Przycisk zatwierdzania: rozpoznany dialog i żywy kanał. Treść karty mówi o dialogu także
    // przy padniętym herdr — tylko bez obietnicy, że da się go stąd potwierdzić.
    let allowable = locked == nil && state.dialogAllowId(for: sessionId, now: now) != nil
    let dead = state.herdrChannelDead(for: sessionId)
    return HerdrDialogCardModel(
      sessionId: sessionId,
      identity: identity,
      signature: signature,
      eyebrow: copy.eyebrow,
      text: copy.text,
      screen: session.herdrDialogScreen.flatMap { $0.isEmpty ? nil : $0 },
      since: ServerTime.parse(session.stateSince),
      allowLabel: allowable ? copy.allowLabel : nil,
      allowArmed: allowable && (local?.isArmed(for: signature, now: now) ?? false),
      denyLabel: copy.denyLabel,
      channelDead: dead,
      phase: local?.phase ?? .idle,
      status: local?.status,
      statusIsError: local?.statusIsError ?? false,
      lockedReason: locked
    )
  }

  /// Jedno czekanie sesji = jedna karta: zmiana stanu (sesja ruszyła i stanęła znów) to nowy dialog.
  public static func identity(_ session: SessionSummary) -> String {
    "\(session.id)|\(session.stateSince)"
  }

  /// Lokalny stan karty po nowym stanie serwera: inne czekanie (albo brak karty) zaczyna od zera,
  /// a inny dialog pod tym samym czekaniem ROZBRAJA zatwierdzenie (wynik i faza zostają — należą do
  /// czekania; serwer gasi rozpoznanie zaraz po przyjęciu „Zatwierdź", zanim wróci odpowiedź).
  public static func settle(_ ui: DialogCardUI?, state: AppState, sessionId: String) -> DialogCardUI? {
    guard var ui, state.herdrDialogShown(for: sessionId), let session = state.sessions[sessionId],
      ui.identity == identity(session)
    else { return nil }
    if let armed = ui.armedFor, armed != HerdrDialogSignature(session) { ui.disarm() }
    return ui
  }
}

/// Karta stanu w miejscu pola wiadomości: mówi, co dalej, bez ślepego zaułka.
public struct StateCardModel: Sendable, Equatable {
  public enum Actions: Sendable, Equatable {
    /// Bez akcji: sesja nieobsługiwana, Codex, panel poza zasięgiem.
    case none
    /// Sesja bez panelu: „×" (dwa tapnięcia) i „Wznów".
    case resume
    /// Żywy panel (limit, przerwana, błąd): „Zamknij panel w herdr" (dwa tapnięcia).
    case livePanel
    /// Sesja zamknięta: „Usuń z listy" (dwa tapnięcia) i „Nowa sesja" w tym samym katalogu.
    case newSession(cwd: String)
  }

  /// Ton słowa rodzaju — kolor dubluje słowo, nigdy go nie zastępuje.
  public enum Tone: Sendable, Equatable { case failed, waiting, quiet }

  public let sessionId: String
  public let eyebrow: String
  public let text: String
  public let tone: Tone
  public let actions: Actions

  /// Klucz prezentacji: wynik akcji (zdanie pod kartą) należy do karty, z której wyszła akcja.
  public var key: String { "\(sessionId)|\(eyebrow)|\(text)" }
}

public enum StateCards {
  /// Karta stanu sesji albo `nil` = stoi pole wiadomości.
  public static func make(state: AppState, sessionId: String) -> StateCardModel? {
    // Lista z pamięci podręcznej: karta stanu niosłaby akcje na obrazie sprzed uśpienia — do
    // świeżego stanu stoi wygaszone pole z powodem (`ComposerModel`).
    guard let session = state.sessions[sessionId], !state.sessionStale(sessionId) else { return nil }
    let card = { (eyebrow: String, text: String, tone: StateCardModel.Tone, actions: StateCardModel.Actions) in
      StateCardModel(sessionId: sessionId, eyebrow: eyebrow, text: text, tone: tone, actions: actions)
    }
    // Wpis Codexa i panel spoza korzeni: Rarog widzi tylko stan — bez pola i bez akcji.
    if session.engine == .codex {
      return card(UICopy.stateEyebrowCodex, UICopy.sendBlock(.codex, session: session), .quiet, .none)
    }
    if session.isUnsupported {
      return card(UICopy.stateEyebrowUnsupported, UICopy.unsupportedSession, .quiet, .none)
    }
    if session.outOfScope == true {
      return card(UICopy.stateEyebrowOutOfScope, UICopy.sendBlock(.outOfScope, session: session), .quiet, .none)
    }
    let live = { (text: String) in "\(text) \(UICopy.herdrLiveCard)" }
    switch session.state {
    case .limitReached:
      return card(UICopy.stateEyebrowLimit, live(UICopy.limitLine(session.stateDetail, ref: session.stateDetailRef)), .failed, .livePanel)
    case .interrupted:
      return card(UICopy.stateEyebrowInterrupted, live(session.stateDetail ?? UICopy.stateInterrupted), .waiting, .livePanel)
    case .error:
      return card(UICopy.stateEyebrowError, live(session.stateDetail ?? UICopy.stateError), .failed, .livePanel)
    case .resumable:
      return card(UICopy.stateEyebrowInterrupted, session.stateDetail ?? UICopy.stateResumable, .waiting, .resume)
    case .done:
      return card(UICopy.stateEyebrowDone, session.lastSummary ?? UICopy.stateDone, .quiet, .newSession(cwd: session.cwd))
    case .starting, .running, .waitingInput, .waitingPermission, .waitingQuestion, .unsupported:
      return nil
    }
  }
}
