/**
 * Rejestr sekretów hooka kanału zgód (warstwa 1). Hook przy `PermissionRequest` rejestruje losowy sekret na
 * gnieździe rejestracji (`auth/consent-socket.ts`) PRZED zapisem zrzutu z kluczem; serwer podpisuje plik odpowiedzi
 * wyłącznie sekretem z tego rejestru.
 *
 * Pamięć procesu, nigdy dysk: restart serwera kasuje wszystkie wpisy. Serwer jest tu władzą, a `alive.json` tylko
 * podpowiedzią dla hooka, więc rejestr sprawdza wszystko sam, w tej kolejności:
 *
 * 1. ciało w kształcie {@link ConsentRegistration} (obce pole, zły klucz, klucz bez prefiksu `promptId`) = 400;
 *    `permissionSuggestions` is data checked by its own schema (`hook/suggestions.ts`): a value outside it is dropped
 *    from the entry and never refuses the body; an `alwaysVersion` other than `CONSENT_ALWAYS_VERSION`
 *    (`always.ts`) = 400;
 * 2. zakres kanału ({@link ConsentRegistryScope}): `closed` = 503 dla każdego, `main` = 503 dla prośby z `agentId`,
 *    `all` przyjmuje obie; killswitch wysyłki i sesja spoza listy obserwowanych = 503;
 * 3. pierwsza rejestracja klucza wygrywa. Powtórka z identycznym ciałem (ten sam sekret, pid, skróty) = przyjęta bez
 *    zmian. Każda inna rejestracja tego klucza blokuje go na stałe (409 `key-blocked`): serwer nie wie, która
 *    pochodzi od hooka, więc nie podpisze pod tym kluczem niczego (fail-closed, karta bez przycisku zgody);
 * 3a. after a restart a key whose recovered record waits for its hook ({@link ConsentRegistry.expectResume},
 *    `resume.ts`) takes its first registration as the hook's second one, for
 *    {@link ConsentRegistryOptions.restartGraceMs}: equal to the record in every call field and the card digest, and
 *    for a record whose answer file is written a secret that verifies that file's signature = accepted with `resumed`;
 *    anything else blocks the key (409 `key-blocked`). The secret itself is never on disk: the hook sends the same one
 *    again, and the server cannot tell it from another secret except by that signature. A resumed registration calls
 *    the expectation's `onResumed` with its time;
 * 4. najwyżej {@link CONSENT_REGISTRATIONS_PER_SESSION_MAX} żywych wpisów na sesję
 *    i {@link CONSENT_REGISTRATIONS_MAX} razem = 429 (a resumed registration was counted by the earlier process).
 *
 * Wpis żyje do śmierci procesu hooka (wołający usuwa go {@link ConsentRegistry.forget}) albo
 * {@link CONSENT_REGISTRATION_TTL_MS} od przyjęcia. Sekret nie wychodzi z rejestru inaczej niż przez
 * {@link ConsentRegistry.secretOf}: odpowiedź, log, widok wpisu i liczniki go nie niosą (tak samo `cardSha256`
 * w odpowiedzi i logu).
 */
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { HOOK_ANSWER_TIMEOUT_S } from '../../hook-config.ts';
import {
  HOOK_CALL_KEY_PATTERN, HOOK_CALL_NONCE_BYTES, HOOK_CHANNEL_MODE_OFF, HOOK_CHANNEL_MODE_SHADOW, consentChannelOpen,
  consentSubagentsOpen,
} from '../hook/contract.ts';
import type { HookChannelMode } from '../hook/contract.ts';
import { parseHookSuggestions } from '../hook/suggestions.ts';
import type { HookSuggestions } from '../hook/suggestions.ts';
import { CONSENT_ALWAYS_VERSION } from './always.ts';
import {
  CONSENT_REGISTRATIONS_MAX, CONSENT_REGISTRATIONS_PER_SESSION_MAX, CONSENT_SECRET_BYTES, CONSENT_TTL_MARGIN_MS,
} from './contract.ts';
import type { ConsentRegisterAccepted, ConsentRegistration, ConsentUnavailable } from './contract.ts';
import { verifyConsentFile } from './sign.ts';

/** Życie wpisu bez śmierci procesu hooka: `timeout` hooka plus zapas, liczone od przyjęcia. */
export const CONSENT_REGISTRATION_TTL_MS = HOOK_ANSWER_TIMEOUT_S * 1000 + CONSENT_TTL_MARGIN_MS;

