/**
 * Consent channel of the `rarog-pending.mjs` hook (layer 1): registering the secret, claiming the answer file, the
 * signature and the decision for the CLI.
 *
 * On a main-thread `PermissionRequest` in mode `main` (or any request in `all`) the hook draws a secret, registers
 * it on the socket `<dataDir>/run/consent.sock` ({@link registerConsent}) and waits for the file
 * `<dataDir>/consent/<session>/<key>.json` ({@link waitForConsent}). The server writes this file after the decision
 * from the device and signs it with HMAC-SHA256 using this secret. The hook first CLAIMS the file (`rename` to
 * `<key>.claimed`), and only then reads the claimed content and verifies it ({@link verifyConsentFile}): swapping the
 * file between the server's write and the claim cannot get through, because nobody reads it before `rename`. An
 * invalid file goes by `rename` to `<key>.<n>.rejected`, and the wait goes on. A valid file gives `allow`, a bare
 * `deny` with a text from the {@link CONSENT_REASONS} list, or silence (`release`): {@link consentOutput}.
 *
 * "Always" (`allow-always`): `allow` with `updatedPermissions` equal to the `permission_suggestions` of the
 * hook's OWN stdin, never a list from the file. The file carries only the digest of that list
 * (`permissionsSha256`, signed); the hook accepts it only when the digest is the digest of its own list and the list
 * is on the closed list ({@link alwaysAllowed}), else the file is invalid (`permissions`).
 *
 * A valid `allow` goes to the CLI only after the server confirms the receipt ({@link confirmConsent}, `POST`
 * {@link CLAIM_ROUTE} with {@link receiptMac}): the server confirms only the record's live `allow` with the file's
 * `at`, so a copy of an old `allow` (a restored `.revoked`, a file put back after a revoke) gives nothing. `deny`
 * and `release` need no receipt.
 *
 * Everything that goes into the signature is fixed explicitly and computed the same way as in the server
 * (`server/src/herdr/dialogs/layer1/sign.ts`): the message is {@link MAC_PREFIX} and the {@link MAC_FIELDS} fields
 * joined with `|`, the HMAC key is the secret's bytes, `mac` is compared in constant time, and the file has exactly
 * the contract's fields (a `message` field or any other unknown one makes it invalid). The contract values stand here
 * as literals, because the hook does not import TypeScript; `server/test/hook-contract.test.ts` checks they equal
 * `server/src/herdr/dialogs/layer1/contract.ts`, and the server's signature vectors
 * (`server/test/fixtures/hook-kanon/podpis.json`) go through this module in `server/test/hook-channel.test.ts`.
 *
 * Restart break ({@link restartBreak}, {@link waitThroughRestart}): a hook that starts while the server restarts (the
 * old server's `stop` or the new one's `phase: "starting"` in `alive.json`) waits for the next server's channel
 * until `stop.ts + graceMs` instead of taking the shadow path. During the break it registers nothing, takes no file
 * and decides nothing; the hook goes on by `alive.json` when the channel opens, when a server settles without it for
 * this request, or, at the end of the break, exits without a decision.
 *
 * A registered hook that sees such a break while it waits ({@link waitResuming}) pauses the same way: it takes no
 * file, and once the next server opens the channel it registers again with the same body and secret. Only an answer
 * `resumed` from a new server lets it wait on, under the new `bootId`; any other answer, the end of the break or 2G of
 * pauses together end it without a decision.
 *
 * The secret lives only in the hook process's memory and in the registration body: never in argv, env, the dump, a
 * log, a file or on stdout/stderr.
 *
 * Every error path ends WITHOUT a decision (the dialog stays at the desk): no socket, refusal, deadline, invalid
 * file, exception. The module lies in the hook copy (`HOOK_INSTALL_FILES`); the hook loads it dynamically in `try`, so
 * a missing or broken module means "no channel". Imports: only `node:` and `./canon.mjs`.
 */
import { constants, closeSync, fstatSync, openSync, readSync, renameSync } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { request } from 'node:http';
import { join } from 'node:path';
import { canonicalSha256 } from './canon.mjs';

/** `dataDir` subdirectory with the answer files: `CONSENT_DIRNAME` in the layer 1 contract. */
export const CONSENT_DIR = 'consent';

/** Suffix of a file claimed by the hook: `CONSENT_CLAIMED_SUFFIX`. */
export const CLAIMED_SUFFIX = '.claimed';

/** Suffix of a claimed invalid file, `<key>.<n>.rejected`: `CONSENT_REJECTED_SUFFIX`. */
export const REJECTED_SUFFIX = '.rejected';

