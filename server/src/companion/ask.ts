/**
 * One question of the voice agent about one session: the work behind `POST /api/sessions/:id/companion/ask`.
 * The route checks the flag, the body and the session, and reads the engine conversation the session writes at that
 * moment; this module finds the conversation file, condenses it, asks the model through `cli.ts` and turns the outcome
 * into an answer or a refusal.
 *
 * Every question in flight has an owner (the device that asked) and the engine conversation it is about. Three
 * events kill its process through the abort signal of `cli.ts`; none of them gets a body:
 *
 * - the request closed before the answer (`closed`): nothing is sent, the connection is gone;
 * - the device was revoked (`revoked`, `device-effects.ts`): the route closes the response;
 * - the session moved to another engine conversation (`conversation`: `/clear`, `/resume` in the pane, reported by
 *   the session manager): the route closes the response. The app drops late results by its own conversation
 *   generation, so the server does not need a code for it.
 *
 * At most one question per session and {@link MAX_IN_FLIGHT} per server are in flight, counted from before the
 * file is read; one more is refused with 429 `companion-busy`, not queued. The log line carries codes, times and
 * counts, never the question, the transcript or the answer.
 */
import {
  COMPANION_BUSY_ERROR, COMPANION_CLI_ERROR, COMPANION_LIMIT_ERROR, COMPANION_TIMEOUT_ERROR,
} from '@rarog/shared/rest';
import type { CompanionAsk } from '@rarog/shared/rest';
import { join } from 'node:path';
import { defaultStoreRoot } from '../cli-store.ts';
import type { RarogConfig } from '../config.ts';
import { locateTranscript } from '../herdr/transcript-path.ts';
import {
  COMPANION_CWD_DIR, type CompanionCli, type CompanionFailure, MAX_IN_FLIGHT, createCompanionCli,
} from './cli.ts';
import { type CondensedTranscript, condenseFile } from './condense.ts';
import { buildSystem, parseAnswer } from './prompt.ts';

/** Error codes of the route that come from a question (the route itself adds `companion-disabled`). */
export type CompanionRefusal =
  | typeof COMPANION_BUSY_ERROR
  | typeof COMPANION_LIMIT_ERROR
  | typeof COMPANION_CLI_ERROR
  | typeof COMPANION_TIMEOUT_ERROR;

/** Why a question in flight was killed: closed request, revoked device, new engine conversation of the session. */
export type CompanionStop = 'closed' | 'revoked' | 'conversation';

/** What the route answers. `dropped`: no body; the route closes the response. */
export type CompanionAskResult =
  | { readonly kind: 'answer'; readonly body: CompanionAsk }
  | { readonly kind: 'refused'; readonly status: 429 | 503 | 504; readonly error: CompanionRefusal }
  | { readonly kind: 'dropped'; readonly why: CompanionStop };

/** Session the question is about, as the session manager sees it (`ManagerApi.companionTarget`). */
export interface CompanionTarget {
  /** Working directory of the session. */
  readonly cwd: string;
  /** Current engine conversation (`engineSessionId`); `undefined` before the first one. */
  readonly agentSessionId: string | undefined;
}

export interface CompanionAskInput {
  readonly sessionId: string;
  /** Device that asked (`principal.deviceId`); revoking it kills the question. */
  readonly owner: string | undefined;
  readonly cwd: string;
  /**
   * Engine conversation the question is about: the session's current one when the route took the request
   * (`CompanionTarget.agentSessionId`). `undefined` before the first one: no file, so the model gets no turns.
   */
  readonly agentSessionId: string | undefined;
  readonly question: string;
  /** Fires when the request closed before the answer. */
  readonly signal?: AbortSignal;
}

export interface CompanionFeature {
  ask(input: CompanionAskInput): Promise<CompanionAskResult>;
  /** Kills the questions of a revoked device; returns how many. */
  closeOwner(owner: string): number;
  /** The session now writes `agentSessionId`: kills its question about another conversation; returns how many. */
  conversationChanged(sessionId: string, agentSessionId: string): number;
  /**
   * Server shutdown: kills every question in flight and settles once each process is gone and its working
   * directory removed, so no `claude -p` outlives the server.
   */
  closeAll(): Promise<void>;
  /** Questions in flight now. */
  readonly running: number;
}

