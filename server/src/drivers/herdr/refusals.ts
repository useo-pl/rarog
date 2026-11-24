/**
 * Refusals of the herdr driver, a module of the driver: a decision that did not reach the pane (the sentence for the
 * human, the card cleared or kept, the outcome for the manager) and the one audit funnel of refusals with its
 * diagnostic dump, plus the registry and router fields of an `approve` entry. It sends no key and writes no audit
 * line itself: the key path, the audit writer and the card state stay in the facade `drivers/herdr-driver.ts`.
 */
import type { OwnText } from '@rarog/shared/sentences';
import { HERDR_PANE_ROWS_WAIT_MS } from '../../config.ts';
import type { CliDialogClass } from '../../cli-version.ts';
import type { Scheduler, TimerHandle } from '../runtime.ts';
import type { DecisionOutcome } from '../types.ts';
import { refused } from '../types.ts';
import type { HerdrClient } from '../../herdr/types.ts';
import {
  STALE_DECISION_MESSAGE, TERMINAL_DIALOG_MESSAGE, admittedHook, blockVisible, dialogShapeOf, routeDialog,
  routeHookOf, routeScreenOf,
} from '../../herdr/dialogs/index.ts';
import type {
  ActiveReq, CardOrigin, DecisionResolution, DegradeDiagnosis, ExpectedDecision, PendingHookTool, RefusalDump,
  RefusalDumper,
} from '../../herdr/dialogs/index.ts';
import type { PendingTool } from '../../herdr/jsonl-pending.ts';
import type { AnswerShape, AuditCaseShape, HerdrRefuseReason } from '../../herdr/audit.ts';
import { diagnosisFields, originFields } from './audit-fields.ts';
import { layer2HoldsKeys } from './layer2-card.ts';

/** Kontekst karty bez decyzji dla dziennika: tożsamość i pochodzenie karty oraz kształt z oceny. */
export interface DegradeContext {
  readonly reqId: string;
  readonly origin: CardOrigin | undefined;
  readonly diagnosis: DegradeDiagnosis;
}

/** A refusal or degrade entry for the driver's audit writer, which adds the pane, the mode and the time. */
export type RefusalAuditEntry = AuditCaseShape & {
  readonly method: 'refuse' | 'degrade';
  readonly reason: HerdrRefuseReason;
  readonly toolName?: string;
  readonly shape?: AnswerShape;
  readonly cliDialog?: CliDialogClass;
};

/** Driver dependencies the refusals read; the same fields as in the driver's deps. */
export interface RefusalDeps {
  readonly now: () => number;
  readonly client: Pick<HerdrClient, 'readPaneRows'>;
  readonly paneRowsWaitMs?: number;
  readonly dumpRefusal?: RefusalDumper;
  readonly sessionId?: string;
  readonly readPendingHook?: (engineSessionId: string) => PendingHookTool | null;
}

/** Driver state the refusals read and the steps that stay in the facade. */
export interface RefusalPort {
  readonly deps: RefusalDeps;
  readonly scheduler: Scheduler;
  paneId(): string;
  agentSessionId(): string;
  /** The cache of the driver's last screen read. */
  screenText(): string | null;
  activeReq(): ActiveReq | null;
  pending(): PendingTool | null;
  /** The CLI registry class while the registry says `waiting`. */
  cliWaiting(): CliDialogClass | null;
  /** The driver's option resolver (`HerdrDriverDeps.resolveOptions`). */
  resolveOptions(screenText: string, expected: ExpectedDecision | null): DecisionResolution;
  /** The driver's audit writer; `at` is the time of the event. */
  audit(entry: RefusalAuditEntry, at: number): void;
  system(text: OwnText): void;
  clearActive(reason: string): void;
  scheduleEvaluate(): void;
}

/**
 * Odmowa wysyłki cyfry: powiedz DLACZEGO i ODBUDUJ kartę.
 *
 * Karta gaśnie i ocena buduje ją od nowa z tego, co stoi TERAZ — decyzja nie wyszła, ale
 * człowiek ma na czym pracować. To JEDYNA ścieżka odbudowy po odmowie
 * decyzji: pending w managerze przeżywa `refused` (kontrakt `DecisionOutcome`), więc
 * odbudowa nie musi już nadrabiać wpisu zjedzonego przez first-wins.
 */