/** Socket directory under `dataDir`: `ADMIN_RUN_DIRNAME` in `server/src/auth/admin.ts`. */
export const RUN_DIR = 'run';

/** Registration socket: `CONSENT_SOCKET_FILENAME`. */
export const SOCKET_FILE = 'consent.sock';

/** Registration route on the socket: `CONSENT_REGISTER_ROUTE`. */
export const REGISTER_ROUTE = '/register';

/** Receipt route of the registration socket — `CONSENT_CLAIM_ROUTE`. */
export const CLAIM_ROUTE = '/claim';

/** Deadline of the `/claim` answer in ms — `CONSENT_CLAIM_DEADLINE_MS`. After it the hook gives no `allow`. */
export const CLAIM_DEADLINE_MS = 500;

/**
 * Response deadline of the registration socket in ms: `CONSENT_REGISTER_DEADLINE_MS`. After it the hook does not wait.
 */
export const REGISTER_DEADLINE_MS = 500;

/** Cap on the registration socket's response (the response has a few dozen bytes). */
const REGISTER_RESPONSE_MAX_BYTES = 4096;

/** Secret length in bytes: `CONSENT_SECRET_BYTES`; hex in the registration body. */
export const SECRET_BYTES = 32;

/** Domain prefix of the signature: `CONSENT_MAC_PREFIX`. */
export const MAC_PREFIX = 'rarog-consent-v1|';

/** File fields in the signature message, in this order: `CONSENT_MAC_FIELDS`. */
export const MAC_FIELDS = ['sessionId', 'key', 'decision', 'reasonId', 'inputSha256', 'cardSha256', 'at'];

/** Fields of an `allow-always` file in the signature, in this order — `CONSENT_ALWAYS_MAC_FIELDS`. */
export const ALWAYS_MAC_FIELDS = [...MAC_FIELDS, 'permissionsSha256'];

/**
 * Version of the "always" file this hook knows — `CONSENT_ALWAYS_VERSION` in `layer1/always.ts`. The registration
 * carries it (`alwaysVersion`) together with `permissionSuggestions`.
 */
export const ALWAYS_VERSION = 1;

/** Domain prefix of the receipt signature — `CONSENT_RECEIPT_MAC_PREFIX`; differs from {@link MAC_PREFIX}. */
export const RECEIPT_MAC_PREFIX = 'rarog-consent-receipt-v1|';

/** Fields of the receipt signature, in this order — `CONSENT_RECEIPT_MAC_FIELDS`. */
export const RECEIPT_MAC_FIELDS = ['sessionId', 'key', 'at'];

/** `notBefore` margin before the registration moment: `CONSENT_NOT_BEFORE_MARGIN_MS` in `layer1/sign.ts`. */
export const NOT_BEFORE_MARGIN_MS = 60000;

/** Read cap of a claimed file (a signed file has a few hundred bytes); larger = invalid file. */
const CLAIMED_MAX_BYTES = 64 * 1024;

/**
 * The `message` text of a bare `deny` from the phone, for the model: `CONSENT_DENY_MESSAGE`. The answer file carries
 * only the `reasonId`, never text, so the model gets only text from this list.
 */
export const DENY_MESSAGE = 'The user denied this from the phone. Stop and wait for the user\'s message.';

/**
 * Closed list of `reasonId`: the decision the reason belongs to, and the `message` text: `CONSENT_REASONS`.
 */
export const CONSENT_REASONS = Object.freeze({
  'allow': Object.freeze({ decision: 'allow', message: null }),
  'allow-always': Object.freeze({ decision: 'allow', message: null }),
  'phone-deny': Object.freeze({ decision: 'deny', message: DENY_MESSAGE }),
  'phone-deny-siblings': Object.freeze({ decision: 'deny', message: DENY_MESSAGE }),
  'release': Object.freeze({ decision: 'release', message: null }),
});

/**
 * Reasons {@link verifyConsentFile} rejects a file, in checking order: `CONSENT_VERIFY_FAILURES`
 * in `layer1/sign.ts`. `input` and `card` are a card mismatch, the rest a signature mismatch.
 */
export const VERIFY_FAILURES = ['shape', 'message', 'mac', 'binding', 'input', 'card', 'permissions', 'stale'];

/** The tool to which `allow` gives the stdin input in `updatedInput` (the CLI requires it for a plan). */
export const PLAN_TOOL = 'ExitPlanMode';

/**
 * Ceiling of `permission_suggestions` the hook carries, as compact JSON in UTF-8 bytes — `HOOK_SUGGESTIONS_MAX_BYTES`
 * in `hook/suggestions.ts`. It keeps the registration body under the socket's ceiling.
 */
