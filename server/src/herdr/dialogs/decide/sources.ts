/**
 * Które źródło opisuje dialog na ekranie, gdy jest ich kilka: wpis jsonl, zrzut hooka
 * `PermissionRequest` albo oba. Rozstrzyga ekran; tu stoją też podwójny dowód komendy `Bash`
 * i tożsamość oceny (`decideReqId`, `evaluationReqId`), po której fasada drivera poznaje nową ocenę.
 */
import type { PendingHookTool } from '../hook/dump.ts';
import { HOOK_PERMISSION_REQUEST_EVENT } from '../hook/contract.ts';
import type { PendingTool } from '../../jsonl-pending.ts';
import { parseOptions } from '../screen/parse.ts';
import { queuedTitleToolOnScreen } from '../screen/queue.ts';
import type { ExpectedDecision } from '../screen/resolve.ts';
import { ASK_USER_QUESTION_TOOL, parseAskUserQuestionInput } from '../../../drivers/tool-summary.ts';
import { BASH_TOOL, bashCommand, commandMatches } from '../screen/operation.ts';
import type { ScreenOperation } from '../screen/operation.ts';
import {
  EDIT_TOOL, HOOK_AFTER_JSONL_SLACK_MS, competingHook, editContradictsScreen, hookMatchesPending, hookMatchesScreen,
  hookPendingFrom, jsonlYoungerThanHook, olderBashHook, planAddedByCli, screenConfirmsInput,
} from '../cross-check.ts';
import type { ActiveReq } from '../cards/build.ts';
import type { DecideInput, DecideResolver } from './input.ts';

/**
 * Czy komendę `Bash` potwierdzają DWA źródła naraz: wpis jsonl i zrzut `PermissionRequest`
 * mają dosłownie tę samą komendę, a zrzut powstał nie wcześniej niż wpis. Tylko wtedy zgoda bez
 * nazwy na ekranie (nagłówek nad krawędzią panelu) może dostać przyciski — patrz
 * `clippedHeaderProven` w `herdr/dialogs/screen/`.
 */
export function bashDoubleProof(pending: PendingTool | null, hookRaw: PendingHookTool | null): boolean {
  if (pending === null || hookRaw === null || hookRaw.hookEventName !== HOOK_PERMISSION_REQUEST_EVENT) return false;
  const fromJsonl = bashCommand(pending.toolName, pending.input);
  const fromHook = bashCommand(hookRaw.toolName, hookRaw.toolInput);
  const jsonlAt = Date.parse(pending.at);
  return fromJsonl !== null && fromJsonl === fromHook && Number.isFinite(jsonlAt)
    && hookRaw.at + HOOK_AFTER_JSONL_SLACK_MS >= jsonlAt;
}

/** Narzędzie zapisu pliku: jego karta wymaga dowodu pliku i treści z ekranu (`ExpectedDecision.fileCall`). */
const WRITE_TOOL = 'Write';

/**
 * Oczekiwanie dla cross-checku ekranu ze źródła karty: nazwa, komenda `Bash` (kontrola treści
 * operacji), wywołanie `Write` albo `Edit` z katalogiem do dowodu pliku i treści i etykiety payloadu
 * `AskUserQuestion` (prowadzą odtworzenie etykiet
 * zawiniętych przez wąski panel; niczego nie rozstrzygają, opcja i cyfra dalej z ekranu).
 */
export function expectedFor(input: DecideInput, source: PendingTool): ExpectedDecision {
  const payload = source.toolName === ASK_USER_QUESTION_TOOL
    ? parseAskUserQuestionInput(source.input)
    : null;
  const command = bashCommand(source.toolName, source.input);
  const fileChange = source.toolName === WRITE_TOOL ? 'write' : source.toolName === EDIT_TOOL ? 'edit' : null;
  return {
    toolName: source.toolName,
    ...(command === null ? {} : { command }),
    // The call directory: the hook dump's, else the `cwd` field of the transcript entry (it follows a Bash `cd`, while
    // the pane stays on the start directory), else the session directory from the driver.
    ...(fileChange === null
      ? {}
      : {
        fileCall: { change: fileChange, input: source.input, cwd: source.cwd ?? source.entryCwd ?? input.cwd ?? null },
      }),
    ...(command !== null && bashDoubleProof(input.pending, input.hookRaw) ? { doubleProof: true } : {}),
    ...(payload === null
      ? {}
      : {
        labels: payload.flatMap((question) => question.options.map((option) => ({
          label: option.label, description: option.description,
        }))),
      }),
  };
}

