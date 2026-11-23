/**
 * Voice agent — public entry of `server/src/companion/`: what the server side of the voice agent knows about a Claude
 * Code session, how it asks the model about it and how it gives the mode across sessions the last turns of a session.
 * Description and procedure after a Claude Code update: `docs/companion.md`.
 *
 * Module map:
 *
 * - `ask.ts` — one question behind `POST /api/sessions/:id/companion/ask`: conversation file, condensing,
 *   `claude -p`, answer or refusal; questions in flight with their owner, killed on a closed request, a revoked
 *   device or a new engine conversation (`createCompanionFeature`; the server process uses `assembleCompanion`).
 * - `condense.ts` — conversation file → text of turns for the model, read as a stream with a byte ceiling, fitted
 *   into a character budget with notes about what was omitted (`condenseFile`, `condenseLines`).
 * - `cli.ts` — one `claude -p` call: argv, closed env, empty working directory, ceilings, in-flight rule, limit
 *   from `rate_limit_event` (`createCompanionCli`, `readRateLimit`). The only place that starts print mode.
 * - `cli-literals.ts` — registry of Claude Code literals the voice agent depends on (flags, model alias, events,
 *   limit fields, the interruption entry), each with its CLI version and measurement date.
 * - `prompt.ts` — the model's instruction, system prompt and message, parser of the answer (`buildSystem`,
 *   `buildMessage`, `parseAnswer`).
 * - `mask.ts` — mask of common secret shapes (`maskSecrets`), the same table as the app's projection.
 * - `openai-token.ts` — the server's OpenAI key traded for a short-lived Realtime key behind
 *   `POST /api/companion/token` (`createCompanionTokenMinter`): pinned endpoint, 60 s lifetime, model from the
 *   config, shared throttle, no redirect, no key in the log.
 * - `turns.ts` — the last 1–3 turns of one session behind `GET /api/sessions/:id/companion/turns`: the tail of the
 *   current engine conversation's file through the steps of the session's history (`herdr/history-steps.ts`), cut at
 *   the app's turn boundary (`createCompanionTurns`; the server process uses `assembleCompanionTurns`).
 * - `turns-settle.ts` — the read of the turns route that holds against a new engine conversation during the read: the
 *   session taken again after each read, at most three reads (`readSettledTurns`).
 * - `conversation.ts` — opaque token of a session's engine conversation (`conversationToken`): HMAC under a key drawn
 *   at server start, so it changes with the conversation and with every restart.
 * - `catalog.ts` — the session catalog behind `GET /api/companion/sessions`: one row per session in the voice agent's
 *   scope, from the server's memory (`companionCatalog`).
 * - `asks-owner.ts` — whether an agent message asks the owner: the app's rule for its question block, on the top-level
 *   blocks of each text block (`messageAsksOwner`, `textAsksOwner`).
 * - `index.ts` — this entry.
 */
export { assembleCompanion, createCompanionFeature } from './ask.ts';
export type {
  CompanionAskInput, CompanionAskResult, CompanionAssembly, CompanionFeature, CompanionFeatureOptions, CompanionRefusal,
  CompanionTarget,
} from './ask.ts';
export {
  COMPANION_CWD_DIR, COMPANION_TIMEOUT_MS, MAX_IN_FLIGHT, OUTPUT_CAP_BYTES, buildArgv, companionEnv, createCompanionCli,
  readRateLimit,
} from './cli.ts';
export type {
  AskOutcome, AskRequest, CompanionCli, CompanionCliOptions, CompanionFailure, RateLimitState,
} from './cli.ts';
export { MAX_CONDENSE_BYTES, MAX_CONDENSE_CHARS, condenseFile, condenseLines } from './condense.ts';
export type { CondenseOptions, CondensedTranscript } from './condense.ts';
export { SECRET_MASK, maskSecrets } from './mask.ts';
export {
  COMPANION_TOKEN_EXPIRES_IN_SECONDS, COMPANION_TOKEN_TIMEOUT_MS, OPENAI_CLIENT_SECRETS_URL, createCompanionTokenMinter,
} from './openai-token.ts';
export type {
  CompanionTokenFetch, CompanionTokenMinter, CompanionTokenMinterOptions, CompanionTokenRefusal, CompanionTokenResult,
} from './openai-token.ts';
export { MAX_QUESTION_CHARS, buildMessage, buildSystem, parseAnswer } from './prompt.ts';
export type { CompanionAnswer } from './prompt.ts';
export {
  TURNS_FIRST_WINDOW, assembleCompanionTurns, createCompanionTurns, isTurnStart, lastTurns,
} from './turns.ts';
export type { CompanionTurnsOptions, CompanionTurnsReader, CompanionTurnsTarget } from './turns.ts';
export { TURNS_MAX_READS, readSettledTurns } from './turns-settle.ts';
export type { SettledTurns, TurnsTake } from './turns-settle.ts';
export { CONVERSATION_TOKEN_CHARS, conversationToken, conversationTokens } from './conversation.ts';
export { companionCatalog } from './catalog.ts';
export type { CompanionCatalogPort, CompanionEntry } from './catalog.ts';
export { ASKS_OWNER_MARKERS, messageAsksOwner, textAsksOwner } from './asks-owner.ts';