export const SUGGESTIONS_MAX_BYTES = 16 * 1024;

const MAC_SEPARATOR = '|';
const SECRET_HEX = /^[0-9a-f]{64}$/;
const DIGEST_HEX = /^[0-9a-f]{64}$/;
const FILE_FIELDS = [...MAC_FIELDS, 'mac'];
const ALWAYS_FILE_FIELDS = [...ALWAYS_MAC_FIELDS, 'mac'];
const ALWAYS_REASON = 'allow-always';

/** Closed list of "always" (`layer1/always.ts`): rule destinations and the identifier pattern of a tool name. */
const ALWAYS_RULE_DESTINATIONS = ['session', 'localSettings'];
const ALWAYS_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const ALWAYS_ITEMS_MAX = 16;

const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => Object.keys(value).length === keys.length
  && keys.every((name) => Object.hasOwn(value, name));
const nonEmptyText = (value) => typeof value === 'string' && value !== '';
const itemsOf = (value, valid) => Array.isArray(value) && value.length >= 1 && value.length <= ALWAYS_ITEMS_MAX
  && value.every(valid);

/** One rule of an `addRules` entry: `toolName` and an optional non-empty `ruleContent`, nothing else. */
function alwaysRule(rule) {
  if (!plainObject(rule) || typeof rule.toolName !== 'string' || !ALWAYS_TOOL_NAME.test(rule.toolName)) return false;
  return Object.hasOwn(rule, 'ruleContent')
    ? exactKeys(rule, ['toolName', 'ruleContent']) && nonEmptyText(rule.ruleContent)
    : exactKeys(rule, ['toolName']);
}

/**
 * One entry of the closed list: `addRules` allow in `session` or `localSettings`, `setMode acceptEdits` in `session`,
 * `addDirectories` in `session`.
 */
function alwaysEntry(entry) {
  if (!plainObject(entry)) return false;
  switch (entry.type) {
    case 'addRules':
      return exactKeys(entry, ['type', 'rules', 'behavior', 'destination']) && entry.behavior === 'allow'
        && ALWAYS_RULE_DESTINATIONS.includes(entry.destination) && itemsOf(entry.rules, alwaysRule);
    case 'setMode':
      return exactKeys(entry, ['type', 'mode', 'destination']) && entry.mode === 'acceptEdits'
        && entry.destination === 'session';
    case 'addDirectories':
      return exactKeys(entry, ['type', 'directories', 'destination']) && entry.destination === 'session'
        && itemsOf(entry.directories, nonEmptyText);
    default:
      return false;
  }
}

/**
 * Whether `permission_suggestions` from stdin may go out as `updatedPermissions`: a non-empty list of at most 16
 * entries, every entry exactly in a shape of the closed list. Anything else = no "always".
 */
export function alwaysAllowed(suggestions) {
  return itemsOf(suggestions, alwaysEntry);
}

/** Digest of the hook's own updates for {@link verifyConsentFile}: canonical sha256; `null` outside the closed list. */
export function alwaysDigest(suggestions) {
  return alwaysAllowed(suggestions) ? canonicalSha256(suggestions) : null;
}

/**
 * `permission_suggestions` from stdin as the registration and the per-call dump carry it: the value as it is up to
 * {@link SUGGESTIONS_MAX_BYTES}, `undefined` without the field, over the ceiling or when it does not serialize (the
 * request goes on as without suggestions). Data only: nothing in the hook decides on it, and the server checks it by
 * its own schema.
 */
export function carriedSuggestions(value) {
  if (value === undefined) return undefined;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > SUGGESTIONS_MAX_BYTES) return undefined;
  return value;
}

/** New secret: {@link SECRET_BYTES} random bytes as lowercase hex. */
export function newSecret() {
  return randomBytes(SECRET_BYTES).toString('hex');
}

/**
 * `cardSha256`: sha256 of the canonical form of the card fields (`canon.mjs`). A missing `agentId` or `permissionMode`
 * counts as `null`, extra fields do not go in: like the server's `consentCardSha256`.
 */
export function cardSha256(card) {
  return canonicalSha256({
    sessionId: card.sessionId, toolName: card.toolName, toolInput: card.toolInput, cwd: card.cwd,
    agentId: card.agentId ?? null, permissionMode: card.permissionMode ?? null,
  });
}

const isReasonId = (value) => typeof value === 'string' && Object.hasOwn(CONSENT_REASONS, value);
const isPlainText = (value) => typeof value === 'string' && value !== '' && !value.includes(MAC_SEPARATOR);