/**
 * Czy tryb kanału z konfiguracji wymaga rejestracji, czyli czy serwer zakłada rejestr i gniazdo rejestracji.
 * Przy `off` i `shadow` hook nie rejestruje, więc gniazda nie ma: proces z dostępem do gniazd pod `run/` nie dostaje
 * punktu wejścia, z którego nikt nie korzysta. Każdy inny tryb wymaga rejestracji.
 */
export function consentRegistrationWanted(mode: HookChannelMode): boolean {
  return mode !== HOOK_CHANNEL_MODE_OFF && mode !== HOOK_CHANNEL_MODE_SHADOW;
}

/**
 * Zakres kanału w tej chwili, jak go widzi rejestr: `closed` — rejestr odmawia każdej rejestracji (start serwera,
 * tryb efektywny inny niż kanał, wyłącznik); `main` — przyjmuje prośby wątku głównego (bez `agentId`); `all` —
 * przyjmuje także prośby subagentów.
 */
export type ConsentRegistryScope = 'closed' | 'main' | 'all';

/**
 * Zakres rejestru dla trybu efektywnego (`layer1/mode.ts`): `all` przy `all`, `main` przy `main`, każdy inny tryb
 * (także nieznany i `null`) = `closed`. Bramki trybu z `hook/contract.ts`.
 */
export function consentRegistryScopeOf(mode: string | null | undefined): ConsentRegistryScope {
  if (consentSubagentsOpen(mode)) return 'all';
  return consentChannelOpen(mode) ? 'main' : 'closed';
}

/** Odmowy rejestracji i ich kody HTTP. Odpowiedź niesie sam kod odmowy, bez treści ciała. */
export const CONSENT_REGISTER_REFUSALS = {
  /** Ciało nie w kształcie rejestracji. */
  'bad-request': 400,
  /** Klucz zarejestrowany inaczej: zablokowany na stałe. */
  'key-blocked': 409,
  /** Sesja ma już {@link CONSENT_REGISTRATIONS_PER_SESSION_MAX} żywych wpisów. */
  'session-limit': 429,
  /** Rejestr ma już {@link CONSENT_REGISTRATIONS_MAX} żywych wpisów. */
  'global-limit': 429,
  /** Zakres `closed`. */
  'channel-closed': 503,
  /** Prośba subagenta przy zakresie `main` (przy `all` przyjęta). */
  'subagent': 503,
  /** Killswitch wysyłki: serwer nie wysyła decyzji. */
  'send-off': 503,
  /** Sesji nie ma na liście obserwowanych. */
  'session-unknown': 503,
} as const satisfies Readonly<Record<string, 400 | 409 | 429 | 503>>;
export type ConsentRegisterRefusal = keyof typeof CONSENT_REGISTER_REFUSALS;

/** `key-blocked` to ten sam napis, który karta bez przycisku zgody niesie w `unavailable`. */
const KEY_BLOCKED = 'key-blocked' satisfies ConsentUnavailable & ConsentRegisterRefusal;

export interface ConsentRegisterRefused {
  readonly accepted: false;
  readonly error: ConsentRegisterRefusal;
}

/** Wynik rejestracji: kod HTTP i ciało odpowiedzi gniazda. */
export type ConsentRegisterOutcome =
  | { readonly status: 200; readonly body: ConsentRegisterAccepted }
  | { readonly status: 400 | 409 | 429 | 503; readonly body: ConsentRegisterRefused };

/** Wpis rejestru bez sekretu. */
export interface ConsentRegistryEntry {
  readonly key: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly inputSha256: string;
  readonly cardSha256: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly agentId?: string;
  /** `permission_suggestions` of the registration after the check; no field when the body had none. Data only. */
  readonly permissionSuggestions?: HookSuggestions;
  /** The hook knows the "always" answer file of this version; no field = a hook copy without it. */
  readonly alwaysVersion?: number;
  /** Epoch ms przyjęcia (zegar serwera). */
  readonly acceptedAt: number;
  /** Klucz zablokowany drugą, inną rejestracją: serwer nie podpisuje pod nim niczego. */
  readonly blocked: boolean;
  /**
   * The hook's second registration after a server restart, equal to the recovered record it was expected for
   * ({@link ConsentRegistry.expectResume}); `acceptedAt` is the second registration. No field = a first registration.
   */
  readonly resumed?: true;
}

/**
 * What a record recovered after a server restart expects of its hook's second registration
 * ({@link ConsentRegistry.expectResume}, `resume.ts`): the call identity and card digest of the record (for a decision
 * already written, of the registration its answer file is signed under) and that answer file.
 */
