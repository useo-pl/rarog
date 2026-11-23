/**
 * Settlement of consent-channel turns (layer 1): which turns the transcript review still reads
 * ({@link ConsentTurns.evidenceTargets}) and what the facts of one turn do to its records ({@link ConsentTurns.applyTurn}).
 * It owns the closed-turn memory; record writes, the per-key queue and hook files stay in `cycle.ts` behind the port.
 * A key whose call is over settles during the turn ({@link bindDuringTurn}); the rest waits for the turn end. No
 * disk, transcript or panel access here (`layer1-granica.test.ts`).
 *
 * Tura ma klucz stanu (`sessionId`, `agentId`, `promptId`), z `agentId = null` dla wątku głównego (5.2):
 * pod nim żyją cele przeglądu ({@link ConsentEvidenceTarget}), zamknięte tury i {@link ConsentCycle.applyTurn}.
 * Rekord subagenta czeka na dowód tylko przy trybie `all`; jego turę zamyka koniec biegu agenta z pliku głównego
 * (`bindAgentTurn` w `bind.ts`), nie koniec tury głównej, a koniec jednego subagenta nie zamyka drugiego.
 */
import { agentTurnEnd, bindAgentTurn, bindDuringTurn, bindTurn, boundResult } from './bind.ts';
import type { BindKey, BindVerdict, ConsentTurnFacts, TurnToolResult } from './bind.ts';
import { CONSENT_REVOKE_CAUSES } from './contract.ts';
import type {
  ConsentCause, ConsentCheckpoint, ConsentCycleState, ConsentRevokeCause, ConsentUnknownCause,
} from './contract.ts';
import { consentAnswerProven, consentDeskDecisionOf, consentEffectOf, consentSettlement } from './proof.ts';
import type { ConsentSettlement } from './proof.ts';
import type { ConsentCycleRecord, ConsentRecord } from './records.ts';
import type { ConsentRegistry } from './registry.ts';

/** Tura z rekordami, którym brakuje dowodu z transkryptu: wejście przeglądu `consent-evidence.ts`. */
export interface ConsentEvidenceTarget {
  readonly sessionId: string;
  /** Subagent tury (plik `subagents/agent-<agentId>.jsonl`) albo `null` (wątek główny). */
  readonly agentId: string | null;
  readonly promptId: string;
  /** Checkpoint najwcześniejszego rekordu tury albo `null` (przegląd od początku pliku). */
  readonly checkpoint: ConsentCheckpoint | null;
  readonly keys: readonly string[];
  /**
   * The turn has a card the devices still show ({@link LIVE_STATES}): the review reads it on every tick, so the card
   * loses its button in the tick the call's result is in the file. No field = read at the review pace.
   */
  readonly live?: boolean;
}

/** States of a card the devices show; `running` has already left them (the manager's take-down). */
const LIVE_STATES: readonly ConsentCycleState[] = ['pending', 'sent', 'claimed'];

function isRevokeCause(cause: ConsentCause | null): cause is ConsentRevokeCause {
  return cause !== null && (CONSENT_REVOKE_CAUSES as readonly string[]).includes(cause);
}

/** Klucz stanu tury (5.2): sesja, subagent (`null` = wątek główny) i `promptId`. */
function turnSlotOf(sessionId: string, agentId: string | null, promptId: string): string {
  return `${sessionId}\n${agentId ?? ''}\n${promptId}`;
}

/** What the turn settlement needs from the cycle (`cycle.ts`): records, the per-key queue and the transitions. */
export interface ConsentTurnsPort {
  readonly records: ReadonlyMap<string, ConsentCycleRecord>;
  readonly bootId: string;
  readonly registry: Pick<ConsentRegistry, 'entry'>;
  slotOf(sessionId: string, key: string): string;
  enqueue<T>(slot: string, task: () => T | Promise<T>): Promise<T>;
  subagentsOpen(): boolean;
  commit(next: ConsentCycleRecord): ConsentCycleRecord;
  moveTo(
    record: ConsentRecord, state: ConsentCycleState, cause?: ConsentCause | null, extra?: Partial<ConsentCycleRecord>,
  ): ConsentRecord;
  claimed(record: ConsentRecord): ConsentRecord;
  claimedMatches(record: ConsentRecord): boolean;
  releaseHook(record: ConsentRecord): ConsentRecord;
  revoke(record: ConsentRecord, cause: ConsentRevokeCause): ConsentRecord;
  /** `quiet`: the `revoked` record is not published; the caller settles it in the same task. */
  afterRevokeFile(record: ConsentRecord, cause: ConsentRevokeCause, quiet?: boolean): ConsentRecord;
}