/** Whether the fields fit the signature contract; `decision` must be the one from `reasonId`. */
function signedFieldsValid(fields) {
  const { sessionId, key, decision, reasonId, inputSha256, cardSha256: card, at, permissionsSha256 } = fields;
  if (reasonId === ALWAYS_REASON ? typeof permissionsSha256 !== 'string' || !DIGEST_HEX.test(permissionsSha256)
    : permissionsSha256 !== undefined) return false;
  return isPlainText(sessionId) && isPlainText(key)
    && isReasonId(reasonId) && CONSENT_REASONS[reasonId].decision === decision
    && typeof inputSha256 === 'string' && DIGEST_HEX.test(inputSha256)
    && typeof card === 'string' && DIGEST_HEX.test(card)
    && typeof at === 'number' && Number.isSafeInteger(at) && at >= 0;
}

/** Signature message. Fields outside the contract throw `TypeError`. */
export function macMessage(fields) {
  if (!signedFieldsValid(fields)) throw new TypeError('answer file fields outside the signature contract');
  const names = fields.reasonId === ALWAYS_REASON ? ALWAYS_MAC_FIELDS : MAC_FIELDS;
  return MAC_PREFIX + names.map((name) => String(fields[name])).join(MAC_SEPARATOR);
}

function macOf(secret, fields) {
  if (typeof secret !== 'string' || !SECRET_HEX.test(secret)) {
    throw new TypeError('the consent secret is 32 bytes as lowercase hex');
  }
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(macMessage(fields), 'utf8').digest();
}

/** Signature of the fields (hex). Only the test uses it: the hook computes the signature only to verify. */
export function signFields(secret, fields) {
  return macOf(secret, fields).toString('hex');
}

/**
 * Receipt signature (hex) for `POST /claim`: HMAC-SHA256 with the secret over {@link RECEIPT_MAC_PREFIX} and
 * {@link RECEIPT_MAC_FIELDS} joined with `|`, as `consentReceiptMac` in `layer1/sign.ts`. Fields outside the
 * contract throw `TypeError`.
 */
export function receiptMac(secret, fields) {
  if (typeof secret !== 'string' || !SECRET_HEX.test(secret)) {
    throw new TypeError('the consent secret is 32 bytes as lowercase hex');
  }
  const { sessionId, key, at } = fields;
  if (!isPlainText(sessionId) || !isPlainText(key) || typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) {
    throw new TypeError('receipt fields outside the signature contract');
  }
  const message = RECEIPT_MAC_PREFIX + RECEIPT_MAC_FIELDS.map((name) => String(fields[name])).join(MAC_SEPARATOR);
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(message, 'utf8').digest('hex');
}

/**
 * Verification of a claimed file after `JSON.parse`, in {@link VERIFY_FAILURES} order: `{ok: true, file}` (a copy
 * of the contract fields only) or `{ok: false, reason}`. `expected` is what the hook knows by itself: secret, session,
 * key, digests from stdin, `notBefore` and `permissionsSha256` ({@link alwaysDigest} of its stdin; `null` = no
 * `allow-always` valid).
 */
export function verifyConsentFile(raw, expected) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'shape' };
  if (Object.hasOwn(raw, 'message')) return { ok: false, reason: 'message' };
  const names = Object.keys(raw);
  const shape = raw['reasonId'] === ALWAYS_REASON ? ALWAYS_FILE_FIELDS : FILE_FIELDS;
  if (names.length !== shape.length || !shape.every((name) => Object.hasOwn(raw, name))) {
    return { ok: false, reason: 'shape' };
  }
  const mac = raw['mac'];
  if (!signedFieldsValid(raw) || typeof mac !== 'string' || !DIGEST_HEX.test(mac)) {
    return { ok: false, reason: 'shape' };
  }
  if (!timingSafeEqual(macOf(expected.secret, raw), Buffer.from(mac, 'hex'))) return { ok: false, reason: 'mac' };
  if (raw['sessionId'] !== expected.sessionId || raw['key'] !== expected.key) return { ok: false, reason: 'binding' };
  if (raw['inputSha256'] !== expected.inputSha256) return { ok: false, reason: 'input' };
  if (raw['cardSha256'] !== expected.cardSha256) return { ok: false, reason: 'card' };
  if (raw['reasonId'] === ALWAYS_REASON && raw['permissionsSha256'] !== (expected.permissionsSha256 ?? null)) {
    return { ok: false, reason: 'permissions' };
  }
  if (raw['at'] < expected.notBefore) return { ok: false, reason: 'stale' };
  const file = {};
  for (const name of shape) file[name] = raw[name];
  return { ok: true, file };
}