/**
 * Czekające narzędzie ze zrzutu hooka — w kształcie `PendingTool`, żeby budowa karty
 * i cross-check ekranu obsłużyły je TĄ SAMĄ ścieżką co wpis z jsonl. `id` z chwili zapisu
 * zrzutu jest stabilne między przebiegami oceny (dialog stoi = plik się nie zmienia), więc
 * karta nie migocze. Jedna reguła dla drivera i dla każdego, kto składa wejście `decideCard`
 * z tych samych plików.
 *
 * Przy obecnym wpisie z jsonl zrzut wchodzi dla `AskUserQuestion` wyłącznie po kontroli
 * zgodności (`hookMatchesPending`): od CLI 2.1.267 `tool_use` formularza pytania stoi
 * w pliku nad stojącym dialogiem, więc obecność wpisu nie znaczy „po decyzji" i nie ma prawa
 * gasić kanału odpowiedzi.
 *
 * Dla każdego innego narzędzia zrzut wchodzi jako KONKURENT wpisu jsonl, gdy opisuje
 * INNE i nie starsze wywołanie (`competingHook`): o tym, które źródło opisuje dialog,
 * rozstrzyga ekran w `decideCard`. Bez tego stęchły wpis (wynik `Read` przeskoczony przez
 * follower) zasłaniałby świeży `Bash` przez całą turę.
 * Konkuruje też zrzut `Bash` STARSZY niż wpis (`olderBashHook`): zgoda
 * subagenta nie ma wpisu w pliku głównym, a agent główny potrafi w tym czasie puścić własne narzędzie.
 * Wygrywa wyłącznie przy całej ramce operacji równej jego komendzie (`settleCompeting`).
 */
export function hookPendingFor(pending: PendingTool | null, raw: PendingHookTool | null): PendingTool | null {
  const hook = hookPendingFrom(raw);
  if (hook === null || pending === null) return hook;
  return hookMatchesPending(pending, raw) || competingHook(pending, raw) || olderBashHook(pending, raw)
    ? hook
    : null;
}

/**
 * Czy wpis jsonl i zrzut hooka KONKURUJĄ o kartę: oba są, a zrzut nie jest formularzem
 * pytania (tam zgodność obu źródeł sprawdza `hookMatchesPending`, a driver podaje zrzut tylko
 * przy zgodności). Driver podaje taki zrzut, gdy opisuje INNE wywołanie niż wpis jsonl.
 */
export function competingSources(pending: PendingTool | null, hookPending: PendingTool | null): boolean {
  return pending !== null && hookPending !== null && hookPending.toolName !== ASK_USER_QUESTION_TOOL;
}

/**
 * Które źródło opisuje dialog na ekranie, gdy wpis jsonl i zrzut hooka mówią o RÓŻNYCH wywołaniach
 * (np. wpis `Read`, którego wyniku follower nie zobaczył, obok świeżego zrzutu `Bash`: bez rozstrzygnięcia
 * każda zgoda tej tury kończyłaby się kartą bez przycisków).
 *
 * Rozstrzyga EKRAN, w stałej kolejności: najpierw wpis jsonl, potem zrzut —
 * i ten musi zgadzać się z ekranem także TREŚCIĄ (`hookMatchesScreen`). Żadne nie pasuje → zostaje
 * wpis jsonl, czyli rozjazd i karta bez przycisków. Władzy to nie poszerza: zrzut
 * bez wpisu jsonl przechodzi tę samą drogę.
 *
 * Zrzut `Bash` STARSZY niż wpis (`olderBashHook`) ma węższą
 * drogę: wygrywa wyłącznie wtedy, gdy wpis do ekranu nie pasuje, a ekran sam dowodzi zrzutu
 * ({@link bashFrameProven}). Pasuje wpis — zostaje wpis (bez karty „pasują oba":
 * przy całej ramce oba pasują tylko z tą samą komendą). `older` mówi wołającemu, że tożsamość karty
 * ma iść z jednego źródła.
 *
 * Wpis i zrzut TEGO SAMEGO narzędzia innego niż `Bash`: wpis wygrywa wyłącznie
 * wtedy, gdy ekran potwierdza także jego treść tą samą kontrolą co zrzut (`hookMatchesScreen`). Inaczej
 * wynik jest jak przy „pasują oba" — sama nazwa narzędzia nie odróżnia dwóch wywołań `Edit`.
 *
 * Wyjątek od „pasują oba”: zrzut `ExitPlanMode`, który jest wpisem z planem dołożonym
 * przez CLI ({@link planAddedByCli}), wygrywa, gdy ekran pokazuje nazwę jego pliku planu.
 */