export interface ConsentTurns {
  /** Tury, dla których przegląd transkryptu ma jeszcze czego szukać. */
  evidenceTargets(): ConsentEvidenceTarget[];
  /** Fakty tury z transkryptu (`ConsentCycle.applyTurn`). */
  applyTurn(sessionId: string, promptId: string, facts: ConsentTurnFacts, forcedEnd?: boolean): Promise<void>;
}

export function createConsentTurns(port: ConsentTurnsPort): ConsentTurns {
  const {
    records, bootId, registry, slotOf, enqueue, subagentsOpen, commit, moveTo, claimed, claimedMatches, releaseHook,
    revoke, afterRevokeFile,
  } = port;
  /**
   * Tury ({@link turnSlotOf}), których koniec przeczytano w transkrypcie, z chwilą końca: dowód po nim już nie
   * przyjdzie. Wątek główny na zawsze (`Infinity`); tura subagenta do najpóźniejszego końca jego biegu, bo prośba
   * z hookiem po nim to nowy bieg (wznowienie `SendMessage`).
   */
  const closedTurns = new Map<string, number>();

  /** Tura rekordu zamknięta: koniec przeczytany i nie starszy niż start jego hooka. */
  function turnClosed(record: ConsentRecord): boolean {
    const at = closedTurns.get(turnSlotOf(record.sessionId, record.agentId, record.promptId));
    return at !== undefined && record.hookStartedAt <= at;
  }

  /** Rekord czeka na dowód z transkryptu: wiązanie nierozstrzygnięte albo skutek możliwy jeszcze po `unknown`. */
  function wantsEvidence(record: ConsentRecord): boolean {
    // Subagent tylko przy kanale otwartym dla subagentów (tryb `all`).
    if (record.agentId !== null && !subagentsOpen()) return false;
    // Odebrana bez rozliczenia (przejęcie wykryte po końcu tury) czeka na dowód także po zamknięciu tury: następny
    // przegląd z końcem tury ją rozliczy.
    if (record.state === 'claimed' || record.state === 'running') return true;
    if (turnClosed(record)) return false;
    if (record.state === 'unknown') return true;
    // A card whose binding was written at a forced end without its call's result (any correlation but a confirmed
    // `bound`) waits like an `open` one: the result in later lines settles it, the real turn end revokes it.
    if (record.state === 'pending' || record.state === 'sent') {
      return record.correlation === 'open' || (record as ConsentCycleRecord).bindingConfirmed !== true;
    }
    if (record.correlation !== 'open') return false;
    if (record.state !== 'revoked') return false;
    // W-b: a signed answer revoked before its claim can still have run (a copy of the file taken by the
    // hook), so its result is looked for also after a restart.
    if (record.decision === 'allow' || record.decision === 'deny') return true;
    // Karta zdjęta sygnałem w tym procesie: klawisz przy biurku może jeszcze dać `settled-at-desk`.
    return record.bootId === bootId && (record.cause === 'dialog-gone' || record.cause === 'hook-dead');
  }

  function evidenceTargets(): ConsentEvidenceTarget[] {
    const turns = new Map<string, {
      sessionId: string; agentId: string | null; promptId: string; keys: string[]; records: ConsentRecord[];
    }>();
    for (const record of records.values()) {
      if (!wantsEvidence(record)) continue;
      const id = turnSlotOf(record.sessionId, record.agentId, record.promptId);
      const turn = turns.get(id) ?? {
        sessionId: record.sessionId, agentId: record.agentId, promptId: record.promptId, keys: [], records: [],
      };
      turn.keys.push(record.key);
      turn.records.push(record);
      turns.set(id, turn);
    }
    return [...turns.values()].map((turn) => {
      const points = turn.records.map((r) => r.checkpoint).filter((c): c is ConsentCheckpoint => c !== null);
      const checkpoint = points.length === turn.records.length
        ? points.reduce((a, b) => (b.lineStart < a.lineStart ? b : a))
        : null;
      const live = turn.records.some((r) => LIVE_STATES.includes(r.state));
      return {
        sessionId: turn.sessionId, agentId: turn.agentId, promptId: turn.promptId, checkpoint, keys: turn.keys, live,
      };
    });
  }

  /** Stan rekordu po końcu tury bez skutku w transkrypcie. */
  function endWithoutEffect(record: ConsentRecord, cause: ConsentUnknownCause, forced: boolean): ConsentRecord {
    // Hook subagenta z żywą rejestracją czeka na podpisany plik, `.revoked` go nie kończy. `pending` dostanie
    // `release` z powrotu do biurka, a `sent` z `release` już go ma: odbiór rozliczy przegląd plików (`.claimed`).
    // `sent` z `allow` albo `deny` dostaje odwołanie pliku i `release` jak wątek główny.
    const hookWaits = record.agentId !== null && registry.entry(record.sessionId, record.key) !== null;
    switch (record.state) {
      case 'claimed':
      case 'running':
        return moveTo(record, 'unknown', cause);
      // Koniec tury bez wywołania: CLI na tę prośbę już nie czeka, a jej hook może czekać dalej.
      case 'pending':
        return forced || hookWaits ? record : releaseHook(revoke(record, 'turn-ended'));
      case 'sent': {
        if (forced || (hookWaits && record.decision === 'release')) return record;
        const after = afterRevokeFile(record, 'turn-ended');
        return after.state === 'revoked' && after.cause === 'turn-ended' ? releaseHook(after) : after;
      }
      default:
        return record;
    }
  }

  async function applyTurn(
    sessionId: string, promptId: string, facts: ConsentTurnFacts, forcedEnd = false,
  ): Promise<void> {
    if (facts.promptId !== promptId) return;
    const agent = facts.agent ?? null;
    const agentId = agent?.agentId ?? null;
    if (agentId !== null && !subagentsOpen()) return;
    const turnRecords = [...records.values()]
      .filter((r) => r.sessionId === sessionId && r.promptId === promptId && r.agentId === agentId);
    if (turnRecords.length === 0) return;
    // Wymuszony koniec (bezczynność sesji, `/exit`) dotyczy tylko wątku głównego.
    const forcedTurn = agent === null && forcedEnd;
    const ended = facts.ended || forcedTurn;
    const keys: BindKey[] = turnRecords.map((r) => ({
      key: r.key, toolName: r.toolName, inputSha256: r.inputSha256, hookStartedAt: r.hookStartedAt,
    }));
    const verdicts = agent === null ? bindTurn(keys, facts, ended) : bindAgentTurn(keys, facts);
    const bindings = new Map(verdicts.map((v) => [v.key, v]));
    // Keys whose call is over, by the same facts: they settle before the end of the turn, and at its end the same
    // set says which ambiguous keys finished.
    const over = new Map(bindDuringTurn(keys, facts).map((v) => [v.key, v]));
    // Tura subagenta kończy się dla klucza osobno: bieg agenta z końcem nie starszym niż start jego hooka.
    const endedFor = (r: ConsentRecord): boolean => (agent === null
      ? ended
      : !facts.partial && agent.settled && agentTurnEnd(facts, r.hookStartedAt) !== null);
    const slot = turnSlotOf(sessionId, agentId, promptId);
    if (agent === null) {
      if (facts.ended && !facts.partial) closedTurns.set(slot, Number.POSITIVE_INFINITY);
    } else if (!facts.partial && agent.settled && agent.ends.length > 0) {
      closedTurns.set(slot, Math.max(closedTurns.get(slot) ?? Number.NEGATIVE_INFINITY, ...agent.ends.map((e) => e.at)));
    }
    await Promise.all(turnRecords.map((r) => enqueue(slotOf(r.sessionId, r.key), () => {
      let record = records.get(slotOf(r.sessionId, r.key));
      if (record === undefined || record.state === 'deciding') return;
      const closing = endedFor(r);
      const done = over.get(r.key);
      const kept = keptBinding(record);
      const verdict = kept ?? (closing ? bindings.get(r.key) : done);
      if (verdict === undefined || (!closing && verdict.correlation === 'open')) return;
      const bound = verdict.correlation === 'bound' && verdict.toolUseId !== null;
      const result = bound && verdict.toolUseId !== null ? boundResult(facts, verdict.toolUseId) : null;
      // A `bound` binding is confirmed by its call's result; one from a forced end without a result is provisional:
      // later lines (a second, overlapping identical call) can still make the key ambiguous.
      const confirmed = bound && (kept !== null || result !== null);
      const binding: Pick<ConsentCycleRecord, 'correlation' | 'toolUseId' | 'bindingConfirmed'> = {
        correlation: verdict.correlation, toolUseId: verdict.toolUseId,
        ...(confirmed ? { bindingConfirmed: true } : {}),
      };
      // During the turn the binding is written only with a settlement: an unsettled record keeps `open` and stays
      // in the review.
      if (closing && (record.correlation !== binding.correlation || record.toolUseId !== binding.toolUseId
        || (record as ConsentCycleRecord).bindingConfirmed !== binding.bindingConfirmed)) {
        record = commit({ ...record, ...binding });
      }
      // Przejęcie, którego przegląd plików jeszcze nie widział: rozliczenie dotyczy odpowiedzi odebranej.
      if (record.state === 'sent' && claimedMatches(record)) record = claimed(record);
      if (result !== null || done?.correlation === 'ambiguous-tool-use') {
        record = withoutAnswer(record, result);
        if (record.state !== 'sent' && settle(record, result, binding)) return;
      }
      if (!closing) return;
      const cause: ConsentUnknownCause = bound ? 'no-effect' : verdict.cause ?? 'no-tool-use';
      const forced = forcedTurn && !facts.ended;
      const after = endWithoutEffect(record, cause, forced);
      // Odwołanie przegrało z hookiem (przejął plik w tej chwili): odebrana odpowiedź bez wyniku tury.
      if (record.state === 'sent' && after.state === 'claimed') endWithoutEffect(after, cause, forced);
    })));
  }

  /**
   * A binding confirmed earlier ({@link ConsentCycleRecord.bindingConfirmed}: written with its call's result) stays:
   * later lines cannot change it. A binding without the mark (a forced end without a result, a record from before
   * the mark) is computed again from the facts.
   */
  function keptBinding(record: ConsentCycleRecord): BindVerdict | null {
    return record.correlation === 'bound' && record.toolUseId !== null && record.bindingConfirmed === true
      ? { key: record.key, correlation: 'bound', toolUseId: record.toolUseId, cause: null }
      : null;
  }

  /**
   * A `sent` answer the hook has not taken while the key's call is over: the call ran without it, so the file is
   * revoked and the hook released (`dialog-gone`). A `release` answer stays for the file check. A desk key in
   * the result settles the revoked record in the same task: the revocation is not published, so the devices get the
   * desk decision alone instead of an expiry first (the manager drops a card once it has seen it final).
   */
  function withoutAnswer(record: ConsentRecord, result: TurnToolResult | null): ConsentRecord {
    if (record.state !== 'sent' || record.decision === 'release') return record;
    const atDesk = result !== null && consentSettlement(
      'revoked', record.decision, consentEffectOf(result), consentAnswerProven(record),
    )?.state === 'settled-at-desk';
    const after = afterRevokeFile(record, 'dialog-gone', atDesk);
    return after.state === 'revoked' && after.cause === 'dialog-gone' ? releaseHook(after) : after;
  }

  /**
   * Settlement of a record whose call is over: from the bound result (`consentSettlement`, `applied` only with the
   * record's own answer proven, `consentAnswerProven`) or, with `result === null`, from an ambiguous key whose
   * candidates all finished (`unknown`, `ambiguous-tool-use`). `false` = nothing to change.
   */
  function settle(
    current: ConsentRecord, result: TurnToolResult | null,
    binding: Pick<ConsentCycleRecord, 'correlation' | 'toolUseId' | 'bindingConfirmed'>,
  ): boolean {
    const settlement: ConsentSettlement | null = result === null
      ? (current.state === 'pending' || current.state === 'claimed' || current.state === 'running'
        ? { state: 'unknown', cause: 'ambiguous-tool-use', late: false }
        : null)
      : consentSettlement(current.state, current.decision, consentEffectOf(result), consentAnswerProven(current));
    if (settlement === null) return false;
    let from = current;
    // A taken answer whose outcome stays open leaves the devices through `running`, like every answered card (the
    // manager's take-down), instead of staying there as an `unknown` card.
    if (from.state === 'claimed' && settlement.state === 'unknown') from = moveTo(from, 'running', null);
    const desk = settlement.state === 'settled-at-desk' ? consentDeskDecisionOf(result) : null;
    // A card revoked earlier left the devices with `permission-resolved`: the record leaving `revoked` keeps the
    // revocation and stays off the devices (`retired`), or the manager would show it again as a new card.
    const revokedAt = from.times.settled ?? from.times.pending;
    const revokeCause = isRevokeCause(from.cause) ? from.cause : null;
    const revocation = revokeCause === null ? {} : { revocation: { cause: revokeCause, at: revokedAt } };
    const revoked = from.state === 'revoked' && settlement.state !== 'settled-at-desk'
      ? { retired: (from as ConsentCycleRecord).retired ?? { at: revokedAt }, ...revocation }
      : {};
    const settled = moveTo(from, settlement.state, settlement.cause, {
      ...binding, late: settlement.late, ...(desk === null ? {} : { deskDecision: desk }), ...revoked,
    });
    // Klawisz przy biurku przed sygnałem `gone`: CLI nie zatrzymuje hooka rozstrzygniętej prośby; bez naszej
    // odpowiedzi zwolnienie dostaje też prośba rozstrzygnięta inaczej.
    if (current.state === 'pending') releaseHook(settled);
    return true;
  }

  return { evidenceTargets, applyTurn };
}
