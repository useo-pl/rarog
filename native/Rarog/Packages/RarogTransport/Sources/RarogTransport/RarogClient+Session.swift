import Foundation
import RarogContract

// Sterowanie żywą sesją z nagłówka i diff sesji. Każda mutacja
// idzie przez `perform`, czyli przez `MutationGate` (zgodność i bramka sesji `unsupported`, bo
// ścieżki to `/api/sessions/<id>/…`); odczyty (`models`, `commands`, `diff`, `diff/files`, `diff/file`)
// przechodzą bez bramki.
// Właściciel: nagłówek.
extension RarogClient {
  /// Limit restartu: klient czeka DŁUŻEJ niż najgorszy czas serwera przed `/exit` (trzy
  /// odczyty gniazda po 5 s, `claude agents --json` 3 s, samo `/exit` 5 s).
  public static let restartTimeout: Duration = .seconds(20)

  /// `GET /api/models` — lista wbudowana serwera (pierwsza pozycja: model domyślny konta).
  public func models() async throws(TransportError) -> ModelList {
    let response = try await perform(.get("/api/models"))
    return try decodeCatalog(ModelList.self, from: response.body, path: "/api/models")
  }

  /// `GET /api/sessions/<id>/commands` — slash-komendy, które serwer przepuści w tej sesji:
  /// ta sama migawka katalogu co strażnik wysyłki, `revision` do porównań. Serwer sprzed tej trasy odpowiada 405
  /// (`method-not-allowed`), a nieznana sesja 404: oba dają ``CommandList/unavailable`` bez błędu — apka wtedy nic
  /// nie podpowiada. 401 idzie zwykłą ścieżką utraty logowania (`.unauthorized`, odmowa klucza w zatrzasku), 400
  /// (panel poza zasięgiem, Codex) przychodzi jako `.http` ze zdaniem serwera.
  public func commands(sessionId: String) async throws(TransportError) -> CommandList {
    let path = "/api/sessions/\(Self.segment(sessionId))/commands"
    let response = try await perform(.get(path), accepting: Self.commandsUnavailableStatuses)
    if Self.commandsUnavailableStatuses.contains(response.status) { return .unavailable }
    return try decodeCatalog(CommandList.self, from: response.body, path: path)
  }

  /// 404 (nie ma sesji) i 405 (serwer sprzed trasy listy komend) — lista pusta, nie błąd.
  static let commandsUnavailableStatuses: Set<Int> = [404, 405]

  /// `POST /api/sessions/<id>/model` → 202 z ostrzeżeniem o skutku globalnym. 409 (tura, dialog),
  /// 400 (`model-unknown`, panel bez komend) i 429 przychodzą jako błąd ze zdaniem serwera.
  public func setSessionModel(sessionId: String, _ body: SessionModelBody) async throws(TransportError)
    -> SessionModelAccepted
  {
    let path = "/api/sessions/\(Self.segment(sessionId))/model"
    let response = try await perform(.post(path, json: body))
    return try decodeCatalog(SessionModelAccepted.self, from: response.body, path: path)
  }

  /// `POST /api/sessions/<id>/mode` → 202 `{ok: true}`. Nowy tryb przychodzi strumieniem listy
  /// po odczycie stopki panelu, nie w tej odpowiedzi.
  public func setSessionMode(sessionId: String, _ body: SessionModeBody) async throws(TransportError) {
    let path = "/api/sessions/\(Self.segment(sessionId))/mode"
    let response = try await perform(.post(path, json: body))
    _ = try decodeCatalog(OkAck.self, from: response.body, path: path)
  }

  /// `POST /api/sessions/<id>/restart` → 202 `{sessionId}` po wysłaniu `/exit`. Każda
  /// odmowa (tura, karta, praca w tle, pole promptu na Macu) przychodzi wcześniej, zdaniem serwera.
  ///
  /// `resend`: „Uruchom ponownie i wyślij” pod notką blokady — całe `SessionSummary.promptBlocked` karty.
  /// Blokada nieaktualna (inny `seq` albo `id`) wraca 409 „Ten prompt już nie czeka na ponowne wysłanie.”
  /// Bez `resend` ciało to `{}`.
  public func restartSession(
    sessionId: String, resend: SessionPromptBlocked? = nil
  ) async throws(TransportError) -> RestartResponse {
    let path = "/api/sessions/\(Self.segment(sessionId))/restart"
    let body = RestartBody(resend: resend)
    let response = try await perform(.post(path, json: body, timeout: Self.restartTimeout))
    return try decodeCatalog(RestartResponse.self, from: response.body, path: path)
  }

  /// `GET /api/sessions/<id>/diff` — `git diff HEAD` katalogu sesji z listą plików (do 512 kB
  /// patcha). Codex: 400 ze zdaniem serwera.
  public func sessionDiff(sessionId: String) async throws(TransportError) -> SessionDiff {
    let path = "/api/sessions/\(Self.segment(sessionId))/diff"
    let response = try await perform(.get(path))
    return try decodeCatalog(SessionDiff.self, from: response.body, path: path)
  }

  /// `GET /api/sessions/<id>/diff/files` — lista zmienionych plików katalogu sesji (do 500 wpisów),
  /// bez patcha. Serwer sprzed tej trasy odpowiada 405 `method-not-allowed`; Codex i sesja poza zasięgiem: 400.
  public func sessionDiffFiles(sessionId: String) async throws(TransportError) -> DiffFileList {
    let path = "/api/sessions/\(Self.segment(sessionId))/diff/files"
    let response = try await perform(.get(path))
    return try decodeCatalog(DiffFileList.self, from: response.body, path: path)
  }

  /// `GET /api/sessions/<id>/diff/file?path=…` — patch JEDNEGO pliku (do 512 kB). Odmowy z kodem:
  /// 400 `bad-path`, 404 `diff-file-not-found` (lista zmian się zmieniła), 404 `session-not-found`,
  /// 503 `git-failed` (spróbuj ponownie).
  public func sessionDiffFile(sessionId: String, path: String) async throws(TransportError) -> DiffFilePatch {
    let response = try await perform(.get(Self.diffFileRoute(sessionId: sessionId, path: path)))
    // Ścieżka pliku nie wchodzi do opisu błędu: ten trafia do logu diagnostycznego.
    return try decodeCatalog(
      DiffFilePatch.self, from: response.body, path: "/api/sessions/\(Self.segment(sessionId))/diff/file")
  }

  /// Adres trasy patcha pliku. Ścieżka w query jest kodowana RĘCZNIE, zamkniętym zbiorem znaków (`segment`:
  /// poza literami, cyframi i `-._~` wszystko procentowo, także `/`). `URLComponents` zostawiłby `+`, a serwer
  /// czyta plus w query jako spację: plik `a+b.ts` wróciłby jako „nie ma go na liście zmian".
  static func diffFileRoute(sessionId: String, path: String) -> String {
    "/api/sessions/\(segment(sessionId))/diff/file?path=\(segment(path))"
  }
}