export function refuseDecision(
  port: RefusalPort, message: OwnText, reason: string, audit: HerdrRefuseReason, shape?: AnswerShape,
): DecisionOutcome {
  auditRefusal(port, audit, port.activeReq()?.toolName, 'refuse', shape);
  port.system(message);
  port.clearActive(reason);
  port.scheduleEvaluate();
  return refused(audit);
}

/**
 * Herdr odrzucił samo wywołanie — nic nie poszło do panelu.
 *
 * Karty NIE gasimy i oceny nie ponawiamy: dialog stoi dalej, a `#send` zdążył już
 * powiedzieć człowiekowi, co się stało (blokada / panel zniknął / tryb tylko do odczytu).
 * Wpis w dzienniku dokłada tę odmowę do licznika (`summarizeRefusals` w `herdr/audit.ts`) — bez niego
 * najczęstsza awaria kanału nie miałaby w statystyce ani jednej linii.
 */
export function refuseSend(port: RefusalPort): DecisionOutcome {
  auditRefusal(port, 'send-failed', port.activeReq()?.toolName);
  return refused('send-failed');
}

/**
 * `allow` over a layer 2 card (`layer2HoldsKeys`, `docs/dialog-card.md`): `terminal-only` with the sentence of the
 * terminal dialogs, the card stays; a choice goes only through the layer 2 step. `null` = another card or none.
 */
export function layer2KeyRefusal(port: RefusalPort): DecisionOutcome | null {
  if (!layer2HoldsKeys(port.activeReq())) return null;
  auditRefusal(port, 'terminal-only', port.activeReq()?.toolName);
  port.system(TERMINAL_DIALOG_MESSAGE);
  return refused('terminal-only');
}

/**
 * Odpowiedź z NOTATKĄ nie wyszła — nic nie poszło ani do panelu, ani do pliku.
 *
 * Karty NIE gasimy, jak przy `refuseSend`: dialog stoi dalej, a człowiek ma na niej szkic
 * z notatką (odmowa 422 zostawia kartę w stanie wyboru). Powód `send-failed` z zamkniętej
 * listy znaczy dokładnie to: „nic nie doszło" — dokładniejsze zdanie idzie do transkryptu.
 * `toolName` podaje wołający, gdy odpowiedź przyszła na inną kartę niż ta, która stoi.
 */
export function refuseNote(
  port: RefusalPort, message: OwnText, toolName = port.activeReq()?.toolName,
): DecisionOutcome {
  auditRefusal(port, 'send-failed', toolName);
  port.system(message);
  return refused('send-failed');
}

/**
 * Wpis „decyzja NIE wyszła" — jedyna metoda dziennika bez ani jednego bajtu do panelu.
 *
 * Powód jest z zamkniętej listy, bo te wpisy mają się SUMOWAĆ (`summarizeRefusals` w `herdr/audit.ts`),
 * a nie opisywać: zdanie dla człowieka i tak idzie do transkryptu osobno. Nazwa narzędzia
 * jedzie z kartą — bez niej „18 odmów" nie mówi, czego dotyczyły.
 */
