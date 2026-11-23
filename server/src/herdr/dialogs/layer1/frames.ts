/**
 * Ramki kontraktu dla karty kanału zgód (warstwa 1): widok karty z `cards.ts` → `PermissionRequest`
 * z `channel: 'hook'`, zdarzenie `permission-settled` (zmiana stanu albo przycisków w miejscu) i
 * `permission-resolved` (stan końcowy albo `running`).
 *
 * Karta niesie pełną prezentację wejścia (`displayText`, `inputKind`, `fields`, `notes`) z `card.ts`; bez
 * prezentacji (zrzut przycięty albo nie do pokazania) `displayText` to zdanie z kodem, a zgody nie ma. The "always"
 * option (`always`, `always.ts`) goes with the presentation only. `permId` to
 * stały klucz hooka, bez generacji: nowa karta o tym samym `permId` zastępuje poprzednią po stronie apki.
 *
 * Czyste funkcje nad jawnymi wejściami, bez dysku i zegara. Ramki przechodzą ścisły kontrakt
 * (`server/test/sse-fixtures-producenci-zgody.ts`, złote ramki `permission-pending.hook*.json`).
 */
import { say } from '@rarog/shared/sentences';
import type {
  ConsentAlwaysEntry as WireAlwaysEntry, ConsentCardState, ConsentNote, ConsentUnavailableReason, PermissionRequest,
  Risk, ServerEvent,
} from '@rarog/shared';
import type { ConsentAlwaysEntry } from './always.ts';
import { CONSENT_FINAL_STATES } from './contract.ts';
import type { ConsentDecision, ConsentUnavailable, ConsentWireState } from './contract.ts';
import type { ConsentPresentationNote } from './card.ts';
import type { ConsentCardView } from './cards.ts';

// Wartości warstwy 1 i kontraktu muszą być tymi samymi listami: rozjazd to błąd `tsc` tutaj.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _states: Same<ConsentWireState, ConsentCardState> = true;
const _unavailable: Same<ConsentUnavailable, ConsentUnavailableReason> = true;
const _notes: Same<ConsentPresentationNote, ConsentNote> = true;
const _always: Same<ConsentAlwaysEntry, Readonly<WireAlwaysEntry>> = true;
void _always;
void _states;
void _unavailable;
void _notes;

/** Czego widok karty nie niesie, a kontrakt wymaga albo przyjmuje. */
export interface ConsentFrameContext {
  /** Katalog sesji ze zrzutu hooka. */
  readonly cwd: string;
  readonly risk: Risk;
  /** Dowód z ekranu, że dialog stoi w terminalu; `undefined` = serwer tego nie wie. */
  readonly dialogVisible?: boolean;
  /** Prośby rodzeństwa odrzucone razem z tą kartą; `0` i `undefined` = bez pola. */
  readonly siblingsDenied?: number;
}

/** Nazwa narzędzia wyjścia z planu (`subject: 'plan'`). */
const PLAN_TOOL = 'ExitPlanMode';

/** Karta kanału na drucie (`permission-pending`, `transcript-snapshot.pendingPermissions`). */
export function consentPermissionRequest(view: ConsentCardView, context: ConsentFrameContext): PermissionRequest {
  const presentation = view.presentation;
  const notShown = say('dialogs.consent.not-shown');
  return {
    permId: view.permId,
    sessionId: view.sessionId,
    toolName: view.toolName,
    ...(presentation === null
      ? { displayText: notShown.text, displayTextRef: notShown.ref }
      : { displayText: presentation.displayText, inputKind: presentation.inputKind }),
    risk: context.risk,
    cwd: context.cwd,
    createdAt: new Date(view.createdAt).toISOString(),
    canAllow: presentation !== null && view.canAllow,
    subject: view.toolName === PLAN_TOOL ? 'plan' : 'tool',
    channel: 'hook',
    state: view.state,
    ...(view.unavailable === null ? {} : { unavailable: view.unavailable }),
    ...(context.dialogVisible === undefined ? {} : { dialogVisible: context.dialogVisible }),
    ...(context.siblingsDenied === undefined || context.siblingsDenied === 0
      ? {}
      : { siblingsDenied: context.siblingsDenied }),
    ...(presentation === null || presentation.fields.length === 0
      ? {}
      : { fields: presentation.fields.map((field) => ({ name: field.name, value: field.value })) }),
    ...(presentation === null || presentation.notes.length === 0 ? {} : { notes: [...presentation.notes] }),
    ...(presentation === null || view.always === undefined ? {} : { always: view.always.map((entry) => ({ ...entry })) }),
  };
}