/** Path of the registration socket under the data directory. */
export function socketPathOf(dataDir) {
  return join(dataDir, RUN_DIR, SOCKET_FILE);
}

/** `phase` of a server process while it starts — `HOOK_ALIVE_PHASE_STARTING`. */
export const PHASE_STARTING = 'starting';

/** G when the hook sees only {@link PHASE_STARTING}, no `stop` of the old server — `HOOK_RESTART_GRACE_DEFAULT_MS`. */
export const RESTART_GRACE_DEFAULT_MS = 45000;

/** Ceiling of `stop.graceMs`; a larger value means no break — `HOOK_RESTART_GRACE_MAX_MS`. */
export const RESTART_GRACE_MAX_MS = 600000;

/**
 * The restart break a hook sees in `alive.json` at its start: `{until, cause}` or `null` (no break). `read` is the
 * hook's read of the file (`readAlive` in `rarog-pending.mjs`): `seen.aliveTs` is the file's `ts`, `restart` its raw
 * `stop` and `phase`, also on a stale file. `stop: {ts, graceMs}` (a normal stop of the old server, `graceMs` a whole
 * number from 1 to {@link RESTART_GRACE_MAX_MS}) lasts until `stop.ts + graceMs`; else `phase: "starting"` (the new
 * server while it starts) until the file's `ts` plus {@link RESTART_GRACE_DEFAULT_MS}. Either way at
 * most G from `now` (a server clock ahead does not stretch it), and only while that moment is ahead. A `stop` outside
 * that shape is no break.
 */
export function restartBreak(read, now) {
  const found = breakOf(read);
  if (found === null) return null;
  const until = Math.min(found.anchor + found.grace, now + found.grace);
  return until > now ? { until, cause: found.cause } : null;
}

/** The break fields of a read as {@link restartBreak} takes them: `{anchor, grace, cause}`, or `null` for no break. */
function breakOf(read) {
  const { stop, phase } = read?.restart ?? {};
  if (stop !== undefined) {
    if (!plainObject(stop) || !Number.isSafeInteger(stop.ts) || !Number.isSafeInteger(stop.graceMs)
      || stop.graceMs < 1 || stop.graceMs > RESTART_GRACE_MAX_MS) return null;
    return { anchor: stop.ts, grace: stop.graceMs, cause: 'stop' };
  }
  if (phase === PHASE_STARTING && typeof read.seen?.aliveTs === 'number') {
    return { anchor: read.seen.aliveTs, grace: RESTART_GRACE_DEFAULT_MS, cause: 'starting' };
  }
  return null;
}

/**
 * `alive.json` during the break, from the hook's read (as in {@link restartBreak}) and `channel(alive)`, the hook's
 * rule whether the file's mode opens the channel for this request:
 * - `open` — a fresh file with `send: true`, a channel mode and the session on the list;
 * - `wait` — no file, a bad or stale file, `stop` or `phase: "starting"`, or a channel mode with `send: true` whose
 *   list does not have the session yet (the list grows after the start);
 * - `settled` — anything else: a fresh file without the break whose server does not open the channel for this request
 *   (`off` of `rarog dialogs off`, `shadow`, `send: false`, `main` for a subagent). The hook goes on as without it.
 */
export function breakState(read, sessionId, channel) {
  if (read.veto !== null) return 'wait';
  const opens = read.alive.send === true && channel(read.alive);
  if (opens && read.alive.sessions.includes(sessionId)) return 'open';
  const { stop, phase } = read.restart ?? {};
  return stop !== undefined || phase === PHASE_STARTING || opens ? 'wait' : 'settled';
}

/**
 * Waits through the restart break the hook saw at its start (`first`, {@link restartBreak}): every `pollMs` it reads
 * `alive.json` again (`read()`) until {@link breakState} is `open` or `settled`, or the break ends. Calls
 * `onPause({...first.seen, szczegol: cause})` once, when it starts waiting. Result `{outcome}`: `none` (no break, or
 * the file already says `open` or `settled`), `open`, `settled` or `expired`. Never claims, registers or decides.
 *
 * The grace left is taken once from the wall clock (`now`, `until - now()` at the start); the wait spends it on the
 * monotonic clock (`monotonic`), so a wall clock set back does not stretch the CLI's block past G. The wall clock still
 * ends the break once it passes `until`: the monotonic clock stands while the machine sleeps. After every sleep the
 * deadline comes before the read: a hook woken past it is `expired` whatever the file says.
 */