export function settleCompeting(input: DecideInput, pending: PendingTool, hook: PendingTool): {
  pending: PendingTool | null; hookPending: PendingTool | null; ambiguous: boolean; older: boolean;
} {
  const text = input.text;
  const older = olderBashHook(pending, input.hookRaw);
  if (text === null) return { pending, hookPending: null, ambiguous: false, older };
  /*
   * Wpis konkuruje z dowodem nazwy i komendy, bez dowodu pliku `Write`/`Edit` (`fileCall`): reguły niżej („pasują
   * oba”, sprzeczność ścieżki) rozstrzygają, które źródło opisuje dialog. Dowodu pliku wymaga dopiero karta
   * z wybranego wpisu (`resolveScreen` w `decide.ts`), więc wpis bez niego zostaje bez przycisków.
   */
  const { fileCall: _fileCall, ...byName } = expectedFor(input, pending);
  const pendingFits = input.resolve(text, byName).status === 'ok';
  if (older) {
    return !pendingFits && bashFrameProven(hook, text, input.resolve)
      ? { pending: null, hookPending: hook, ambiguous: false, older }
      : { pending, hookPending: null, ambiguous: false, older };
  }
  const hookFits = input.resolve(text, expectedFor(input, hook)).status === 'ok' && hookMatchesScreen(hook, text);
  /*
   * Wpis `Edit`, któremu ekran PRZECZY: `resolveOptions` sprawdza samą nazwę, więc
   * stęchły wpis edycji innego pliku „pasował” obok zrzutu potwierdzonego ścieżką i diffem, a reguła „pasują oba”
   * odbierała przyciski właściwej karcie. Wykluczamy go wyłącznie sprzecznością ścieżki (`editContradictsScreen`;
   * diff jej nie dowodzi), bez `cwd`: wpis jsonl go nie niesie, a `cwd` zrzutu to katalog INNEGO wywołania. Wpis,
   * któremu ekran nie przeczy, zostaje „pasującym”, więc przy pasującym zrzucie wychodzi „pasują oba”. Reszta reguł
   * bierze `pendingFits`.
   */
  const pendingPlausible = pendingFits && !editContradictsScreen(pending, text);
  /*
   * Plan dołożony przez CLI: wpis `ExitPlanMode` z `{}` i zrzut z `plan`
   * i `planFilePath` to jedno wywołanie, nie dwa. Wpis pasuje do ekranu samą nazwą narzędzia, więc bez tej
   * reguły wyszłoby „pasują oba” i karta planu bez przycisków. Zrzut wygrywa wyłącznie wtedy, gdy ekran
   * pokazuje nazwę jego pliku planu (`hookFits`); bez niej zostaje karta bez przycisków niżej.
   */
  if (hookFits && planAddedByCli(pending, hook)) return { pending: null, hookPending: hook, ambiguous: false, older };
  // Ekran pasuje do OBU różnych wywołań — nie wiadomo, które zatwierdza cyfra. Kolejność
  // „najpierw jsonl" nie jest tu dowodem; karta bez przycisków.
  if (pendingPlausible && hookFits) return { pending, hookPending: null, ambiguous: true, older };
  if (!pendingPlausible && hookFits) return { pending: null, hookPending: hook, ambiguous: false, older };
  /*
   * To samo narzędzie inne niż `Bash`, a ekran nie potwierdza TREŚCI wpisu. Dialog `Edit` pokazuje zwykle
   * samą nazwę pliku, więc nie widać ani ścieżki wpisu, ani ścieżki zrzutu. Gdyby wpis wygrywał tu samą
   * nazwą narzędzia, karta szłaby z przyciskami i treścią pliku A, a cyfra zatwierdzałaby dialog pliku B.
   * Dlatego to karta bez przycisków, jak przy „pasują oba".
   * `Bash` zostaje bez zmian: treść jego operacji sprawdza już cross-check (ramka). Potwierdzenie
   * musi być POZYTYWNE (`screenConfirmsInput`): wpis bez pola do porównania, np. narzędzie MCP z pustym
   * wejściem, niczego nie dowodzi.
   */
  const sameToolUnconfirmed = pending.toolName === hook.toolName && pending.toolName !== BASH_TOOL
    && !screenConfirmsInput(pending, text);
  if (pendingFits && sameToolUnconfirmed) return { pending, hookPending: null, ambiguous: true, older };
  return { pending, hookPending: null, ambiguous: false, older };
}