export function auditRefusal(
  port: RefusalPort,
  reason: HerdrRefuseReason,
  toolName?: string,
  method: 'refuse' | 'degrade' = 'refuse',
  shape?: AnswerShape,
  degrade?: DegradeContext,
): void {
  const at = port.deps.now();
  // The class from the CLI registry when it says `waiting`: the counter must tell WHICH dialogs
  // Rarog cannot read, and the router verdict (`routeFields`) uses it as input.
  const cliDialog = port.cliWaiting();
  const hook = readHookQuietly(port);
  /*
   * KSZTAŁT przypadku. Karta bez decyzji niesie go z oceny (`decideCard` liczy go z tego
   * samego odczytu ekranu, z którego powstała karta, razem z podpowodem sprzed spadku na ścieżkę
   * ekranową). Odmowa wysyłki — ze stojącej karty i z ostatniego odczytu ekranu, tego samego, który
   * trafia do zrzutu odmowy.
   */
  const caseShape: AuditCaseShape = {
    ...(degrade === undefined
      ? {
        ...originFields(port.activeReq()?.reqId ?? null, port.activeReq()?.origin),
        ...diagnosisFields({ mismatchReason: null, ...dialogShapeOf(port.screenText()) }),
      }
      : { ...originFields(degrade.reqId, degrade.origin), ...diagnosisFields(degrade.diagnosis) }),
    ...routeFields(port, hook),
  };
  const entry: RefusalAuditEntry = {
    method,
    reason,
    ...(toolName === undefined ? {} : { toolName }),
    ...(shape === undefined ? {} : { shape }),
    ...(cliDialog === null ? {} : { cliDialog }),
    ...caseShape,
  };
  const dump = refusalDump(port, reason, toolName, caseShape, cliDialog, hook, at);
  const write = (rows: number | null): void => {
    const withRows = rows === null ? {} : { paneRows: rows };
    port.audit({ ...entry, ...withRows }, at);
    if (dump !== null) writeDump(port, { ...dump, shape: { ...caseShape, ...withRows } });
  };
  /*
   * Wiersze panelu z herdr WYŁĄCZNIE przy karcie bez decyzji: jeden `pane.list`, po nim
   * wpis i zrzut. Karta nie czeka — wpis dochodzi do pliku z czasem oceny. Budżet czekania liczy
   * DRIVER (`HERDR_PANE_ROWS_WAIT_MS`, łącznie z kolejką slotów gniazda): po nim wpis i zrzut idą
   * bez wierszy, dokładnie raz, a spóźniony wynik przepada. Sufit gniazda zostaje zwykły — krótszy
   * oznaczałby herdr jako niedostępny z powodu diagnostyki. Błąd odczytu
   * albo brak metody = wpis bez wierszy, nigdy liczba zgadnięta z ekranu.
   */
  const client = port.deps.client;
  if (method !== 'degrade' || client.readPaneRows === undefined) {
    write(null);
    return;
  }
  let timer: TimerHandle | null = null;
  let written = false;
  const once = (rows: number | null): void => {
    if (written) return;
    written = true;
    if (timer !== null) port.scheduler.clearTimeout(timer);
    write(rows);
  };
  timer = port.scheduler.setTimeout(() => { once(null); }, port.deps.paneRowsWaitMs ?? HERDR_PANE_ROWS_WAIT_MS);
  void client.readPaneRows(port.paneId()).then((rows) => { once(rows); }, () => { once(null); });
}

/**
 * Zrzut diagnostyczny do `<dataDir>/refusals/`
 * („Refusal diagnostics” w `docs/dialogs.md`) — jedno wywołanie na jedną odmowę.
 *
 * Stoi w `auditRefusal`, bo to JEDYNY lejek odmów w driverze: każdy powód, który wchodzi
 * do statystyki, zostawia też ekran, z którego powstał. Ekran bierzemy z cache'u ostatniego
 * odczytu (`#screenText`) — świeżego, bo ocena dialogu czyta go tuż przed decyzją.
 *
 * Treść zrzutu składamy OD RAZU (ekran, zrzut hooka i wpis jsonl z chwili odmowy), a zapisujemy
 * po odczycie wierszy panelu (`writeDump`) — w tym czasie kolejna ocena mogłaby podmienić cache.
 *
 * Ze zrzutu hooka jadą wyłącznie METADANE (zdarzenie, czas, narzędzie, a w kształcie przypadku
 * identyfikatory tury i subagenta). `toolInput` NIE —
 * on siedzi w `pending/` i nie ma powodu leżeć na dysku drugi raz.
 */
