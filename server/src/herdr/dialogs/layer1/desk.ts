/**
 * Desk fallback of the consent channel (layer 1): the clock of a subagent `pending` record without proof,
 * its holds while the session registry says `waiting: permission`, and the signed `release` that sends the request
 * back to the desk (`desk-fallback`, `mcp-interaction`); a durable verdict of the session hook list sends it back at
 * once (`consentDeskAtOnce`). It owns the clocks and the holds; the record writes, the write protocol and the card
 * view stay in `cycle.ts` behind the port. Description: `docs/dialogs.md`, "Channel cycle".
 */
import { REGISTRY_MAX_AGE_MS } from '../shadow/evidence.ts';
import type { RegistryEvidence } from '../shadow/evidence.ts';
import type { HookCallDump } from '../hook/contract.ts';
import type { ConsentCardView } from './cards.ts';
import { CONSENT_SUBAGENT_GRACE_MS } from './contract.ts';
import { consentDeskAtOnce } from './desk-reason.ts';
import type { ConsentDeskReason, ConsentDeskReleases } from './desk-reason.ts';
import type { ConsentCycleRecord, ConsentRecord } from './records.ts';
import type { ConsentRegistry } from './registry.ts';

/** The cycle's write outcome as the desk reads it (`ConsentOutcome` in `cycle.ts`). */
export type ConsentDeskOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** What the desk fallback needs from the cycle (`cycle.ts`): records, the registry, the card view and the writes. */
export interface ConsentDeskPort<O extends ConsentDeskOutcome> {
  readonly records: ReadonlyMap<string, ConsentCycleRecord>;
  readonly registry: Pick<ConsentRegistry, 'entry' | 'secretOf' | 'entries'>;
  readonly dumps: ReadonlyMap<string, HookCallDump>;
  readonly deskReasons: ReadonlyMap<string, { readonly reason: ConsentDeskReason; readonly hooks: string | null }>;
  readonly deskReleases: Pick<ConsentDeskReleases, 'note'>;
  slotOf(sessionId: string, key: string): string;
  now(): number;
  log(line: string): void;
  subagentsOpen(): boolean;
  viewOf(record: ConsentRecord): Pick<ConsentCardView, 'canAllow'>;
  writeDecision(
    record: ConsentRecord, decision: 'release', reasonId: 'release', extra: Pick<ConsentCycleRecord, 'releaseCause'>,
  ): O;
  commit(next: ConsentCycleRecord): ConsentCycleRecord;
  publish(record: ConsentRecord): void;
}

export interface ConsentDesk<O extends ConsentDeskOutcome> {
  noteHeld(sessionId: string, evidence: RegistryEvidence, at: number): void;
  releasePending(record: ConsentRecord, extra?: Pick<ConsentCycleRecord, 'releaseCause'>): O;
  deskFallback(record: ConsentRecord): ConsentRecord;
  mcpToDesk(record: ConsentRecord): ConsentRecord;
  /** The record left `pending`: its clock goes. */
  forgetClock(slot: string): void;
  /** The session ended: its holds go. */
  endSession(sessionId: string): void;
}

/**
 * Wstrzymania zegara powrotu do biurka jednej sesji (ms epoki): zamknięte przedziały `[from, to)` w kolejności czasu,
 * rozłączne, i otwarte od `openFrom`.
 */
interface HeldState {
  /** Zamknięte wstrzymania, bez tych, o które żaden zegar już nie zapyta (`heldHorizon`). */
  readonly closed: { readonly from: number; readonly to: number }[];
  openFrom: number | null;
  /** Chwila ostatniego świeżego odczytu `waiting: permission`. */
  lastAt: number;
  /** Koniec ostatniego zamkniętego wstrzymania: następne zaczyna się nie wcześniej (bez liczenia okresu dwa razy). */
  closedTo: number;
  /** Chwila najnowszego przyjętego odczytu rejestru (odczyt `unknown`: chwila obserwacji); starszy nic nie zmienia. */
  readAt: number;
}