/**
 * Czy ekran SAM dowodzi zrzutu `Bash` — JEDNA reguła dla dwóch dróg: zrzutu starszego niż wpis jsonl
 * ({@link settleCompeting}) i zrzutu starszego niż 10 minut ({@link admittedHook}). Warunki: dialog zgody z TYTUŁEM
 * bloku `Bash` (`identity.kind === 'title'`), cała ramka operacji pod widocznym nagłówkiem
 * (`complete && headerVisible`) i ramka równa CAŁEJ komendzie zrzutu. Ekran pokazuje wtedy dokładnie to, co zatwierdzi
 * cyfra: zrzut innej komendy nie pasuje, a karta niesie komendę z ramki. Ramka ucięta u góry (sam koniec komendy) nie
 * wystarcza — dwie komendy potrafią mieć wspólny koniec, a podwójnego dowodu z pliku głównego tu nie ma (zrzut starszy
 * od wpisu nigdy go nie daje, `bashDoubleProof`).
 *
 * Tytuł z licznikiem kolejki („… agent    2 of 2”) nie trafia w mapę tytułów, więc blok ma
 * tożsamość z `Ask rule`. Taki blok liczy się jak tytuł `Bash` wyłącznie wtedy, gdy linia tytułu bez licznika
 * jest tytułem `Bash` (`queuedTitleToolOnScreen`), a `Ask rule` w strefie operacji też mówi `Bash`; bez licznika
 * tożsamość z samego `Ask rule` dalej nie wystarcza.
 */
export function bashFrameProven(hook: PendingTool, text: string, resolve: DecideResolver): boolean {
  const command = bashCommand(hook.toolName, hook.input);
  const frame = command === null ? null : wholeBashFrame(text);
  return command !== null && frame !== null && commandMatches(frame, command)
    && resolve(text, { toolName: BASH_TOOL, command }).status === 'ok';
}

/**
 * Wpis jsonl obok karty ze zrzutu W CHWILI DECYZJI — materiał osłony po decyzji (`#noteDecided` w driverze).
 * Karta ze zrzutu `Bash` ma tożsamość samego zrzutu (`hook:<generacja>`), więc stoi bez przebudowy,
 * gdy wpis obok się zmienia (agent główny dostał wynik i puścił następne narzędzie). `pendingId` i `pendingYounger`
 * z chwili budowy karty byłyby wtedy stęchłe: kotwica osłony (`decidedShield`) nie zgadzałaby się z bieżącym wpisem,
 * osłona by spadła, a zamykany dialog dostałby kartę bez przycisków. Liczymy je więc z wpisu `pending` z migawki sprzed
 * klawisza, tą samą regułą co przy budowie (`olderBashHook`): wpis MŁODSZY od zrzutu `Bash`, który dał karcie treść
 * (`proofHookAt`), to żywe narzędzie agenta głównego. Karta z wpisu (`callId`) i karta z ekranu (bez `callPrint`)
 * zostają przy polach z budowy.
 */
export function besideAtDecision(
  card: ActiveReq, pending: PendingTool | null,
): { pendingId: string | null; pendingYounger: boolean } {
  if (card.callId !== undefined || card.callPrint === undefined) {
    return { pendingId: card.pendingId ?? null, pendingYounger: card.pendingYounger === true };
  }
  const hookAt = card.proofHookAt;
  return {
    pendingId: pending?.id ?? null,
    pendingYounger: card.command !== undefined && hookAt !== undefined && pending !== null
      && jsonlYoungerThanHook(pending, hookAt),
  };
}

