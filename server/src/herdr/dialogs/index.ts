/**
 * Obsługa dialogów Claude Code w panelu herdr — JEDNO miejsce reguł „co stoi na ekranie, jaka karta
 * i co wolno z niej zatwierdzić".
 *
 * Podział ról jest twardy: treść karty z jsonl albo zrzutu hooka, cyfry z ekranu, rozjazd =
 * karta bez przycisków zatwierdzania. Wszystko tutaj to funkcje nad JAWNYMI argumentami. Stan panelu
 * (aktywna karta, numer blokady, osłony, zegary) i automaty dialogowe (ocena, rezerwy, kanał hooka,
 * kontrola przed cyfrą) trzyma fasada `drivers/herdr-driver.ts` — tylko ona pisze do panelu.
 * Opis całości: `docs/dialogs.md`.
 *
 * ── Mapa modułów (strażnik: `server/test/herdr-dialogs-boundary.test.ts`)
 *
 * - `index.ts`          — ta mapa i publiczne API katalogu dla fasady drivera.
 * - `copy.ts`           — zdania dla człowieka: odmowy, notki do transkryptu, treść kart bez przycisków.
 * - `timing.ts`         — rytm automatów drivera: kanał hooka, ponowne oceny, osłony, rezerwy.
 * - `presence.ts`       — czy na ekranie stoi dialog albo formularz (rezerwy formularza i rejestru CLI).
 * - `cross-check.ts`    — uzgadnianie zrzutu hooka, ekranu i wpisu jsonl.
 * - `router.ts`         — rozdzielacz warstw: klasa z rejestru CLI, zrzut hooka, ekran → werdykt (tylko dziennik).
 * - `consent-gate.ts`   — the digit gate of consent channel mode: effective mode, blocked digit, consent card without
 *                        its allow button.
 * - `screen-unavailable.ts` — the reason of a consent card without `channel` and without the approve button.
 * - `no-hook.ts`        — consent without a hook: its cause, the `no hook` and `no approve button` log lines, and
 *                        whether the card of the `off` path has the approve button.
 * - `screen-fallback.ts` — the emergency approve button of a consent dialog without a hook: one rule over the facts,
 *                        the card mark, the key and refused key log lines.
 * - `policy/options.ts` — wybór opcji po treści etykiety: „ten jeden raz" i „zawsze" (`docs/dialogs.md`, „Rules: what must not be relaxed”).
 * - `policy/escalation.ts` — słownik eskalacji (`docs/dialogs.md`, „Rules: what must not be relaxed”): treść, etykieta opcji, przełącznik trybu.
 * - `policy/terminal.ts`   — dialogi tylko z terminala: lista, dopasowanie, sufit treści.
 * - `policy/consent.ts`    — dialogi zgody poza blokadą herdr: nigdy nie zatwierdzane.
 * - `policy/pause.ts`      — pauza „Session paused”: bez `escape` z drivera.
 * - `policy/exit-tasks.ts` — task lines of the exit dialog `background-work-exit` for the restart note.
 * - `policy/option-policy.ts` — polityka opcji z kanałem: `terminalOnly` karty i blokada cyfry (`optionPolicy`).
 * - `policy/measured-consent.ts` — consent dialogs measured for the "Yes" digit under the consent channel.
 * - `cards/build.ts`    — typy kart (`ActiveReq`, `DecisionCard`) i ich budowniczowie; wpis „karta bloku
 *                        wystawiona” do dziennika (`blockCardRecord`).
 * - `cards/ids.ts`      — identyfikatory kart z treści dialogu.
 * - `cards/roles.ts`    — rola opcji z ekranu: odpowiedź, własna odpowiedź, wyjście.
 * - `hook/contract.ts`  — kontrakt z `scripts/hooks/rarog-pending.mjs`: zdarzenia, narzędzie pytania, katalogi,
 *                        pola payloadu, tryb cienia (`alive.json`, `shadow/`, `shadow.jsonl`).
 * - `hook/canon.ts`     — kanoniczna postać `tool_input` i sha256 (bliźniak `scripts/hooks/canon.mjs`).
 * - `hook/target.ts`    — adres odpowiedzi w kanale hooka, notatki, zakładka na ekranie.
 * - `hook/answers.ts`   — kanał ODPOWIEDZI: Rarog pisze plik `answers/<klucz>`, hook go czyta.
 * - `hook/dump.ts`      — czytnik zrzutu hooka z `pending/` (hook pisze, Rarog czyta), TTL i sprzątanie.
 * - `hook/suggestions.ts` — `permission_suggestions` of the dump and the registration: schema check, cap, MCP marker.
 * - `shadow/atomic.ts`  — zapis atomowy plików kanału cienia (nazwa tymczasowa nigdy nie kończy się `.json`),
 *                        opcjonalnie z `fsync` przed `rename`.
 * - `shadow/alive.ts`   — `alive.json` dla hooka w trybie cienia: zapis co 10 s, `mode: "off"` przy zatrzymaniu.
 * - `shadow/alive-log.ts` — `alive.jsonl`, dziennik przejść `alive.json` (start, zmiana, stop) dla audytu cienia.
 * - `shadow/evidence.ts` — dowód „dialog stoi” (czysta funkcja, jawne wejścia), wybór zrzutu pod plik cienia,
 *                        sieroty do zwolnienia.
 * - `shadow/files.ts`   — pliki kanału cienia: odczyt zrzutów per wywołanie, plik cienia i jego odwołanie, rekordy
 *                        cyklu `decisions/`.
 * - `shadow/liveness.ts` — życie procesu hooka: pid i czas startu wobec `ps`, z sufitem czasu.
 * - `shadow/channel.ts` — kanał cienia drivera: plik cienia przed klawiszem, obserwacja odbioru, zwalnianie
 *                        sierot, odtworzenie po restarcie serwera.
 * - `shadow/sweep.ts`   — sprzątanie startu: rotacja `shadow.jsonl` i `alive.jsonl`, resztki `shadow/`, sieroty
 *                        `pending/<sesja>/`, retencja `decisions/`.
 * - `layer1/contract.ts` — kontrakt kanału zgód (warstwa 1): stany cyklu, powody karty bez przycisku zgody,
 *                        `reasonId` z tekstami, katalogi `consent/` i `consent-records/`, trasy gniazda rejestracji
 *                        i administracyjnego, prefiks podpisu, limity, wersja rekordu. Same stałe i typy.
 * - `layer1/sign.ts`    — podpis HMAC pliku odpowiedzi kanału zgód, jego weryfikacja i skrót karty `cardSha256`
 *                        (wspólne wektory: `server/test/fixtures/hook-kanon/podpis.json`).
 * - `layer1/always.ts`  — the "always" option of a channel card: the closed list of `permission_suggestions`,
 *                        how the card shows them and the digest the answer file signs.
 * - `layer1/registry.ts` — rejestr sekretów hooka w pamięci: przyjęcie rejestracji z gniazda `consent.sock`,
 *                        blokada klucza przy drugiej, innej rejestracji, limity, TTL, sekret do podpisu.
 * - `layer1/receipt.ts` — the hook's `POST /claim` receipt of an `allow`: body check, receipt signature with the
 *                        registration's secret, the rule which record takes it (the cycle writes it).
 * - `layer1/card.ts`    — karta kanału ze zrzutu: pełna prezentacja wejścia do sufitu hooka i werdykt przycisków
 *                        (`unavailable`, zgoda, odmowa i zwolnienie).
 * - `layer1/cards.ts`   — karty kanału w pamięci, poza kartami ekranowymi: widok dla urządzeń, zmiana albo „bez
 *                        zmian”, `deciding` na drucie jako `sent` bez przycisków.
 * - `layer1/frames.ts`  — ramki kontraktu karty kanału: `PermissionRequest` z `channel: 'hook'` (pełna prezentacja,
 *                        `fields`, `notes`), `permission-settled` w miejscu i `permission-resolved` w stanie końcowym.
 * - `layer1/records.ts` — rekordy cyklu `consent-records/<sesja>/<klucz>.json` (`v: 1`) i sprzątanie `consent/`
 *                        oraz `consent-records/` przy starcie.
 * - `layer1/bind.ts`    — wiązanie klucza hooka z `tool_use.id` z faktów całej tury: porównywalność, nakładanie
 *                        z kolejności linii, `bound`/`ambiguous-tool-use`/`incomparable-input`.
 * - `layer1/top.ts`     — dopasowanie zrzutu do wierzchu ekranu (`matchTop`: cała ramka `Bash`, plik planu, `Edit`
 *                        przy `single`), jedyny człon dowodu „dialog stoi” z tożsamością prośby.
 * - `layer1/proof.ts`   — dowód „dialog stoi” (dowód własny z reguł trybu cienia i jedyne dopasowanie wierzchu w puli
 *                        sesji), dialog karty `claimed` bez żywego hooka i skutek z wyniku związanego wywołania.
 * - `layer1/version-gate.ts` — the Claude Code version gate of the proof rule per request kind: the package
 *                        constant and the canary file `consent-canary.json` (read only, any doubt = the constant).
 * - `layer1/desk.ts`    — desk fallback of a subagent `pending` record: its clock, the holds while the registry says
 *                        `waiting: permission`, and the signed `release` (`desk-fallback`, `mcp-interaction`).
 * - `layer1/desk-reason.ts` — the closed list of reasons a subagent request went back to the desk without proof,
 *                        and the reason of one key from the last observation (the `(reason: …)` of the log line);
 *                        what a desk release kept for the card of the same call.
 * - `layer1/cycle.ts`   — maszyna stanów klucza: kolejka per klucz, protokół zapisu z `fsync`, odzyskiwanie po
 *                        restarcie, zwolnienie, wyłącznik, rozliczenie tury, pula zrzutów sesji, termin dowodu.
 * - `layer1/resume.ts`  — resumption of the records a server restart interrupted (restart grace G): the wait for
 *                        the hook's second registration and the allow-button hold of a resumed `pending` record, in
 *                        memory only; the transitions and the writes stay in `cycle.ts`.
 * - `layer1/screen-key.ts` — the digits of the emergency approve button the cycle remembers for a minute, the match
 *                        of a hook that registers after the key, and its `screen fallback late hook` line.
 * - `layer1/turns.ts`   — settlement of consent turns: which turns the transcript review still reads and what one
 *                        turn's facts do to its records (record writes stay in `cycle.ts`).
 * - `layer1/observe.ts` — obserwacja jednej sesji (zrzuty, pula, `ps`, sygnały z wierzchem ekranu, karty bez
 *                        zrzutu) dla serwera i procesu pomiaru kanału.
 * - `layer1/hook-list/hook-list.ts` — the session's `PermissionRequest` hooks, read-only, as evidence.
 * - `layer1/hook-list/session-facts.ts` — the session facts without a hook dump: process, `cwd`, call `cwd`, the hook
 *                        list verdict and the settings layers past `changed`, cached per process, `cwd` and episode.
 * - `layer1/mode.ts`    — tryb efektywny kanału zgód: `main` wyłącznie przy komplecie warunków (hook `ok`, oba
 *                        gniazda, próg buildu apki), inaczej `shadow` z powodem; `off` do rozstrzygnięcia po starcie
 *                        gniazd i po wyłączniku (do restartu); źródło trybu ze słuchaczem zmian.
 * - `decide/decide.ts`  — `decideCard`: czysta decyzja „jaka karta", bramki w stałej kolejności.
 * - `decide/input.ts`   — wejście i wyjście decyzji, osłona po własnej decyzji Raroga.
 * - `decide/sources.ts` — konkurencja wpisu jsonl i zrzutu hooka, podwójny dowód `Bash`, dowód całej ramki `Bash`
 *                        (zrzut starszy niż wpis albo niż 10 minut), tożsamość oceny, zrzut innego dialogu
 *                        po decyzji Raroga (`otherDialogDump`), wpis obok karty ze zrzutu w chwili decyzji,
 *                        zrzut `stale` innej komendy niż stojąca karta (`staleDumpProvesOther`).
 * - `decide/reasons.ts` — powód i kształt odmowy do dziennika.
 * - `send/keys.ts`      — allow-lista klawiszy do panelu (`escape`, `ctrl+c`, cyfry `1`…`9`).
 * - `send/form-submit.ts` — `enter` formularza z podglądem, wyłącznie po dowodzie ze świeżego ekranu.
 * - `send/trust-step.ts` — `down`, potem `enter` dialogu zaufania bez cyfr, po dowodzie ze świeżego ekranu.
 * - `send/prompt-submit.ts` — `enter` wiadomości wklejonej w trakcie tury, po dowodzie, że nic nie stanęło.
 * - `send/key-row.ts` — key row of a layer 2 card (arrows, Tab, Enter), one key per call.
 * - `send/take-back-keys.ts` — keys of the queue take-back (`up`, `down`, `ctrl+u`), one key per call.
 * - `refusals.ts`       — zrzut diagnostyczny odmowy (ekran i metadane, bez `tool_input`), retencja.
 * - `screen/signatures.ts` — rejestr sygnatur: jedyne miejsce wyglądu CLI.
 * - `screen/parse.ts`      — parser ekranu: `parseOptions` składa dialog (`ScreenDialog`) z modułów odczytu.
 * - `screen/text.ts`       — czyszczenie tekstu ekranu: ANSI, znaki sterujące, puste brzegi.
 * - `screen/snippet.ts`    — wycinek dialogu na kartę bez przycisków.
 * - `screen/excerpt.ts`    — blok dialogu na kartę bez przycisków przy ekranie bez opcji z cyframi.
 * - `screen/region.ts`     — granice dialogu: pozioma kreska, góra bloku (`blockTopOf`, jedyna definicja kreski
 *                           bloku), kandydaci na region opcji, nagłówek.
 * - `screen/options.ts`    — opcje dialogu: linia, ramka, etykieta, opis, kompletność 1…N.
 * - `screen/option-run.ts` — which numbered run is the option list: the run above the footer, not a body list.
 * - `screen/block.ts`      — blok dialogu: kreska i tytuł nad opcjami, nazwa narzędzia z bloku.
 * - `screen/block-visible.ts` — czy cały blok dialogu stoi w jednym odczycie (tylko do dziennika).
 * - `screen/plan-file.ts`  — nazwa pliku planu ze stopki dialogu `ExitPlanMode` (`ScreenDialog.planFile`).
 * - `screen/kinds.ts`      — rodzaj dialogu z markerów stopki, sygnatury dialogu planu.
 * - `screen/identity.ts`   — tożsamość dialogu i jej porównanie przed cyfrą.
 * - `screen/known.ts`      — znane dialogi (`KNOWN_DIALOGS`) rozpoznawane w bloku.
 * - `screen/form.ts`       — formularz pytania: stopka, tryb zatwierdzania, pasek zakładek, wielokrotny wybór.
 * - `screen/review.ts`     — ekran przeglądu odpowiedzi formularza i jego pary.
 * - `screen/confirm.ts`    — potwierdzenie ustawień CLI rozpoznane po kształcie (`confirmFrom`).
 * - `screen/resolve.ts`    — cross-check ekranu z jsonl i hookiem (`resolveOptions`).
 * - `screen/trust-arrow.ts` — dialog zaufania bez cyfr: pełny render, folder, `❯`, odcisk bloku.
 * - `screen/mode-footer.ts` — tryb uprawnień ze stopki ekranu (nie dialog: nadzorca, `mode-cycle.ts`).
 * - `screen/operation.ts`  — operacja dialogu zgody (ramka komendy).
 * - `screen/edit-frame.ts` — dowód wywołania `Edit` i `Write`: ścieżka z nagłówka i diff albo treść z ramki.
 * - `screen/auto-deny.ts`  — licznik automatycznej odmowy pod operacją.
 * - `screen/queue.ts`      — licznik kolejki dialogów zgody („k of N” w linii tytułu bloku) i tytuł spod licznika.
 * - `screen/bash-zone.ts`  — strefa pytania dialogu `Bash` z zamkniętej listy linii CLI (dowód wierzchu).
 * - `screen/edit-zone.ts`  — pytanie dialogu `Edit` o plik z nagłówka pod ramką diffu (dowód wierzchu).
 * - `screen/file-dialog.ts` — kind of an `Edit` or `Write` dialog whose key footer a narrow pane cut or wrapped.
 * - `screen/write-zone.ts` — pytanie dialogu `Write` pod ramką treści przy nagłówku nad krawędzią (nazwa tylko do
 *   wyświetlenia).
 * - `screen/dialog-bottom.ts` — dół odczytu: stopka dialogu zgody z zamkniętej listy (dowód wierzchu).
 * - `layer2/stability.ts`  — stabilność bloku warstwy 2: para odczytów z generacją w jednym zakresie, próby,
 *                           `unstable` (czysta maszyna, serwer jej nie woła).
 * - `layer2/read-block.ts` — blok dialogu warstwy 2 (`readBlock`): góra, tytuł, treść, surowe linie opcji, linie
 *                           pod opcjami, stopka i odcisk (czysta funkcja; serwer woła ją przez `layer2/card.ts`).
 *                           Also the raw rows under the block top (`rows`) and the footer wrapped to the bottom.
 * - `layer2/shapes.ts`     — rejestr kształtów warstwy 2 (`BLOCK_SHAPES`): zmierzone bloki z przyciskami, z wersją
 *                           CLI i datą pomiaru.
 * - `layer2/match.ts`      — dopasowanie bloku do kształtu (`shapeOf`): dowód końca bloku, pary cyfra–etykieta,
 *                           przyciski po polityce opcji (serwer go nie woła).
 * - `layer2/card.ts`       — karta bloku bez cyfr warstwy 2 (`blockNoDigitsExcerpt`): wycinek bloku z sufitem
 *                           warstwy 2, powód `block-no-digits` i odcisk do odświeżania (decyzja woła ją przy fladze).
 *                           Holds the closed list of layer 2 reasons `LAYER2_WHYS` in three groups, the gate of the
 *                           layer 2 card with buttons (`layer2Gate`: flag, engine, rule) and the episode verdict of
 *                           the audit (`episodeVerdictOf`, `LAYER2_EPISODE_VERDICTS`).
 * - `layer2/verdict.ts`    — layer 2 rule (`layer2Verdict`): buttons with whole literal labels from the block's raw
 *                           rows, or the reason for none (pure function; the server calls it through `layer2Gate`).
 *
 * ── Jak importować
 *
 * Fasada drivera bierze API stąd. Moduły katalogu importują się nawzajem wprost z pliku (przez
 * `index.ts` zamknęłyby cykl), testy też biorą funkcję z jej modułu.
 *
 * ── Kierunek zależności
 *
 * Katalog nie zna fasady drivera (`drivers/herdr-driver.ts`), managera (`sessions/manager.ts`)
 * ani nadzorcy (`herdr/supervisor.ts`) — to one wołają katalog, nigdy odwrotnie. Warstwa 1 (`layer1/`) nie zna
 * też transkryptu ani modułów drivera herdr (`drivers/herdr/`), a tryb cienia (`shadow/`) nie zna warstwy 1
 * (strażnik: `server/test/layer1-granica.test.ts`).
 */