export interface ConsentResumeExpect {
  readonly key: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly agentId: string | null;
  readonly pid: number;
  readonly startedAt: number;
  readonly inputSha256: string;
  readonly cardSha256: string;
  /**
   * The parsed answer file of the record's decision (`sent`, `claimed`) and the `permissionsSha256` it signs: the
   * re-sent secret must verify its signature, so a decision already signed resumes only under the secret that signed
   * it. No field = no decision written (`pending`).
   */
  readonly answer?: { readonly file: unknown; readonly permissionsSha256: string | null };
  /**
   * Called once, with the registration time, when the registry takes the hook's second registration as resumed (not
   * for its repeat): the cycle keeps on disk what another restart needs. An exception is ignored.
   */
  readonly onResumed?: (acceptedAt: number) => void;
}

/** Liczniki rejestru od startu procesu. */
export interface ConsentRegistryStats {
  readonly accepted: number;
  /** Powtórki identycznej rejestracji. */
  readonly repeated: number;
  readonly refused: Readonly<Record<ConsentRegisterRefusal, number>>;
}

export interface ConsentRegistryOptions {
  /** Identyfikator startu procesu serwera, ten sam co w `alive.json`. */
  readonly bootId: string;
  /** Killswitch wysyłki, czytany przy każdej rejestracji. */
  readonly send: () => boolean;
  /** `session_id` silnika obserwowanych sesji, czytane przy każdej rejestracji. */
  readonly sessions: () => Iterable<string>;
  readonly log: (line: string) => void;
  /**
   * Nowa rejestracja przyjęta (nie powtórka) — sesja silnika. Serwer szturcha nią obserwację kanału tej sesji, żeby
   * karta nie czekała na takt rejestru CLI. Wyjątek odbiorcy nie zmienia wyniku rejestracji.
   */
  readonly onAccepted?: (sessionId: string) => void;
  readonly now?: () => number;
  /**
   * Restart grace G in ms: how long the key of a recovered record stays expected after
   * {@link ConsentRegistry.expectResume}. No field or 0 = nothing is expected, every registration is a first one.
   */
  readonly restartGraceMs?: number;
}