export async function waitThroughRestart(options) {
  const { first, read, sessionId, channel, pollMs, onPause } = options;
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  const startedAt = now();
  const startedMono = monotonic();
  const pause = restartBreak(first, startedAt);
  if (pause === null || breakState(first, sessionId, channel) !== 'wait') return { outcome: 'none' };
  const grace = pause.until - startedAt;
  const left = () => Math.min(grace - (monotonic() - startedMono), pause.until - now());
  onPause?.({ ...first.seen, szczegol: pause.cause });
  for (;;) {
    if (left() <= 0) return { outcome: 'expired' };
    await sleep(Math.min(pollMs, Math.max(0, left())));
    if (left() <= 0) return { outcome: 'expired' };
    const state = breakState(read(), sessionId, channel);
    if (state !== 'wait') return { outcome: state };
  }
}

/** Refusals of a registration in a pause that mean "try again at the next poll": the channel is still opening. */
const RESUME_RETRY_DETAILS = new Set(['503', 'socket', 'deadline', 'response']);

/** The `powod` of the `--answer-wait` ceiling (`HOOK_SHADOW_REASONS` of the hook contract). */
const CEILING = 'sufit';

/**
 * The wait of a registered hook for its answer file ({@link waitForConsent}), through server restarts. Before every
 * claim: the ceiling (`deadline`, wall clock ms) gives `sufit`, then `veto(bootId, read)` checks one read of
 * `alive.json` (`read()`) against the `bootId` the hook is registered under (`null` = wait on). A veto whose own read
 * shows a restart break ({@link restartBreak}) opens a pause instead of ending the wait; any other veto ends it as it
 * is. In a pause the hook takes no file and every `pollMs` reads `alive.json` again ({@link breakState}):
 * - `open` — it registers again with the same body (`register(deadlineMs)`, {@link registerConsent}), with at most
 *   the time left of the pause and before the ceiling. An answer `resumed` from a server with another `bootId` ends
 *   the pause: the wait goes on under that `bootId`. An answer under the `bootId` the hook already has (the old
 *   server's socket) and the refusals of a channel still opening (503, no socket, the deadline) are tried again at the
 *   next poll. Any other answer (409, accepted without `resumed`) ends the wait, `restart` with the HTTP status or
 *   `accepted` in `szczegol`. An answer that comes past the ceiling or the end of the pause is not taken;
 * - `settled` — a server without the channel for this request: the wait ends with `veto(bootId, read)`;
 * - `wait` — the pause goes on; a second restart inside it does not lengthen it.
 * A pause lasts until the end of its break and the pauses of one wait last 2G together, G of the first break; past
 * either the wait ends with `przerwa`. The time is spent on the monotonic clock as in {@link waitThroughRestart}.
 * `onLine(ev, fields)` gets `pauza` at the start of every pause and `czekam` after every resumed registration, with
 * `bootId` and `aliveTs` of the file read. Result: as {@link waitForConsent}; the `alive` fields of an exit from a
 * pause carry the file read and, for `restart`, `szczegol`.
 */
export async function waitResuming(options) {
  const { veto, read, onLine } = options;
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const ceiling = () => (now() >= options.deadline ? { powod: CEILING } : null);
  let bootId = options.bootId;
  let budget = null;
  for (;;) {
    let first = null;
    const exit = await waitForConsent({
      ...options,
      veto: () => {
        const over = ceiling();
        if (over !== null) return over;
        first = read();
        return veto(bootId, first);
      },
    });
    if (exit.outcome === 'claimed' || exit.powod === CEILING) return exit;
    const startedAt = now();
    const pause = restartBreak(first, startedAt);
    if (pause === null) return exit;
    budget ??= 2 * breakOf(first).grace;
    const startedMono = monotonic();
    const grace = Math.min(pause.until - startedAt, budget);
    const left = () => Math.min(grace - (monotonic() - startedMono), pause.until - now());
    onLine?.('pauza', { ...first.seen, szczegol: pause.cause });
    const end = await pauseForResume({ ...options, first, bootId, ceiling, left });
    budget -= monotonic() - startedMono;
    if (end.bootId === undefined) return { outcome: 'veto', ...end };
    bootId = end.bootId;
  }
}

/**
 * One pause of {@link waitResuming}: `{bootId}` of the server that resumed the registration, or the exit fields.
 * `left()` is the time left of the pause; it comes before every read, so a hook woken past it reads nothing more.
 */