export interface CompanionFeatureOptions {
  readonly cli: CompanionCli;
  /** Conversation file of `agentSessionId` (`locateTranscript` in the Claude Code store); `null` = none yet. */
  readonly locate: (cwd: string, agentSessionId: string) => Promise<string | null>;
  readonly log: (line: string) => void;
  /** Default {@link condenseFile}. */
  readonly condense?: (file: string) => Promise<CondensedTranscript | null>;
  /** Default {@link MAX_IN_FLIGHT}, the same ceiling as the runner of `cli.ts`. */
  readonly maxInFlight?: number;
}

interface InFlight {
  readonly owner: string | undefined;
  readonly agentSessionId: string | undefined;
  readonly controller: AbortController;
  stopped: CompanionStop | null;
}

/** Status and code of each failure of `cli.ts`; `aborted` is one of the stop reasons instead. */
const REFUSALS: Readonly<Record<Exclude<CompanionFailure, 'aborted'>, {
  readonly status: 429 | 503 | 504; readonly error: CompanionRefusal;
}>> = {
  'companion-busy': { status: 429, error: COMPANION_BUSY_ERROR },
  'companion-limit': { status: 429, error: COMPANION_LIMIT_ERROR },
  'companion-cli': { status: 503, error: COMPANION_CLI_ERROR },
  'companion-timeout': { status: 504, error: COMPANION_TIMEOUT_ERROR },
};

const BUSY: CompanionAskResult = { kind: 'refused', status: 429, error: COMPANION_BUSY_ERROR };

