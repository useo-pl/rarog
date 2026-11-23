// Ciała POST sterowania żywą sesją — lustro `sessionModelBodySchema` i `sessionModeBodySchema`
// z `shared/src/protocol.ts`. Serwer waliduje je ściśle, więc pola bez wartości nie lecą wcale
// (synteza `Encodable` pomija `nil`). Właściciel: nagłówek.
// The seen body mirrors `seenBodySchema` in `shared/src/rest.ts`; golden bodies `shared/fixtures/requests/seen*.json`.

/// `POST /api/sessions/<id>/model` — RÓŻNICA wyboru wobec stanu sesji, model, effort i ultracode jednym
/// żądaniem. Co najmniej jedno pole; pusta różnica nie ma prawa wyjść (serwer: 400).
///
/// `effort: null` („wróć do domyślnego") istnieje w kontrakcie, ale apka go nie wysyła: arkusz
/// nie ma pozycji „auto", a brak odczytu poziomu to niewiedza, nie wybór. `ultracode`: `true` włącza,
/// `false` wyłącza — oba to zmiana, więc `false` też jedzie na drut.
public struct SessionModelBody: Sendable, Equatable, Encodable {
  public var model: String?
  public var effort: EffortLevel?
  public var ultracode: Bool?

  /// `nil`, gdy nie ma czego wysłać (wszystkie pola puste albo wartownik `unsupported` w effortcie).
  public init?(model: String?, effort: EffortLevel?, ultracode: Bool? = nil) {
    let effort = effort == .unsupported ? nil : effort
    guard model != nil || effort != nil || ultracode != nil else { return nil }
    self.model = model
    self.effort = effort
    self.ultracode = ultracode
  }
}

/// Cel przełączenia trybu uprawnień panelu (`MODE_CYCLE_TARGETS`). `bypass` jako cel nie
/// istnieje — Rarog nigdy nie zdejmuje pytań o zgodę.
public enum ModeCycleTarget: String, Sendable, Equatable, Encodable, CaseIterable {
  case plan
  case auto
}

/// `POST /api/sessions/<id>/mode`.
public struct SessionModeBody: Sendable, Equatable, Encodable {
  public var mode: ModeCycleTarget

  public init(mode: ModeCycleTarget) {
    self.mode = mode
  }
}

/// Puste ciało `{}` — trasy POST bez pól (przerwanie, „Pokaż w herdr”, obejrzane, klucz dyktowania).
public struct EmptyBody: Sendable, Equatable, Encodable {
  public init() {}
}

/// `POST /api/sessions/<id>/seen`, a mirror of `seenBodySchema` in `shared/src/rest.ts`. Without a pick-up the body is
/// `{}`, the same bytes as the ``EmptyBody`` a human's view sends. With a ``SeenPickUp`` the voice agent across
/// sessions picks up the result it read: the server marks it received with `seenBy` only while that result stands
/// (`waiting-input` with no decision card over it) at the `stateSince` and in the engine conversation the agent read,
/// and answers 409 `session.seen-result-changed` otherwise. The server takes `by`, `stateSince` and `conversation`
/// only all three together (a part is a 400), so they come in as one ``SeenPickUp`` and cannot be set one by one.
/// With the server's mode across sessions off, a pick-up is a 503.
public struct SeenBody: Sendable, Equatable, Encodable {
  public private(set) var by: SeenBy?
  public private(set) var stateSince: String?
  public private(set) var conversation: String?

  public init(pickUp: SeenPickUp? = nil) {
    by = pickUp?.by
    stateSince = pickUp?.stateSince
    conversation = pickUp?.conversation
  }
}

/// Who picks up a result, and the `stateSince` and the conversation token of the read it picks up (both from the
/// session catalogue row or the turns route): the three fields ``SeenBody`` puts on the wire, always all three.
public struct SeenPickUp: Sendable, Equatable {
  public var by: SeenBy
  public var stateSince: String
  public var conversation: String

  public init(by: SeenBy, stateSince: String, conversation: String) {
    self.by = by
    self.stateSince = stateSince
    self.conversation = conversation
  }
}

/// `POST /api/sessions/<id>/restart` — lustro `restartBodySchema` z `shared/src/rest.ts`. Bez `resend` ciało to `{}`:
/// restart na nowszym Claude Code (pigułka „↑”). Z `resend`: „Uruchom ponownie i wyślij” pod notką
/// blokady — CAŁE `SessionSummary.promptBlocked` karty (`seq` i `id`), bez tekstu promptu: ten trzyma serwer.
public struct RestartBody: Sendable, Equatable, Encodable {
  public var resend: SessionPromptBlocked?

  public init(resend: SessionPromptBlocked? = nil) {
    self.resend = resend
  }
}