async function pauseForResume(options) {
  const { first, bootId, ceiling, left, read, register, sessionId, channel, pollMs, veto, onLine } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  let current = first;
  // The ceiling, then the time left of the pause: an answer that comes past either is not taken.
  const ended = () => ceiling() ?? (left() <= 0 ? { powod: 'przerwa', alive: current.seen ?? {} } : null);
  for (;;) {
    const over = ended();
    if (over !== null) return over;
    const state = breakState(current, sessionId, channel);
    if (state === 'settled') return veto(bootId, current) ?? { powod: 'restart', alive: current.seen ?? {} };
    if (state === 'open') {
      // The registration gets at most the time left of the pause and before the ceiling.
      const reply = await register(Math.min(REGISTER_DEADLINE_MS, left(), options.deadline - now()));
      const late = ended();
      if (late !== null) return late;
      if (reply.accepted === true && reply.bootId !== bootId) {
        if (reply.resumed !== true) return { powod: 'restart', alive: { ...current.seen, szczegol: 'accepted' } };
        onLine?.('czekam', { ...current.seen, tryb: current.alive.mode });
        return { bootId: reply.bootId };
      }
      if (reply.accepted !== true && !RESUME_RETRY_DETAILS.has(reply.detail)) {
        return { powod: 'restart', alive: { ...current.seen, szczegol: String(reply.detail).slice(0, 64) } };
      }
    }
    await sleep(Math.min(pollMs, Math.max(0, left())));
    if (left() > 0) current = read();
  }
}

/**
 * Registration on the socket: `POST` {@link REGISTER_ROUTE} with the registration body. Result `{accepted: true,
 * bootId}` only on 200 with the body `{accepted: true, bootId: <non-empty string>}`, with `resumed: true` when the body
 * says so (the server took it as the hook's second registration after a restart); any other outcome (no socket,
 * refusal, the {@link REGISTER_DEADLINE_MS} deadline, a bad response) is `{accepted: false, detail}` without the
 * secret. Never rejects the promise.
 */
export function registerConsent(socketPath, body, deadlineMs = REGISTER_DEADLINE_MS) {
  return postSocket(socketPath, REGISTER_ROUTE, body, deadlineMs).then((reply) => {
    if (reply.detail !== undefined) return { accepted: false, detail: reply.detail };
    const { status, parsed } = reply;
    const bootId = parsed !== null && typeof parsed === 'object' ? parsed['bootId'] : undefined;
    if (status === 200 && parsed?.['accepted'] === true && typeof bootId === 'string' && bootId !== '') {
      return { accepted: true, bootId, ...(parsed['resumed'] === true ? { resumed: true } : {}) };
    }
    return { accepted: false, detail: String(status) };
  });
}

/**
 * Receipt on the socket: `POST` {@link CLAIM_ROUTE} with `{key, at, mac}` ({@link receiptMac}). `{confirmed: true}`
 * only on 200 with the body `{confirmed: true}`; any other end (no socket, a server without the route = `404`,
 * a refusal, the deadline {@link CLAIM_DEADLINE_MS}, a bad answer) is `{confirmed: false, detail}`. Never rejects.
 */
export function confirmConsent(socketPath, body, deadlineMs = CLAIM_DEADLINE_MS) {
  return postSocket(socketPath, CLAIM_ROUTE, body, deadlineMs).then((reply) => {
    if (reply.detail !== undefined) return { confirmed: false, detail: reply.detail };
    const { status, parsed } = reply;
    if (status === 200 && parsed !== null && typeof parsed === 'object' && parsed['confirmed'] === true) {
      return { confirmed: true };
    }
    return { confirmed: false, detail: String(status) };
  });
}

/**
 * `POST` of a JSON body to `route` on the socket `socketPath`: `{status, parsed}` after the whole response (`parsed`
 * is `null` when the body is not JSON) or `{detail}`: `socket` (no socket, connection error), `deadline` (after
 * `deadlineMs`), `response` (a response over the ceiling or cut off). Never rejects.
 */
function postSocket(socketPath, route, body, deadlineMs) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        req?.destroy();
      } catch {
        // The connection ends together with the result anyway.
      }
      resolve(result);
    };
    const timer = setTimeout(() => { finish({ detail: 'deadline' }); }, deadlineMs);
    let payload;
    try {
      payload = JSON.stringify(body);
      req = request({
        socketPath, path: route, method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload, 'utf8') },
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > REGISTER_RESPONSE_MAX_BYTES) finish({ detail: 'response' });
          else chunks.push(chunk);
        });
        res.on('error', () => { finish({ detail: 'response' }); });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            parsed = null;
          }
          finish({ status: res.statusCode ?? 0, parsed });
        });
      });
      req.on('error', () => { finish({ detail: 'socket' }); });
      req.end(payload);
    } catch {
      finish({ detail: 'socket' });
    }
  });
}