/**
 * Cała ramka operacji dialogu zgody z tytułem `Bash` (warunek ekranu {@link bashFrameProven}): tytuł bloku `Bash`
 * albo tytuł `Bash` spod licznika kolejki, ramka pod widocznym nagłówkiem. `null` przy każdym innym ekranie.
 * Tę samą ramkę bierze dowód „dialog stoi” kanału zgód z wierzchu ekranu (`layer1/top.ts`).
 */
export function wholeBashFrame(text: string): ScreenOperation | null {
  const dialog = parseOptions(text);
  if (dialog === null || dialog.kind !== 'tool') return null;
  const { identity, operation } = dialog;
  const titled = identity.kind === 'title'
    ? identity.tool === BASH_TOOL
    : identity.kind === 'ask-rule' && identity.tool === BASH_TOOL && queuedTitleToolOnScreen(text) === BASH_TOOL;
  return titled && operation !== null && operation.complete && operation.headerVisible ? operation : null;
}

/**
 * Czy zrzut sesji opisuje INNY dialog niż ten, który Rarog właśnie rozstrzygnął cyfrą albo `escape` —
 * jedyny wyjątek od kasowania zrzutu po decyzji poza formularzem pytania. Zgoda subagenta
 * czeka w kolejce CLI za dialogiem wątku głównego, a hook odpala raz, gdy CLI postanawia zapytać: zrzut
 * skasowany po decyzji na dialogu z wierzchu zabrałby jej jedyne źródło treści, więc wyszłaby na wierzch bez
 * przycisków.
 *
 * Warunki, wszystkie naraz: zrzut `PermissionRequest` dla `Bash` (nie marker przycięcia), komenda źródła
 * rozstrzygniętej karty (`ActiveReq.command`) różna od komendy zrzutu, a ekran przeczytany świeżo tuż przed
 * klawiszem pokazuje całą ramkę `Bash` ({@link wholeBashFrame}) z komendą karty i bez komendy zrzutu. Ekran
 * dowodzi wtedy, co rozstrzygnął klawisz, a komenda karty, że to inne wywołanie niż zrzut. Brak którejkolwiek
 * przesłanki (karta bez źródła `Bash`, ramka ucięta, inne narzędzie, `PreToolUse`, brak odczytu) daje `false`,
 * czyli kasowanie. Inne narzędzia zostają przy kasowaniu celowo: kontrola ich treści na ekranie
 * to fragment ścieżki (`hookMatchesScreen`), więc zostawiony zrzut `Edit` tego samego pliku podstawiłby treść
 * poprzedniego wywołania.
 */
export function otherDialogDump(
  raw: PendingHookTool | null, resolvedText: string | null, resolvedCommand: string | null,
): boolean {
  if (raw === null || resolvedText === null || resolvedCommand === null) return false;
  if (raw.hookEventName !== HOOK_PERMISSION_REQUEST_EVENT) return false;
  const hook = hookPendingFrom(raw);
  const command = hook === null ? null : bashCommand(hook.toolName, hook.input);
  if (command === null || command === resolvedCommand) return false;
  const frame = wholeBashFrame(resolvedText);
  return frame !== null && commandMatches(frame, resolvedCommand) && !commandMatches(frame, command);
}

/**
 * Zrzut, który ocena może wziąć za źródło albo dowód karty. Zrzut w terminie
 * 10 minut wchodzi bez zmian. Zrzut `Bash` + `PermissionRequest` starszy (`stale`, czytnik w `hook/dump.ts`)
 * wchodzi wyłącznie wtedy, gdy ekran sam dowodzi jego komendy ({@link bashFrameProven}); inaczej `null`, czyli
 * ocena bez zrzutu. Jedno miejsce dla oceny (`decideCard`), świeżego odczytu przed cyfrą
 * i dziennika drivera.
 */
export function admittedHook(
  raw: PendingHookTool | null, text: string | null, resolve: DecideResolver,
): PendingHookTool | null {
  if (raw === null || raw.stale !== true) return raw;
  const hook = hookPendingFrom(raw);
  return hook !== null && text !== null && bashFrameProven(hook, text, resolve) ? raw : null;
}