export interface ConsentRegistry {
  /** Rejestracja z ciała gniazda (niesprawdzonego). */
  register(body: unknown): ConsentRegisterOutcome;
  scope(): ConsentRegistryScope;
  /** Zmiana zakresu dotyczy kolejnych rejestracji; przyjętych wpisów nie rusza. */
  setScope(scope: ConsentRegistryScope): void;
  /** Żywy wpis klucza tej sesji (także zablokowany) albo `null`. */
  entry(sessionId: string, key: string): ConsentRegistryEntry | null;
  /** Sekret do podpisu (hex) albo `null`: brak wpisu, wpis innej sesji, przeterminowany albo zablokowany. */
  secretOf(sessionId: string, key: string): string | null;
  /** Żywe wpisy (np. do sprawdzenia, czy procesy hooków żyją). */
  entries(): ConsentRegistryEntry[];
  /** Usuwa wpis (proces hooka nie żyje, cykl klucza skończony); `false` = nie było go. */
  forget(sessionId: string, key: string): boolean;
  stats(): ConsentRegistryStats;
  /**
   * The next registration of `expect.key`, within {@link ConsentRegistryOptions.restartGraceMs} from now, is the
   * hook's second one: equal in the session, every call field and the card digest, and with a secret that verifies
   * `expect.answer` when there is one = accepted with `resumed: true` (no limits: the earlier process counted it);
   * anything else blocks the key (409 `key-blocked`). The refusals of the channel scope, the kill switch and the
   * session list come first and keep the expectation. Without the grace nothing is expected.
   */
  expectResume(expect: ConsentResumeExpect): void;
  /** Drops the expectation of the key (its record no longer waits); the next registration is a first one. */
  cancelResume(sessionId: string, key: string): void;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SECRET_HEX = new RegExp(`^[0-9a-f]{${String(CONSENT_SECRET_BYTES * 2)}}$`);
/** Klucz = `<promptId>-<nonce hex>`: długość ogona za prefiksem. */
const KEY_TAIL_LENGTH = 1 + HOOK_CALL_NONCE_BYTES * 2;

const registrationSchema = z.strictObject({
  key: z.string().regex(HOOK_CALL_KEY_PATTERN),
  sessionId: z.string().min(1).max(128),
  promptId: z.string().min(1).max(128),
  secret: z.string().regex(SECRET_HEX),
  inputSha256: z.string().regex(SHA256_HEX),
  cardSha256: z.string().regex(SHA256_HEX),
  pid: z.number().int().positive(),
  startedAt: z.number().finite().positive(),
  agentId: z.string().min(1).max(256).optional(),
  // Any value: `parseHookSuggestions` keeps a whole list of documented entries or none, never refusing the body.
  permissionSuggestions: z.unknown().optional(),
  alwaysVersion: z.literal(CONSENT_ALWAYS_VERSION).optional(),
});

interface Slot {
  entry: ConsentRegistryEntry;
  readonly secret: Buffer;
}

/** Ta sama rejestracja co przyjęta: każde pole równe, sekret porównany w stałym czasie. */
function sameRegistration(
  slot: Slot, reg: ConsentRegistration, secret: Buffer, suggestions: HookSuggestions | undefined,
): boolean {
  const { entry } = slot;
  const sameSecret = timingSafeEqual(slot.secret, secret);
  return sameSecret && entry.sessionId === reg.sessionId && entry.promptId === reg.promptId
    && entry.inputSha256 === reg.inputSha256 && entry.cardSha256 === reg.cardSha256 && entry.pid === reg.pid
    && entry.startedAt === reg.startedAt && entry.agentId === reg.agentId
    && JSON.stringify(entry.permissionSuggestions) === JSON.stringify(suggestions)
    && entry.alwaysVersion === reg.alwaysVersion;
}

/**
 * The second registration is the call the recovered record expects: every field equal, and a written answer file
 * verifies under the re-sent secret (the only way to tell that secret from another one; it is never on disk).
 */
function resumeMatches(expect: ConsentResumeExpect, reg: ConsentRegistration): boolean {
  const same = expect.sessionId === reg.sessionId && expect.promptId === reg.promptId
    && expect.agentId === (reg.agentId ?? null) && expect.pid === reg.pid && expect.startedAt === reg.startedAt
    && expect.inputSha256 === reg.inputSha256 && expect.cardSha256 === reg.cardSha256;
  if (!same || expect.answer === undefined) return same;
  return verifyConsentFile(expect.answer.file, {
    secret: reg.secret, sessionId: reg.sessionId, key: reg.key, inputSha256: reg.inputSha256,
    cardSha256: reg.cardSha256, notBefore: 0, permissionsSha256: expect.answer.permissionsSha256,
  }).ok;
}

export function createConsentRegistry(options: ConsentRegistryOptions): ConsentRegistry {
  const now = options.now ?? ((): number => Date.now());
  const graceMs = options.restartGraceMs ?? 0;
  const slots = new Map<string, Slot>();
  /** Keys of recovered records waiting for their hook's second registration, until the end of the grace. */
  const expected = new Map<string, { readonly expect: ConsentResumeExpect; readonly until: number }>();
  let scope: ConsentRegistryScope = 'closed';
  let accepted = 0;
  let repeated = 0;
  const refused = Object.fromEntries(
    Object.keys(CONSENT_REGISTER_REFUSALS).map((code) => [code, 0]),
  ) as Record<ConsentRegisterRefusal, number>;

  const refuse = (error: ConsentRegisterRefusal): ConsentRegisterOutcome => {
    refused[error] += 1;
    return { status: CONSENT_REGISTER_REFUSALS[error], body: { accepted: false, error } };
  };
  const acceptedBody = (resumed = false): ConsentRegisterOutcome => ({
    status: 200, body: { accepted: true, bootId: options.bootId, ...(resumed ? { resumed: true } : {}) },
  });

  /** Kasuje wpisy po terminie. */
  const expire = (at: number): void => {
    for (const [key, slot] of slots) {
      if (at - slot.entry.acceptedAt >= CONSENT_REGISTRATION_TTL_MS) slots.delete(key);
    }
  };

  const live = (sessionId: string, key: string): Slot | null => {
    expire(now());
    const slot = slots.get(key);
    return slot === undefined || slot.entry.sessionId !== sessionId ? null : slot;
  };

  const register = (body: unknown): ConsentRegisterOutcome => {
    const parsed = registrationSchema.safeParse(body);
    if (!parsed.success) return refuse('bad-request');
    const reg: ConsentRegistration = parsed.data;
    if (reg.key.slice(0, -KEY_TAIL_LENGTH) !== reg.promptId) return refuse('bad-request');
    if (scope === 'closed') return refuse('channel-closed');
    if (reg.agentId !== undefined && scope !== 'all') return refuse('subagent');
    if (!options.send()) return refuse('send-off');
    if (!new Set(options.sessions()).has(reg.sessionId)) return refuse('session-unknown');

    const at = now();
    expire(at);
    const secret = Buffer.from(reg.secret, 'hex');
    const suggestions = parseHookSuggestions(reg.permissionSuggestions);
    const existing = slots.get(reg.key);
    if (existing !== undefined) {
      if (!existing.entry.blocked && sameRegistration(existing, reg, secret, suggestions)) {
        repeated += 1;
        return acceptedBody(existing.entry.resumed === true);
      }
      if (!existing.entry.blocked) {
        existing.entry = { ...existing.entry, blocked: true };
        options.log(`consent: key ${reg.key} blocked — a second, different registration (session ${existing.entry.sessionId})`);
      }
      return refuse(KEY_BLOCKED);
    }

    const entry: ConsentRegistryEntry = {
      key: reg.key, sessionId: reg.sessionId, promptId: reg.promptId, inputSha256: reg.inputSha256,
      cardSha256: reg.cardSha256, pid: reg.pid, startedAt: reg.startedAt,
      ...(reg.agentId === undefined ? {} : { agentId: reg.agentId }),
      ...(suggestions === undefined ? {} : { permissionSuggestions: suggestions }),
      ...(reg.alwaysVersion === undefined ? {} : { alwaysVersion: reg.alwaysVersion }),
      acceptedAt: at, blocked: false,
    };
    const waiting = expected.get(reg.key);
    expected.delete(reg.key);
    const resume = waiting !== undefined && at < waiting.until;
    if (resume && !resumeMatches(waiting.expect, reg)) {
      slots.set(reg.key, { secret, entry: { ...entry, blocked: true } });
      options.log(`consent: key ${reg.key} blocked — the registration after the restart does not match its record`
        + ` (session ${reg.sessionId})`);
      return refuse(KEY_BLOCKED);
    }

    if (!resume) {
      let inSession = 0;
      for (const slot of slots.values()) if (slot.entry.sessionId === reg.sessionId) inSession += 1;
      if (inSession >= CONSENT_REGISTRATIONS_PER_SESSION_MAX) return refuse('session-limit');
      if (slots.size >= CONSENT_REGISTRATIONS_MAX) return refuse('global-limit');
    }

    slots.set(reg.key, { secret, entry: resume ? { ...entry, resumed: true } : entry });
    accepted += 1;
    // The line says only that a carried list was dropped, never its content.
    const dropped = reg.permissionSuggestions !== undefined && suggestions === undefined
      ? ' (permission_suggestions dropped: outside the checked shape)' : '';
    options.log(`consent: registration accepted — session ${reg.sessionId}, key ${reg.key}${dropped}`
      + (resume ? ' (resumed after the restart)' : ''));
    try {
      options.onAccepted?.(reg.sessionId);
    } catch {
      // Szturchnięcie to przyspieszenie: takt rejestru i tak dowiezie kartę.
    }
    if (resume) {
      try {
        waiting.expect.onResumed?.(at);
      } catch {
        // The registration stands: what the callback keeps only serves another restart.
      }
    }
    return acceptedBody(resume);
  };

  return {
    register,
    scope: () => scope,
    setScope: (next) => { scope = next; },
    entry: (sessionId, key) => live(sessionId, key)?.entry ?? null,
    secretOf: (sessionId, key) => {
      const slot = live(sessionId, key);
      return slot === null || slot.entry.blocked ? null : slot.secret.toString('hex');
    },
    entries: () => {
      expire(now());
      return [...slots.values()].map((slot) => slot.entry);
    },
    forget: (sessionId, key) => {
      const slot = slots.get(key);
      if (slot === undefined || slot.entry.sessionId !== sessionId) return false;
      return slots.delete(key);
    },
    stats: () => ({ accepted, repeated, refused: { ...refused } }),
    expectResume: (expect) => {
      if (graceMs > 0) expected.set(expect.key, { expect, until: now() + graceMs });
    },
    cancelResume: (sessionId, key) => {
      if (expected.get(key)?.expect.sessionId === sessionId) expected.delete(key);
    },
  };
}

/** The channel cards of a session (`ConsentCycle.cards`): a card's `permId` is the key of its registration. */
interface SessionCards {
  cards(sessionId: string): readonly { readonly permId: string }[];
}

/**
 * Whether the session has a live registration without a channel card, of any agent (at `all` a subagent's dialog
 * stands in the same pane) and of any age (the TTL and the hook's death end it): the "Yes" digit of a measured consent
 * dialog waits for no such request (`HerdrDriverDeps.consentRegistrationWaits`). Without a cycle no key has a card.
 */
export function registrationWithoutCard(
  link: { readonly cycle: SessionCards | null; readonly registry: Pick<ConsentRegistry, 'entries'> | null },
  sessionId: string,
): boolean {
  if (link.registry === null) return false;
  const carded = new Set((link.cycle?.cards(sessionId) ?? []).map((card) => card.permId));
  return link.registry.entries().some((entry) => entry.sessionId === sessionId && !carded.has(entry.key));
}