/** Zmiana stanu albo przycisków karty w miejscu; `at` = chwila zmiany (ms epoki). */
export function consentSettledEvent(
  view: ConsentCardView, at: number, dialogVisible?: boolean,
): Extract<ServerEvent, { type: 'permission-settled' }> {
  return {
    type: 'permission-settled',
    sessionId: view.sessionId,
    permId: view.permId,
    state: view.state,
    canAllow: view.presentation !== null && view.canAllow,
    ...(view.unavailable === null ? {} : { unavailable: view.unavailable }),
    ...(dialogVisible === undefined ? {} : { dialogVisible }),
    at: new Date(at).toISOString(),
  };
}

/**
 * Zdjęcie karty z urządzeń: stan końcowy albo `running` (odpowiedź oddana hookowi, dialog karty zniknął).
 * `applied` i `running` z decyzją rekordu (`allow`/`deny`) niosą tę decyzję, każdy inny stan
 * końcowy i `running` bez decyzji jako `expired`. Inny stan niekońcowy = `null` (karta zostaje, zmiany idą
 * `permission-settled`). `allow` przy `running` znaczy „odpowiedź oddana hookowi”, nie „narzędzie wykonane”.
 * `settled-at-desk` with the desk key's decision read from the result carries that decision with `by`
 * {@link CONSENT_DESK_BY}: the devices say the decision was made elsewhere, not that the request expired.
 */
export function consentResolvedEvent(
  view: ConsentCardView, decision: ConsentDecision | null, by: string,
): Extract<ServerEvent, { type: 'permission-resolved' }> | null {
  const running = view.state === 'running';
  if (!running && !(CONSENT_FINAL_STATES as readonly string[]).includes(view.state)) return null;
  if (view.state === 'settled-at-desk' && view.deskDecision !== undefined) {
    return {
      type: 'permission-resolved', sessionId: view.sessionId, permId: view.permId, decision: view.deskDecision,
      by: CONSENT_DESK_BY,
    };
  }
  const decided = (running || view.state === 'applied') && (decision === 'allow' || decision === 'deny');
  return {
    type: 'permission-resolved',
    sessionId: view.sessionId,
    permId: view.permId,
    decision: decided ? decision : 'expired',
    by,
  };
}

/** `by` of a card settled with a desk key in the terminal. */
export const CONSENT_DESK_BY = 'terminal';

/** Część cyklu, której potrzebuje {@link retireRunningAfterRecover}. */
export interface ConsentRetirePort {
  cards(): readonly ConsentCardView[];
  retire(sessionId: string, key: string): Promise<boolean>;
}

/**
 * Zdjęcie odzyskanych kart `running` zaraz po `recover`, przed pierwszym przeglądem dowodów.
 * Karta `running` sprzed restartu jest już poza urządzeniami; bez pola zdjęcia w rekordzie koniec tury
 * bez skutku (`unknown`) dotarłby do managera jako karta, której urządzenia nie widziały, i wróciłby jako nowa.
 * Rekord z polem zdjęcia `retire` zostawia bez zmian. Błąd zapisu idzie do logu, a kartę i tak zdejmie manager przy
 * pierwszej migawce albo zmianie z cyklu. Oddaje liczbę zdjętych kart.
 */
export async function retireRunningAfterRecover(
  cycle: ConsentRetirePort, log: (line: string) => void,
): Promise<number> {
  const running = cycle.cards().filter((card) => card.state === 'running');
  const done = await Promise.all(running.map(async (card) => {
    try {
      return await cycle.retire(card.sessionId, card.permId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`consent: card ${card.permId} retire after recovery not saved: ${reason}`);
      return false;
    }
  }));
  return done.filter(Boolean).length;
}