/**
 * Czy ocena idzie dalej mimo tożsamości równej stojącej karcie: zrzut `stale` przeszedł
 * {@link admittedHook}, czyli ekran pokazuje całą ramkę jego komendy, a ta komenda nie jest komendą karty
 * (`ActiveReq.command`, brak pola = karta bez źródła `Bash`). Tak wygląda decyzja przy biurku na dialogu przed nim
 * w kolejce: blokada, wpis i zrzut stoją, więc tożsamość oceny zostaje, choć dialog karty zniknął z ekranu.
 * Zrzut w terminie 10 minut daje `false`: jego dowodu nikt przy tej bramce nie czyta, a ekranu do tożsamości oceny
 * nie dokładamy.
 */
export function staleDumpProvesOther(admitted: PendingHookTool | null, active: ActiveReq | null): boolean {
  if (admitted?.stale !== true || active === null) return false;
  const hook = hookPendingFrom(admitted);
  const command = hook === null ? null : bashCommand(hook.toolName, hook.input);
  return command !== null && command !== active.command;
}

/**
 * Baza identyfikatora karty: `tool_use.id`/id zrzutu, a dla dialogu z ekranu — numer blokady.
 *
 * Wołający podaje jako `source` zrzut hooka PRZED wpisem z jsonl, gdy oba opisują to samo
 * wywołanie: karta kanału hooka ma się liczyć z GENERACJI zrzutu (`hook:<at>`),
 * niezależnie od tego, czy wpis `tool_use` zdążył wejść do pliku. Inaczej ta sama karta
 * zmieniałaby tożsamość w chwili, w której CLI dopisuje wpis — a zmiana `qId` czyści w kliencie
 * tekst wpisany w pole „Własna odpowiedź".
 */
export function decideReqId(
  source: PendingTool | null, blockedSeq: number, competitor: PendingTool | null = null,
): string {
  if (source === null) return `screen:${blockedSeq}`;
  // Drugie źródło w tożsamości: `~` jest bezpieczne w ścieżce URL (`/permissions/:permId`).
  return competitor === null ? source.id : `${source.id}~${competitor.id}`;
}

/**
 * Tożsamość oceny w driverze — baza `reqId`, po której bramka „ta sama karta" kończy ocenę przed
 * odczytem ekranu. Trzy reguły, w tej kolejności:
 *
 * 1. konkurujące źródła — oba identyfikatory, żeby nowy wpis albo nowy zrzut dał nową ocenę.
 *    Wyjątek: zrzut `Bash` STARSZY niż wpis — sam wpis, jak bez zrzutu. Karta z wpisu
 *    zatrzymuje się wtedy na bramce „ta sama karta" (zrzut zgody zatwierdzonej przy biurku
 *    leży do 10 min, a bez tego każda następna karta `Bash` agenta głównego czytałaby ekran co obrót
 *    zegara). Karta ze zrzutu ma tożsamość `hook:<generacja>`, inną niż wpis, więc ocena nad nią i tak
 *    czyta ekran i kończy na hamulcu `KEEP`; nowy dialog zapisuje zrzut młodszy od wpisu (reguła 1),
 *    a skasowany zrzut zmienia tożsamość oceny na sam wpis, różną od karty ze zrzutu;
 * 2. `Bash` z podwójnym dowodem (wpis jsonl i zrzut z tą samą komendą) — także generacja zrzutu.
 *    Zrzut dochodzi zwykle ~0,1 s po wpisie; gdy pierwsza ocena trafi przed nim, zgoda z uciętym
 *    nagłówkiem dostaje kartę bez przycisków, a bez generacji w tożsamości dojście drugiego
 *    dowodu nie dałoby już nowej oceny;
 * 3. inaczej: zrzut przed wpisem (formularz pytania), a bez źródeł numer blokady.
 */
export function evaluationReqId(
  pending: PendingTool | null, hookPending: PendingTool | null,
  hookRaw: PendingHookTool | null, blockedSeq: number,
): string {
  if (competingSources(pending, hookPending)) {
    if (pending !== null && olderBashHook(pending, hookRaw)) return decideReqId(pending, blockedSeq);
    return decideReqId(hookPending, blockedSeq, pending);
  }
  if (pending !== null && hookPending === null && bashDoubleProof(pending, hookRaw)) {
    return decideReqId(pending, blockedSeq, hookPendingFrom(hookRaw));
  }
  return decideReqId(hookPending ?? pending, blockedSeq);
}