function refusalDump(
  port: RefusalPort, reason: HerdrRefuseReason, toolName: string | undefined, shape: AuditCaseShape,
  cliDialog: CliDialogClass | null, hook: PendingHookTool | null, at: number,
): RefusalDump | null {
  if (port.deps.dumpRefusal === undefined) return null;
  const pending = port.pending();
  return {
    reason,
    toolName,
    ...(port.deps.sessionId === undefined ? {} : { sessionId: port.deps.sessionId }),
    screen: port.screenText(),
    hook: hook === null
      ? null
      : {
        toolName: hook.toolName,
        at: hook.at,
        ...(hook.hookEventName === undefined ? {} : { hookEventName: hook.hookEventName }),
      },
    jsonl: pending === null ? null : { id: pending.id, toolName: pending.toolName },
    shape,
    ...(cliDialog === null ? {} : { cliDialog }),
    at,
  };
}

function writeDump(port: RefusalPort, dump: RefusalDump): void {
  try {
    port.deps.dumpRefusal?.(dump);
  } catch {
    // Diagnostyka nie ma prawa wywrócić obsługi odmowy — cisza, jak przy dzienniku.
  }
}

/**
 * Zrzut hooka tej sesji do dziennika; błąd czytnika znaczy „brak zrzutu”, nigdy wyjątek w obsłudze. Zrzut `Bash`
 * starszy niż 10 minut liczy się tylko z dowodem z ostatniego odczytu ekranu (`admittedHook`),
 * jak w ocenie: inaczej rozdzielacz widziałby zrzut, którego karta nie wzięła.
 */
function readHookQuietly(port: RefusalPort): PendingHookTool | null {
  try {
    const raw = port.deps.readPendingHook?.(port.agentSessionId()) ?? null;
    return admittedHook(raw, port.screenText(), (text, expected) => port.resolveOptions(text, expected));
  } catch {
    return null;
  }
}

/**
 * Pola dziennika z rozdzielacza warstw i pełnego bloku (`approve`, `degrade`, `refuse`): werdykt
 * `routeDialog` z klasy rejestru CLI, zrzutu hooka i ostatniego odczytu ekranu (`#screenText`, ten sam,
 * który trafia do zrzutu odmowy) oraz `blockVisible` z tego odczytu. Wyłącznie dziennik — karta, przyciski
 * i klawisze od tych pól nie zależą. Wyjątek parsera daje wpis bez tych pól, nigdy wstrzymaną wysyłkę.
 */
function routeFields(port: RefusalPort, hook: PendingHookTool | null): AuditCaseShape {
  try {
    const text = port.screenText();
    const { route, reason } = routeDialog({
      cliDialog: port.cliWaiting(), hook: routeHookOf(hook), screen: routeScreenOf(text),
    });
    return { ...(text === null ? {} : { blockVisible: blockVisible(text) }), route, routeReason: reason };
  } catch {
    return {};
  }
}

/** Kontekst rejestru i rozdzielacza do wpisu `approve`: klasa CLI (gdy `waiting`) i {@link routeFields}. */
export function approveContext(port: RefusalPort): Pick<RefusalAuditEntry, 'cliDialog'> & AuditCaseShape {
  const cliDialog = port.cliWaiting();
  return { ...(cliDialog === null ? {} : { cliDialog }), ...routeFields(port, readHookQuietly(port)) };
}

/**
 * Odpowiedź w inny dialog niż ten, który AKTUALNIE stoi — mówimy o tym GŁOŚNO.
 *
 * `active === null` to normalny wyścig (dialog właśnie rozstrzygnięto — decyzja spóźniona
 * o ułamek sekundy, cisza jest poprawna). Ale odpowiedź adresująca INNY dialog znaczy, że
 * telefon patrzył na nieświeżą kartę — a jej zjedzenie po cichu wyglądałoby jak „tapnąłem
 * i nic".
 */
export function reportStaleDecision(port: RefusalPort): DecisionOutcome {
  auditRefusal(port, 'stale-card', port.activeReq()?.toolName);
  port.system(STALE_DECISION_MESSAGE);
  /*
   * `refused`, nie `stale`: Rarog POKAZUJE dziś inną kartę niż ta, w którą tapnięto, więc
   * karta, o której mówi żądanie, ma zniknąć razem ze swoim pendingiem — ale ta ŻYWA ma
   * zostać. `stale` wygasiłoby cały pending sesji (410 + `expired`), czyli zdjęłoby także
   * kartę, która mówi prawdę o ekranie.
   */
  return refused('stale-card');
}