/** The voice agent of one server: questions in flight and their kill switches. */
export function createCompanionFeature(opts: CompanionFeatureOptions): CompanionFeature {
  const maxInFlight = opts.maxInFlight ?? MAX_IN_FLIGHT;
  const condense = opts.condense ?? ((file: string) => condenseFile(file));
  const inFlight = new Map<string, InFlight>();
  /** Every `ask` still running, whatever its stage: what `closeAll` waits for. */
  const pending = new Set<Promise<CompanionAskResult>>();

  const stop = (entry: InFlight, why: CompanionStop): boolean => {
    if (entry.stopped !== null) return false;
    entry.stopped = why;
    entry.controller.abort();
    return true;
  };

  async function run(input: CompanionAskInput, entry: InFlight): Promise<{ result: CompanionAskResult; note: string }> {
    let file: string | null = null;
    try {
      file = input.agentSessionId === undefined ? null : await opts.locate(input.cwd, input.agentSessionId);
    } catch {
      file = null;
    }
    const condensed = file === null ? null : await condense(file);
    const turns = condensed === null
      ? (file === null ? 'no file' : 'unreadable file')
      : `turns ${String(condensed.turns)}, omitted ${String(condensed.omittedTurns)}`;
    if (entry.stopped !== null) {
      return { result: { kind: 'dropped', why: entry.stopped }, note: `${turns}, before start` };
    }
    const outcome = await opts.cli.ask({
      sessionId: input.sessionId, system: buildSystem(condensed?.text ?? ''), question: input.question,
      signal: entry.controller.signal,
    });
    const limit = outcome.limit.utilization === null ? '' : `, limit ${String(outcome.limit.utilization)}`;
    const timing = `${String(outcome.ms)} ms, ${turns}${limit}`;
    if (entry.stopped !== null) {
      return { result: { kind: 'dropped', why: entry.stopped }, note: `${timing}, process killed` };
    }
    if (!outcome.ok) {
      const refusal = outcome.code === 'aborted' ? null : REFUSALS[outcome.code];
      return refusal === null
        ? { result: { kind: 'dropped', why: 'closed' }, note: `${timing}, ${outcome.reason}` }
        : { result: { kind: 'refused', ...refusal }, note: `${timing}, ${outcome.reason}` };
    }
    const parsed = parseAnswer(outcome.text);
    if (parsed.answer === '') {
      return { result: { kind: 'refused', ...REFUSALS['companion-cli'] }, note: `${timing}, empty answer` };
    }
    return {
      result: {
        kind: 'answer',
        body: { answer: parsed.answer, found: parsed.found, ...(parsed.prompt === '' ? {} : { prompt: parsed.prompt }) },
      },
      note: `${timing}, ${parsed.wellFormed ? 'well-formed' : 'not well-formed'}`,
    };
  }

  const describe = (result: CompanionAskResult): string => {
    if (result.kind === 'answer') return result.body.found ? 'answer (found)' : 'answer (not found)';
    return result.kind === 'refused' ? result.error : result.why;
  };

  return {
    get running() {
      return inFlight.size;
    },

    async closeAll() {
      for (const entry of inFlight.values()) stop(entry, 'closed');
      await Promise.allSettled([...pending]);
    },

    closeOwner(owner) {
      let stopped = 0;
      for (const entry of inFlight.values()) if (entry.owner === owner && stop(entry, 'revoked')) stopped += 1;
      return stopped;
    },

    conversationChanged(sessionId, agentSessionId) {
      const entry = inFlight.get(sessionId);
      return entry !== undefined && entry.agentSessionId !== agentSessionId && stop(entry, 'conversation') ? 1 : 0;
    },

    ask(input) {
      if (inFlight.has(input.sessionId) || inFlight.size >= maxInFlight) {
        opts.log(`companion: session ${input.sessionId} → ${COMPANION_BUSY_ERROR} (in flight: ${String(inFlight.size)})`);
        return Promise.resolve(BUSY);
      }
      // Registered before the first `await`: a revocation or `/clear` from now on reaches this question.
      const entry: InFlight = {
        owner: input.owner, agentSessionId: input.agentSessionId, controller: new AbortController(), stopped: null,
      };
      inFlight.set(input.sessionId, entry);
      const onClosed = (): void => { stop(entry, 'closed'); };
      input.signal?.addEventListener('abort', onClosed, { once: true });
      if (input.signal?.aborted === true) onClosed();
      const work = (async () => {
        try {
          const { result, note } = await run(input, entry);
          opts.log(`companion: session ${input.sessionId} → ${describe(result)} (${note})`);
          return result;
        } finally {
          input.signal?.removeEventListener('abort', onClosed);
          inFlight.delete(input.sessionId);
        }
      })();
      pending.add(work);
      void work.finally(() => { pending.delete(work); }).catch(() => undefined);
      return work;
    },
  };
}

export interface CompanionAssembly {
  /**
   * `companionEnabled` (`RAROG_COMPANION=1`, never in demo); `dataDir`, under which the calls' working directories
   * live (`<dataDir>/companion-cwd/`); `companionEnvBase`, the start environment cut to the closed list.
   */
  readonly config: Pick<RarogConfig, 'companionEnabled' | 'dataDir' | 'companionEnvBase'>;
  /** Source of engine conversation changes (`/clear`, `/resume` in the pane). */
  readonly manager: { onConversationChange(cb: (sessionId: string, agentSessionId: string) => void): () => void };
  readonly log: (line: string) => void;
}

/**
 * The voice agent of the server process (`index.ts`): the real `claude -p`, conversation files from the Claude Code
 * store, and a new engine conversation of a session killing a question about the previous one. `undefined` = the
 * flag is off (or demo mode): the router answers 503 `companion-disabled` and `companionEnabled: false`.
 */
export function assembleCompanion(opts: CompanionAssembly): CompanionFeature | undefined {
  const { companionEnabled, dataDir, companionEnvBase } = opts.config;
  if (!companionEnabled) return undefined;
  const feature = createCompanionFeature({
    cli: createCompanionCli({ cwdRoot: join(dataDir, COMPANION_CWD_DIR), env: companionEnvBase }),
    locate: (cwd, agentSessionId) => locateTranscript(defaultStoreRoot(), cwd, agentSessionId),
    log: opts.log,
  });
  opts.manager.onConversationChange((sessionId, agentSessionId) => {
    feature.conversationChanged(sessionId, agentSessionId);
  });
  return feature;
}