export function createConsentDesk<O extends ConsentDeskOutcome>(port: ConsentDeskPort<O>): ConsentDesk<O> {
  const {
    records, registry, dumps, deskReasons, deskReleases, slotOf, now, log, subagentsOpen, viewOf, writeDecision, commit,
    publish,
  } = port;
  /**
   * Zegar powrotu do biurka per klucz `pending` subagenta: początek (przyjęcie rejestracji albo utrata dowodu);
   * `null` = przy ostatnim sprawdzeniu karta miała dowód (następny brak dowodu zaczyna zegar od nowa). Wstrzymania sesji
   * od początku liczy każde sprawdzenie od nowa ({@link heldBetween}). Wpis znika z wyjściem rekordu z `pending`.
   */
  const deskClocks = new Map<string, number | null>();
  /** Wstrzymania zegara powrotu per sesja silnika: rejestr `waiting: permission` ({@link noteHeld}). */
  const held = new Map<string, HeldState>();

  /**
   * Odczyt rejestru sesji do wstrzymań zegara powrotu. Świeży `waiting: permission` otwiera wstrzymanie od chwili
   * odczytu albo je przedłuża; każdy inny odczyt (świeży bez `waiting: permission`, nieznany, starszy niż
   * `REGISTRY_MAX_AGE_MS`) je zamyka: przy świeżym na jego chwili, inaczej teraz, nigdy później niż świeżość ostatniego
   * `waiting`. Wstrzymanie bez nowych odczytów kończy się samo po `REGISTRY_MAX_AGE_MS` ({@link heldBetween}).
   * Odczyt starszy niż najnowszy przyjęty (chwila odczytu, a bez niej chwila obserwacji) nic nie zmienia: driver bierze
   * rejestr przed `await` odczytu ekranu, a inna obserwacja tej sesji mogła w tym czasie dostarczyć nowszy. Nowe
   * wstrzymanie nie zaczyna się przed końcem poprzedniego, więc żaden okres nie liczy się dwa razy.
   */
  function noteHeld(sessionId: string, evidence: RegistryEvidence, at: number): void {
    const state = held.get(sessionId) ?? {
      closed: [], openFrom: null, lastAt: Number.NEGATIVE_INFINITY, closedTo: Number.NEGATIVE_INFINITY,
      readAt: Number.NEGATIVE_INFINITY,
    };
    held.set(sessionId, state);
    const readAt = evidence.kind === 'unknown' ? at : evidence.at;
    if (readAt < state.readAt) return;
    state.readAt = readAt;
    const fresh = evidence.kind !== 'unknown' && at - evidence.at <= REGISTRY_MAX_AGE_MS;
    const close = (end: number): void => {
      if (state.openFrom === null) return;
      const to = Math.min(end, state.lastAt + REGISTRY_MAX_AGE_MS);
      if (to > state.openFrom) {
        state.closed.push({ from: state.openFrom, to });
        state.closedTo = to;
      }
      state.openFrom = null;
    };
    if (fresh && evidence.kind === 'waiting' && evidence.dialog === 'permission') {
      // Przerwa dłuższa niż świeżość ostatniego `waiting`: tamto wstrzymanie skończyło się samo.
      if (state.openFrom !== null && evidence.at > state.lastAt + REGISTRY_MAX_AGE_MS) close(evidence.at);
      if (state.openFrom === null) state.openFrom = Math.max(evidence.at, state.closedTo);
      state.lastAt = Math.max(state.lastAt, evidence.at);
    } else {
      close(fresh ? evidence.at : at);
    }
    if (state.closed.length === 0) return;
    // Zamknięte wstrzymanie, które skończyło się przed najwcześniejszą chwilą, od której zegar może jeszcze liczyć,
    // nic już nie wnosi.
    const horizon = heldHorizon(sessionId, at);
    const keep = state.closed.findIndex((one) => one.to > horizon);
    state.closed.splice(0, keep === -1 ? state.closed.length : keep);
  }

  /**
   * Najwcześniejsza chwila, od której zegar powrotu sesji może jeszcze liczyć: przyjęcie najstarszej niezablokowanej
   * rejestracji subagenta tej sesji, której rekord jest w `pending` albo jeszcze nie powstał (początek zegara nie jest
   * wcześniejszy niż przyjęcie). Bez takiej `at`: rejestracja przyjęta później ma późniejszą chwilę przyjęcia.
   */
  function heldHorizon(sessionId: string, at: number): number {
    let horizon = at;
    for (const entry of registry.entries()) {
      if (entry.sessionId !== sessionId || entry.blocked) continue;
      const record = records.get(slotOf(sessionId, entry.key));
      const clocked = record === undefined
        ? entry.agentId !== undefined
        : record.state === 'pending' && record.agentId !== null;
      if (clocked) horizon = Math.min(horizon, entry.acceptedAt);
    }
    return horizon;
  }

  /** Wstrzymania zegara powrotu sesji w przedziale `[from, to)` (ms), także otwarte. */
  function heldBetween(sessionId: string, from: number, to: number): number {
    const state = held.get(sessionId);
    if (state === undefined) return 0;
    const overlap = (start: number, end: number): number => Math.max(0, Math.min(end, to) - Math.max(start, from));
    let sum = 0;
    for (const one of state.closed) sum += overlap(one.from, one.to);
    if (state.openFrom !== null) sum += overlap(state.openFrom, state.lastAt + REGISTRY_MAX_AGE_MS);
    return sum;
  }

  /**
   * `release` z `pending` od serwera (zwolnienie z urządzenia albo `rarog dialogs release`, powrót do biurka): protokół
   * zapisu decyzji, a przy `write-failed` rekord `pending` z licznikiem `releaseFailed` o jeden większym. Licznik
   * nie maleje ({@link commit}), więc zostaje też po udanym ponowieniu.
   */
  function releasePending(record: ConsentRecord, extra: Pick<ConsentCycleRecord, 'releaseCause'> = {}): O {
    const outcome = writeDecision(record, 'release', 'release', extra);
    if (outcome.ok || outcome.error !== 'write-failed') return outcome;
    const current: ConsentCycleRecord = records.get(slotOf(record.sessionId, record.key)) ?? record;
    commit({ ...current, releaseFailed: (current.releaseFailed ?? 0) + 1 });
    return outcome;
  }

  /**
   * Powrót do biurka, w kroku kolejki klucza. Przy `all` rekord subagenta w `pending`
   * z żywym sekretem: karta z przyciskiem zgody zatrzymuje zegar (następny brak dowodu liczy od nowa), bez dowodu
   * zegar biegnie od przyjęcia rejestracji albo od utraty dowodu, a czas wstrzymań sesji od tej chwili się nie liczy,
   * także wstrzymań sprzed pierwszego sprawdzenia rekordu. Po {@link CONSENT_SUBAGENT_GRACE_MS} podpisane `release`
   * z `releaseCause: desk-fallback`; `write-failed` = rekord `pending` z licznikiem `releaseFailed` o jeden większym
   * ({@link releasePending}). Bez sekretu (hook nie czeka na kanale) nic.
   * A durable verdict of the session hook list under the `screen` hidden rule (`consentDeskAtOnce`)
   * releases at the first check without a button, holds or not: the hidden proof cannot come back for this process.
   */
  function deskFallback(record: ConsentRecord): ConsentRecord {
    if (record.state !== 'pending' || record.agentId === null || !subagentsOpen()) return record;
    const entry = registry.entry(record.sessionId, record.key);
    if (entry === null || registry.secretOf(record.sessionId, record.key) === null) return record;
    const slot = slotOf(record.sessionId, record.key);
    const at = now();
    if (viewOf(record).canAllow) {
      deskClocks.set(slot, null);
      return record;
    }
    let from = deskClocks.get(slot);
    if (from === undefined || from === null) {
      from = from === null ? at : Math.min(entry.acceptedAt, at);
      deskClocks.set(slot, from);
    }
    const ran = at - from - heldBetween(record.sessionId, from, at);
    // Read before the release: leaving `pending` forgets the reason.
    const note = deskReasons.get(slot);
    if (ran < CONSENT_SUBAGENT_GRACE_MS && !consentDeskAtOnce(note)) return record;
    const reason = note?.reason ?? 'unknown';
    const cwd = dumps.get(slot)?.cwd ?? null;
    const outcome = releasePending(record, { releaseCause: 'desk-fallback' });
    if (outcome.ok) {
      deskReleases.note(slot, reason, note?.hooks ?? null, cwd);
      log(`consent: key ${record.key} (subagent) released to the desk after ${String(ran)} ms without proof`
        + ` (reason: ${reason})`);
    } else if (outcome.error === 'write-failed') {
      log(`consent: release of key ${record.key} (subagent) not written, retrying at the next observation`);
    }
    return records.get(slot) ?? record;
  }

  /**
   * MCP tool with user interaction (marker `mcpEmptySuggestions` of the dump): a plain `allow` does not close its dialog
   * (CLI 2.1.322), so a `pending` record goes back to the desk at once with a signed `release` (`releaseCause:
   * mcp-interaction`). The dialog then stands on screen and the phone answers it with the measured screen card.
   * The record of the first observation comes here written without publishing: a release that did not go out publishes
   * it, so the card without the approve button stays; `write-failed` is retried at the next observation of the key.
   */
  function mcpToDesk(record: ConsentRecord): ConsentRecord {
    const slot = slotOf(record.sessionId, record.key);
    if (record.state !== 'pending') return record;
    const outcome = releasePending(record, { releaseCause: 'mcp-interaction' });
    if (outcome.ok) log(`consent: key ${record.key} (MCP with user interaction) released to the desk`);
    else publish(records.get(slot) ?? record);
    return records.get(slot) ?? record;
  }

  return {
    noteHeld,
    releasePending,
    deskFallback,
    mcpToDesk,
    forgetClock: (slot) => {
      deskClocks.delete(slot);
    },
    endSession: (sessionId) => {
      held.delete(sessionId);
    },
  };
}
