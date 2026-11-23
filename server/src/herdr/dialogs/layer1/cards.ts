/**
 * Karty kanału zgód w pamięci serwera (warstwa 1), osobno od kart ekranowych w `PendingInteractions`:
 * karta kanału ma stały `permId` równy kluczowi hooka i stan z cyklu (`cycle.ts`), a nie z ekranu.
 *
 * Magazyn trzyma widok karty, jaki dostaje urządzenie (stan na drucie, przyciski, powód braku zgody, prezentacja),
 * i mówi, czy zapis coś zmienił: wołający wysyła zdarzenie tylko przy zmianie. Stan wewnętrzny `deciding` jedzie
 * jako {@link CONSENT_DECIDING_WIRE_STATE} bez przycisków ({@link wireStateOf}).
 */
import type { HookSuggestions } from '../hook/suggestions.ts';
import { CONSENT_DECIDING_WIRE_STATE, CONSENT_INTERNAL_STATES } from './contract.ts';
import type {
  ConsentCause, ConsentCycleState, ConsentDeskDecision, ConsentUnavailable, ConsentWireState,
} from './contract.ts';
import type { ConsentAlwaysEntry } from './always.ts';
import type { ConsentPresentation } from './card.ts';

/** Widok karty kanału dla urządzeń. */
export interface ConsentCardView {
  /** Stały identyfikator karty: klucz hooka. */
  readonly permId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly toolName: string;
  readonly agentId: string | null;
  /**
   * Pełna prezentacja wejścia albo `null` (zrzut przycięty albo nie do pokazania, karta końcowa po publikacji stanu
   * końcowego: cykl nie trzyma już jej treści).
   */
  readonly presentation: ConsentPresentation | null;
  readonly state: ConsentWireState;
  readonly canAllow: boolean;
  readonly canDeny: boolean;
  readonly canRelease: boolean;
  readonly unavailable: ConsentUnavailable | null;
  readonly cause: ConsentCause | null;
  readonly late: boolean;
  /** Ms epoki pojawienia się karty. */
  readonly createdAt: number;
  /** Decision of the desk key of a `settled-at-desk` card, when the bound result showed it (`permission-resolved`). */
  readonly deskDecision?: ConsentDeskDecision;
  /**
   * The dump's checked `permission_suggestions` from the card verdict (`card.ts`), while the cycle keeps it. Data only:
   * no frame carries them yet.
   */
  readonly permissionSuggestions?: HookSuggestions;
  /** The "always" option of the card verdict (`card.ts`); the button needs `canAllow` as well. */
  readonly always?: readonly ConsentAlwaysEntry[];
}

/** Stan cyklu na drucie: stany wewnętrzne jako {@link CONSENT_DECIDING_WIRE_STATE}. */
export function wireStateOf(state: ConsentCycleState): ConsentWireState {
  return (CONSENT_INTERNAL_STATES as readonly ConsentCycleState[]).includes(state)
    ? CONSENT_DECIDING_WIRE_STATE
    : state as ConsentWireState;
}

export type ConsentCardChange = 'added' | 'changed' | 'same';

export interface ConsentCards {
  /** Zapis widoku; `same` = nic się nie zmieniło (bez zdarzenia). */
  set(view: ConsentCardView): ConsentCardChange;
  get(sessionId: string, permId: string): ConsentCardView | null;
  /** `true` = karta była. */
  delete(sessionId: string, permId: string): boolean;
  /** Karty sesji (albo wszystkie) w kolejności pojawienia się. */
  list(sessionId?: string): ConsentCardView[];
}

function slot(sessionId: string, permId: string): string {
  return `${sessionId}\n${permId}`;
}

function sameView(a: ConsentCardView, b: ConsentCardView): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createConsentCards(): ConsentCards {
  const cards = new Map<string, ConsentCardView>();
  return {
    set(view) {
      const id = slot(view.sessionId, view.permId);
      const before = cards.get(id);
      if (before !== undefined && sameView(before, view)) return 'same';
      cards.set(id, view);
      return before === undefined ? 'added' : 'changed';
    },
    get(sessionId, permId) {
      return cards.get(slot(sessionId, permId)) ?? null;
    },
    delete(sessionId, permId) {
      return cards.delete(slot(sessionId, permId));
    },
    list(sessionId) {
      const all = [...cards.values()];
      return (sessionId === undefined ? all : all.filter((card) => card.sessionId === sessionId))
        .sort((a, b) => a.createdAt - b.createdAt);
    },
  };
}