export {
  FORM_SUBMIT_GONE_MESSAGE, MULTI_SELECT_MESSAGE, NOTE_NOT_ALLOWED_MESSAGE, NOTE_NO_CHANNEL_MESSAGE,
  NOTE_WRITE_FAILED_MESSAGE, NO_ANSWER_ON_SCREEN_MESSAGE, NO_DIGIT_MESSAGE, PAUSE_ESCAPE_MESSAGE,
  SCREEN_CHANGED_MESSAGE, STALE_DECISION_MESSAGE, TERMINAL_DIALOG_MESSAGE, TERMINAL_ONLY_MESSAGE,
  formSubmitAbortMessage, hookAnswerPartialMessage, noteNotDeliveredMessage,
} from './copy.ts';
export {
  ANSWERED_HOOK_SHIELD_MS, CLI_HOLD_MISSES, CLI_WAITING_PROBES, DECIDED_SHIELD_MS, FORM_FALLBACK_MISSES,
  FORM_FALLBACK_RETRY_DELAYS_MS, FORM_SUBMIT_CONFIRM_DELAY_MS, HOOK_ANSWER_POLL_MS, HOOK_ANSWER_WAIT_MS,
  SCREEN_ANSWER_REARM_DELAYS_MS, SHADOW_DEADLINE_MS,
} from './timing.ts';
export { askFormOnScreen, cliDialogOnScreen } from './presence.ts';
export {
  DIALOG_ROUTES, DIALOG_ROUTE_REASONS, routeAllowsDigit, routeDialog, routeHookOf, routeScreenOf,
} from './router.ts';
export { consentDigitOpenedBy, consentDigitRefused, consentModeNow, consentOnlyEvent } from './consent-gate.ts';
export type { ConsentGateSource } from './consent-gate.ts';
export { noApproveButtonLine, noHookCause, noHookLine, offPathApprove } from './no-hook.ts';
export type { NoHookCause, NoHookFacts, NoHookThread, StatuslineFreshness } from './no-hook.ts';
export {
  screenFallbackGuard, screenFallbackHolds, screenFallbackKeyLine, screenFallbackRefusedLine,
} from './screen-fallback.ts';
export type {
  ScreenFallbackFacts, ScreenFallbackGuard, ScreenFallbackKeyLine, ScreenFallbackMark,
} from './screen-fallback.ts';
export type { ConsentDeskRelease } from './layer1/desk-reason.ts';
export {
  applyMultiSelectOverride, competingHook, hookMatchesPending, hookPendingFrom, olderBashHook,
} from './cross-check.ts';
export { affirmativeOption, alwaysOption } from './policy/options.ts';
export { optionPolicy } from './policy/option-policy.ts';
export { measuredConsentHolds } from './policy/measured-consent.ts';
export {
  BLOCK_CARD_VERDICTS, SCREEN_DIALOG_TOOL, blockCardRecord, fallbackSnippet, screenDialogCard,
} from './cards/build.ts';
export { screenFormReqId } from './cards/ids.ts';
export { HOOK_PERMISSION_REQUEST_EVENT } from './hook/contract.ts';
export { hookAnnotations, screenAnswerIndex } from './hook/target.ts';
export { decideCard } from './decide/decide.ts';
export {
  admittedHook, besideAtDecision, evaluationReqId, hookPendingFor, otherDialogDump, staleDumpProvesOther,
} from './decide/sources.ts';
export { dialogShapeOf } from './decide/reasons.ts';
export { FORM_SUBMIT_KEY, confirmFormSubmit } from './send/form-submit.ts';
export { ASK_USER_QUESTION_TOOL, resolveOptions } from './screen/resolve.ts';
export { dialogThreadOnScreen, parseOptions, subagentDialogOnScreen } from './screen/parse.ts';
export { blockVisible } from './screen/block-visible.ts';
export { SANDBOX_NETWORK_TOOL } from './screen/kinds.ts';
export { matchKnownDialog } from './screen/known.ts';
export { sameDialogIdentity } from './screen/identity.ts';
export { SESSION_PAUSED_DIALOG, sessionPausedDialog } from './policy/pause.ts';
export { TERMINAL_DIALOG_IDS } from './policy/terminal.ts';
export { exitDialogTasks } from './policy/exit-tasks.ts';
export { standingConsentDialog } from './policy/consent.ts';
export { canonicalLabel } from './screen/options.ts';
export { SHADOW_RESULTS, shadowCardEligible } from './shadow/channel.ts';
export { registryEvidenceFromSignal } from './shadow/evidence.ts';
export { LAYER2_EPISODE_VERDICTS, LAYER2_WHYS } from './layer2/card.ts';
export type { ActiveReq, BlockCardVerdict, CardOrigin, DecisionCard } from './cards/build.ts';
export type { HookAnswerTarget } from './hook/target.ts';
export type { HookAnswerChannel } from './hook/answers.ts';
export type { PendingHookTool } from './hook/dump.ts';
export type { RefusalDump, RefusalDumper } from './refusals.ts';
export type { DecideAction, DecideInput, DecidedShield, DegradeDiagnosis } from './decide/input.ts';
export type { DecisionResolution, ExpectedDecision } from './screen/resolve.ts';
export type { ScreenDialog } from './screen/parse.ts';
export type { DialogIdentityStamp } from './screen/identity.ts';
export type { KnownDialogId } from './screen/known.ts';
export type { ScreenConsentDialogId } from './policy/consent.ts';
export type { TerminalDialogId } from './policy/terminal.ts';
export type { ScreenOption } from './screen/options.ts';
export type { DialogRoute, DialogRouteReason, RouteHook, RouteInput, RouteScreen, RouteVerdict } from './router.ts';
export type { ShadowConsentChannel, ShadowOutcome, ShadowResult } from './shadow/channel.ts';
export type { Layer2EpisodeVerdict, Layer2Mark, Layer2Why } from './layer2/card.ts';