/**
 * Reads a claimed file: a regular file (without following a symlink, without blocking on a FIFO) up to
 * {@link CLAIMED_MAX_BYTES}. `null` = cannot be read as an answer file.
 */
function readClaimed(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > CLAIMED_MAX_BYTES) return null;
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The end of the process closes the descriptor anyway.
    }
  }
}

/** Disk operations of the claim; the test swaps them to check the order and the race with the server. */
export const NODE_IO = Object.freeze({ rename: renameSync, readClaimed });

/**
 * Claims the answer file `<base>.json` → `<base>.claimed`, then reads the CLAIMED content. `null` = there was no
 * file (or the server managed to revoke it). `{body}` with `body` = `undefined` when the content is not JSON.
 */
export function claimConsentFile(base, io = NODE_IO) {
  const claimed = `${base}${CLAIMED_SUFFIX}`;
  try {
    io.rename(`${base}.json`, claimed);
  } catch {
    return null;
  }
  const text = io.readClaimed(claimed);
  if (text === null) return { body: undefined };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { body: undefined };
  }
}

/** Moves a claimed invalid file aside to `<base>.<n>.rejected`. Best effort: the server sweeps the directory anyway. */
function setAside(base, n, io) {
  try {
    io.rename(`${base}${CLAIMED_SUFFIX}`, `${base}.${String(n)}${REJECTED_SUFFIX}`);
  } catch {
    // The claimed file stays as `.claimed`; the next claim overwrites it.
  }
}

/**
 * Waits for the answer file under `base` (`<dataDir>/consent/<session>/<key>`). Each round: first `veto()`
 * (`null` = keep waiting, otherwise the exit object; the hook also keeps its deadline there), then the claim and the
 * verification. An invalid file goes aside, `onRejected(reason, n)` gets the reason from {@link VERIFY_FAILURES}, and
 * the wait goes on without sleeping (the server may already have the next file). Result: `{outcome: 'claimed', file}`
 * (a valid file; ONLY its content is executed) or `{outcome: 'veto', ...}` with the veto object's fields.
 */
export async function waitForConsent(options) {
  const { base, expected, pollMs, veto, onRejected } = options;
  const io = options.io ?? NODE_IO;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  let rejected = 0;
  for (;;) {
    const stop = veto();
    if (stop !== null) return { outcome: 'veto', ...stop };
    const claim = claimConsentFile(base, io);
    if (claim !== null) {
      const verdict = verifyConsentFile(claim.body, expected);
      if (verdict.ok) return { outcome: 'claimed', file: verdict.file };
      rejected += 1;
      setAside(base, rejected, io);
      onRejected(verdict.reason, rejected);
      continue;
    }
    await sleep(pollMs);
  }
}

/**
 * Hook output for a valid file: an object for stdout or `null` (silence). `allow` without `updatedInput`, except for
 * {@link PLAN_TOOL}, for which `updatedInput` is the stdin input; a bare `deny` with a text from {@link
 * CONSENT_REASONS}; `release` = silence. Never a turn interruption. `allowed: false` (e.g. a subagent's request outside
 * mode `all`) turns `allow` into silence. `allow-always` = `allow` with `updatedPermissions` from `suggestions` (the
 * stdin list) only when {@link alwaysAllowed} holds for it and the tool is not {@link PLAN_TOOL}; otherwise silence.
 */
export function consentOutput(file, { hookEventName, toolName, toolInput, allowed = true, suggestions }) {
  const reason = isReasonId(file?.reasonId) ? CONSENT_REASONS[file.reasonId] : null;
  if (reason === null || reason.decision !== file.decision) return null;
  if (file.reasonId === ALWAYS_REASON) {
    if (!allowed || toolName === PLAN_TOOL || !alwaysAllowed(suggestions)) return null;
    return { hookSpecificOutput: { hookEventName, decision: { behavior: 'allow', updatedPermissions: suggestions } } };
  }
  if (reason.decision === 'allow') {
    if (!allowed) return null;
    return {
      hookSpecificOutput: {
        hookEventName,
        decision: {
          behavior: 'allow',
          ...(toolName === PLAN_TOOL && toolInput !== null && typeof toolInput === 'object'
            ? { updatedInput: toolInput } : {}),
        },
      },
    };
  }
  if (reason.decision === 'deny' && typeof reason.message === 'string') {
    return { hookSpecificOutput: { hookEventName, decision: { behavior: 'deny', message: reason.message } } };
  }
  return null;
}
