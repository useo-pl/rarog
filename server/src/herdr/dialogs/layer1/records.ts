/**
 * Rekordy cyklu kanału zgód `<dataDir>/consent-records/<sesja>/<klucz>.json` (warstwa 1) i sprzątanie
 * katalogów kanału przy starcie.
 *
 * Rekord niesie cykl jednego klucza: stan, czasy, decyzję i `reasonId`, wiązanie z wywołaniem, checkpoint przeglądu
 * transkryptu, `promptId`, pid i start hooka, `bootId` i przyczynę końcową. Bez `tool_input` i bez sekretu. Pole
 * `v` = {@link CONSENT_RECORD_VERSION}; rekord innej wersji albo w złym kształcie odczyt pomija. Pola opcjonalne
 * `buttonless` (audyt), `retired` (karta zdjęta na końcu sesji), `releaseCause` (powrót do biurka), `releaseFailed`
 * (porażki zapisu `release` z `pending`) i `proofKind` (rodzaj dowodu zgody) w złym kształcie odpadają, a rekord
 * zostaje; rekord bez nich czyta się jak dotąd (odczyt pomija pola, których nie zna, więc wersja się nie zmienia).
 * The optional `receipt` (the hook's confirmed receipt of an `allow`, `POST /claim`), `dumpCardSha256` (the card digest
 * of the first dump), `signed` (the registration an answer is signed under: its card digest and call identity),
 * `permissions` (the updates of an `allow-always`) and `claimFrom` (the claim deadline start of a decision resumed
 * after a restart) follow the same rule.
 * Katalog jest osobny od `decisions/` trybu cienia, więc czytnik cienia rekordów kanału nie widzi (także stary, po
 * `git revert`).
 *
 * Zapis atomowy (`shadow/atomic.ts`), z opcją `fsync` dla protokołu zapisu decyzji (`cycle.ts`). Sprzątanie
 * ({@link sweepConsentFiles}) kasuje pliki `consent/` starsze niż `timeout` hooka plus zapas i rekordy starsze niż
 * {@link CONSENT_RECORD_RETENTION_MS}; te same zasady co sprzątanie trybu cienia (`shadow/sweep.ts`). Start serwera
 * woła je tylko przy cyklu, po udanym `recover` ({@link recoverThenSweepConsent}).
 */
import { join } from 'node:path';
import { z } from 'zod';
import { readRegularFileSync } from '../../../safe-read.ts';
import { ENGINE_SESSION_ID_PATTERN } from '../../../transcript-import.ts';
import { HOOK_ANSWER_TIMEOUT_S } from '../../hook-config.ts';
import { HOOK_CALL_KEY_PATTERN } from '../hook/contract.ts';
import { HOOK_SUGGESTIONS_MAX_ENTRIES, parseHookSuggestions } from '../hook/suggestions.ts';
import type { HookSuggestions } from '../hook/suggestions.ts';
import { writeAtomic } from '../shadow/atomic.ts';
import { listDir } from '../shadow/files.ts';
import { sweepAgedSessionFiles } from '../shadow/sweep.ts';
import {
  CONSENT_CORRELATIONS, CONSENT_CYCLE_STATES, CONSENT_DECISIONS, CONSENT_DESK_DECISIONS, CONSENT_DIRNAME,
  CONSENT_REASONS, CONSENT_RECORDS_DIRNAME, CONSENT_RECORD_RETENTION_MS, CONSENT_RECORD_VERSION,
  CONSENT_RELEASE_CAUSES, CONSENT_REVOKE_CAUSES, CONSENT_TTL_MARGIN_MS, CONSENT_UNAVAILABLE_REASONS,
  CONSENT_UNKNOWN_CAUSES,
} from './contract.ts';
import type {
  ConsentCallField, ConsentCause, ConsentCheckpoint, ConsentCorrelation, ConsentCycleState, ConsentDecision,
  ConsentDeskDecision, ConsentReasonId, ConsentReleaseCause, ConsentRevokeCause, ConsentUnavailable,
} from './contract.ts';
import type { ConsentRegistryEntry } from './registry.ts';

/** Czasy przejść (ms epoki); pole jest, gdy rekord przez stan przeszedł. */
export interface ConsentRecordTimes {
  readonly pending: number;
  readonly deciding?: number;
  readonly sent?: number;
  readonly claimed?: number;
  readonly running?: number;
  /** Stan końcowy albo `unknown`. */
  readonly settled?: number;
}

/** Rekord cyklu jednego klucza. */
export interface ConsentRecord {
  readonly v: typeof CONSENT_RECORD_VERSION;
  readonly key: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly toolName: string;
  readonly inputSha256: string;
  /** Skrót karty z rejestracji (podpisany w pliku) albo `null` bez rejestracji. */
  readonly cardSha256: string | null;
  readonly agentId: string | null;
  readonly pid: number;
  readonly hookStartedAt: number;
  /** `bootId` procesu serwera, który rekord założył albo ostatnio zmienił. */
  readonly bootId: string;
  readonly state: ConsentCycleState;
  /** Decyzja w pliku odpowiedzi (od `deciding`). */
  readonly decision: ConsentDecision | null;
  readonly reasonId: ConsentReasonId | null;
  /** `at` pliku odpowiedzi. */
  readonly decisionAt: number | null;
  readonly correlation: ConsentCorrelation;
  readonly toolUseId: string | null;
  readonly cause: ConsentCause | null;
  /** Dowód `applied` przyszedł po `unknown`. */
  readonly late: boolean;
  readonly checkpoint: ConsentCheckpoint | null;
  readonly times: ConsentRecordTimes;
}

/**
 * Rekord z polem audytu `buttonless`: pierwsza chwila, w której karta wątku głównego przy żywym hooku i przyjętej
 * rejestracji poszła do urządzeń bez `canAllow`, z powodem z karty. Ustawiane raz (`cycle.ts`, publikacja widoku);
 * brak pola = karta z przyciskiem zgody, karta bez rejestracji albo subagenta, rekord sprzed tego pola. Wersji
 * rekordu nie zmienia. Osobny typ, bo audyt kanału czyta to pole z surowego pliku rekordu jako własne.
 */
export interface ConsentCycleRecord extends ConsentRecord {
  readonly buttonless?: ConsentButtonless;
  /**
   * Karta zdjęta z urządzeń na końcu sesji (manager, `ConsentManagerChannel.retire`): od tej chwili cykl nie
   * publikuje rekordu urządzeniom, także po restarcie, a manager traktuje kartę jak zdjętą (poza migawką, decyzja
   * 410). Ustawiane raz; stanu rekordu nie zmienia (rekord idzie dalej za dowodem). Brak pola = karta bez zdjęcia
   * albo rekord sprzed tego pola. Wersji rekordu nie zmienia.
   */
  readonly retired?: ConsentRetired;
  /**
   * Przyczyna `release` napisanego przez serwer bez decyzji z urządzenia: ustawiana razem z decyzją
   * `release` w `deciding` i niesiona przez `sent`, odbiór (`released`) i restart; inne przejścia jej nie zerują
   * (pole `cause` zeruje każde przejście). Brak pola = `release` z telefonu albo `rarog dialogs release`, decyzja
   * inna niż `release`, rekord sprzed pola. Wersji rekordu nie zmienia.
   */
  readonly releaseCause?: ConsentReleaseCause;
  /**
   * Licznik nieudanych zapisów `release` z `pending` (licznik `release-failed` audytu): powrót do
   * biurka, zwolnienie z urządzenia albo `rarog dialogs release`. Każda porażka protokołu zapisu zostawia rekord
   * w `pending` z licznikiem o jeden większym; powrót do biurka próbuje jeszcze raz przy następnej obserwacji. Zostaje
   * po udanym zapisie. Brak pola = zero porażek. Wersji rekordu nie zmienia.
   */
  readonly releaseFailed?: number;
  /**
   * Rodzaj dowodu „dialog stoi”, z którym serwer podpisał zgodę (5.6): `top` = dialog na wierzchu ekranu,
   * `hidden` = dowód ukryty prośby subagenta w tle (5.3), `channel` = reguła `channel` prośby wątku głównego (żywy
   * hook i świeży rejestr CLI `waiting: permission` bez wierzchu). Pole wewnętrzne (audyt), bez SSE. Ustawiane
   * w rekordzie `deciding` decyzji `allow` i niesione przez `sent` i dalsze przejścia tej decyzji; inna decyzja go nie
   * ma. Brak pola = decyzja inna niż `allow` albo rekord sprzed pola (stary serwer czyta `channel` jako brak pola).
   * Wersji rekordu nie zmienia.
   */
  readonly proofKind?: ConsentProofKind;
  /**
   * Decision of the desk key of a `settled-at-desk` record, read from the bound result (`consentDeskDecisionOf` in
   * `proof.ts`): what `permission-resolved` tells the devices. No field = a record settled before the field, or no
   * desk decision. Does not change the record version.
   */
  readonly deskDecision?: ConsentDeskDecision;
  /**
   * Revocation of a record that left `revoked` on a hook result bound to its key (W-b): the revoke cause and
   * time. The record's `cause` then carries the `unknown` cause. Does not change the record version.
   */
  readonly revocation?: ConsentRevocation;
  /**
   * The `bound` binding was written with the bound call's result in the turn facts: later lines can no longer change
   * it, so the next pass keeps it. No field = a binding without a result (a forced turn end) or a record from before
   * the field: the next pass binds the key again from the facts. Does not change the record version.
   */
  readonly bindingConfirmed?: true;
  /**
   * The hook's confirmed receipt of this record's `allow` (W-a, `layer1/receipt.ts`): the confirmed
   * `decisionAt`, the `inputSha256` of the hook's registration and the confirmation time. Set once, while the record
   * is `sent` or `claimed`, and kept by later transitions; `applied` needs it (`consentReceiptOf` in `proof.ts`). No
   * field = no receipt (a `deny` or `release`, an old hook copy, a record from before the field). Does not change
   * the record version.
   */
  readonly receipt?: ConsentReceipt;
  /**
   * The `cardSha256` of the record's first dump, computed by the server (`consentDumpCardSha256` in `card.ts`): the
   * tool name and input the record binds its call by, with the session, `cwd`, agent and permission mode. Set
   * when the record is created. No field = a dump the hook truncated, or a record from before the field: such a record
   * never reaches `applied` (`consentAnswerProven` in `proof.ts`). Does not change the record version.
   */
  readonly dumpCardSha256?: string;
  /**
   * The answer file of this record's decision: its `decisionAt` and the registration it is signed under
   * ({@link ConsentSigned}). `applied` needs the registration's call identity equal to the record's own, field by
   * field, and its `cardSha256` equal to {@link ConsentCycleRecord.dumpCardSha256}: the call the record binds is the
   * one the hook was answered for (`consentAnswerProven` in `proof.ts`). Set in the `deciding` record and kept by
   * later transitions of the same decision. No field = no decision, or a record from before the field (also one
   * without the call identity). Does not change the record version.
   */
  readonly signed?: ConsentSigned;
  /**
   * The permission updates of an `allow-always` decision (`always.ts`): every update the hook writes, as the
   * registration carried it, and the digest the answer file signs. Set in the `deciding` record of that decision and
   * kept by its later transitions; another decision has none. No field = no "always". Does not change the record
   * version.
   */
  readonly permissions?: ConsentPermissionsWritten;
  /**
   * Start of the claim deadline of the decision `decisionAt` when it is not the `sent` time: the hook's second
   * registration after a server restart resumed the `sent` record (restart grace, `resume.ts`), and the deadline
   * counts from it, also in the recovery after another restart. The `sent` time and the signed `decisionAt` stay as
   * they were. A record of another decision ignores the field. No field = the deadline counts from the `sent` time, as
   * for a record from before the field. Does not change the record version.
   */
  readonly claimFrom?: ConsentClaimFrom;
}

/** Start of the claim deadline of a decision ({@link ConsentCycleRecord.claimFrom}). */
export interface ConsentClaimFrom {
  /** The `decisionAt` of the decision the start belongs to. */
  readonly decisionAt: number;
  readonly at: number;
}

/** The updates of an `allow-always` decision ({@link ConsentCycleRecord.permissions}). */
export interface ConsentPermissionsWritten {
  readonly sha256: string;
  readonly updates: HookSuggestions;
}

/** A confirmed receipt of an `allow` ({@link ConsentCycleRecord.receipt}). */
export interface ConsentReceipt {
  readonly decisionAt: number;
  /** The `inputSha256` of the hook's registration, the one the answer file is signed over. */
  readonly inputSha256: string;
  readonly at: number;
}

/** The call identity of a record: the fields it takes from its first dump ({@link CONSENT_CALL_FIELDS}). */
export type ConsentCall = Pick<ConsentRecord, ConsentCallField>;

/**
 * The answer file of a decision ({@link ConsentCycleRecord.signed}): its `decisionAt` and the registration it is signed
 * under, the `cardSha256` and the call identity, with the registration's `startedAt` as `hookStartedAt`.
 */
export interface ConsentSigned extends ConsentCall {
  readonly decisionAt: number;
  readonly cardSha256: string;
}

/** {@link ConsentSigned} of an answer file signed at `decisionAt` under the registration `entry`. */
export function consentSignedOf(entry: ConsentRegistryEntry, decisionAt: number): ConsentSigned {
  return {
    decisionAt, cardSha256: entry.cardSha256, promptId: entry.promptId, agentId: entry.agentId ?? null,
    pid: entry.pid, hookStartedAt: entry.startedAt, inputSha256: entry.inputSha256,
  };
}

/** Revoke cause and time kept by a record that left `revoked` ({@link ConsentCycleRecord.revocation}). */
export interface ConsentRevocation {
  readonly cause: ConsentRevokeCause;
  readonly at: number;
}

/** Rodzaje dowodu „dialog stoi”, z którym serwer podpisuje zgodę ({@link ConsentCycleRecord.proofKind}). */
export const CONSENT_PROOF_KINDS = ['top', 'hidden', 'channel'] as const;
export type ConsentProofKind = (typeof CONSENT_PROOF_KINDS)[number];

/** Powód i chwila karty bez przycisku zgody (audyt kanału). */
export interface ConsentButtonless {
  readonly reason: ConsentUnavailable;
  readonly at: number;
}

/** Chwila zdjęcia karty z urządzeń na końcu sesji. */
export interface ConsentRetired {
  readonly at: number;
}

/** Sufit odczytu rekordu: pola proste, ścieżka transkryptu i zmiany uprawnień `allow-always` (do 16 KiB). */
const RECORD_MAX_BYTES = 48 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

const timeSchema = z.number().finite();
/** The call identity ({@link ConsentCall}) as the record and its `signed` carry it: a field joins with its check. */
const callShape = {
  promptId: z.string().min(1).max(128),
  agentId: z.string().min(1).max(256).nullable(),
  pid: z.number().int().positive(),
  hookStartedAt: timeSchema,
  inputSha256: z.string().regex(SHA256_PATTERN),
} satisfies { readonly [F in ConsentCallField]: z.ZodType<ConsentRecord[F]> };
const recordSchema = z.object({
  v: z.literal(CONSENT_RECORD_VERSION),
  key: z.string().regex(HOOK_CALL_KEY_PATTERN),
  sessionId: z.string().regex(ENGINE_SESSION_ID_PATTERN),
  ...callShape,
  toolName: z.string().regex(TOOL_NAME_PATTERN),
  cardSha256: z.string().regex(SHA256_PATTERN).nullable(),
  bootId: z.string().min(1).max(64),
  state: z.enum(CONSENT_CYCLE_STATES),
  decision: z.enum(CONSENT_DECISIONS).nullable(),
  reasonId: z.enum(Object.keys(CONSENT_REASONS) as [ConsentReasonId, ...ConsentReasonId[]]).nullable(),
  decisionAt: timeSchema.nullable(),
  correlation: z.enum(CONSENT_CORRELATIONS),
  toolUseId: z.string().min(1).max(256).nullable(),
  cause: z.enum([...CONSENT_UNKNOWN_CAUSES, ...CONSENT_REVOKE_CAUSES]).nullable(),
  late: z.boolean(),
  checkpoint: z.object({
    file: z.string().min(1).max(4096),
    sessionId: z.string().regex(ENGINE_SESSION_ID_PATTERN),
    inode: z.number().int().nonnegative(),
    lineStart: z.number().int().nonnegative(),
  }).nullable(),
  times: z.object({
    pending: timeSchema,
    deciding: timeSchema.optional(),
    sent: timeSchema.optional(),
    claimed: timeSchema.optional(),
    running: timeSchema.optional(),
    settled: timeSchema.optional(),
  }),
  // Pole audytu w złym kształcie odpada samo; rekord cyklu zostaje (audyt liczy go jak rekord bez pola).
  buttonless: z.object({ reason: z.enum(CONSENT_UNAVAILABLE_REASONS), at: timeSchema }).optional().catch(undefined),
  // Zdjęcie w złym kształcie odpada tak samo: rekord wraca do zachowania karty bez zdjęcia.
  retired: z.object({ at: timeSchema }).optional().catch(undefined),
  // Pola powrotu do biurka (audyt): zły kształt odpada, rekord cyklu zostaje.
  releaseCause: z.enum(CONSENT_RELEASE_CAUSES).optional().catch(undefined),
  releaseFailed: z.number().int().positive().optional().catch(undefined),
  // Rodzaj dowodu zgody (audyt): zły kształt odpada, rekord cyklu zostaje.
  proofKind: z.enum(CONSENT_PROOF_KINDS).optional().catch(undefined),
  // Outcome notes (desk decision, revocation before the result): a bad shape drops the field, the record stays.
  deskDecision: z.enum(CONSENT_DESK_DECISIONS).optional().catch(undefined),
  revocation: z.object({ cause: z.enum(CONSENT_REVOKE_CAUSES), at: timeSchema }).optional().catch(undefined),
  // A bad shape reads as an unconfirmed binding: the next pass binds the key again.
  bindingConfirmed: z.literal(true).optional().catch(undefined),
  // A bad shape reads as no receipt: the record cannot reach `applied`.
  receipt: z.object({
    decisionAt: timeSchema, inputSha256: z.string().regex(SHA256_PATTERN), at: timeSchema,
  }).optional().catch(undefined),
  // A bad shape reads as no digest: the record cannot reach `applied`.
  dumpCardSha256: z.string().regex(SHA256_PATTERN).optional().catch(undefined),
  // A bad shape, also one without the call identity (a record from before it), reads as no answer: no `applied`.
  signed: z.object({
    decisionAt: timeSchema, cardSha256: z.string().regex(SHA256_PATTERN), ...callShape,
  }).optional().catch(undefined),
  // The trail of an "always": a bad shape drops the field, the record stays.
  permissions: z.object({
    sha256: z.string().regex(SHA256_PATTERN),
    updates: z.array(z.unknown()).min(1).max(HOOK_SUGGESTIONS_MAX_ENTRIES)
      .refine((raw) => parseHookSuggestions(raw) !== undefined),
  }).optional().catch(undefined),
  // A bad shape reads as no kept start: the claim deadline counts from the `sent` time.
  claimFrom: z.object({ decisionAt: timeSchema, at: timeSchema }).optional().catch(undefined),
});

/** Katalog rekordów sesji albo `null`, gdy sesja nie nadaje się na nazwę katalogu. */
function recordsDir(dataDir: string, sessionId: string): string | null {
  return ENGINE_SESSION_ID_PATTERN.test(sessionId) ? join(dataDir, CONSENT_RECORDS_DIRNAME, sessionId) : null;
}

/** Katalog plików odpowiedzi sesji `consent/<sesja>/` albo `null` (zła sesja). */
export function consentFilesDir(dataDir: string, sessionId: string): string | null {
  return ENGINE_SESSION_ID_PATTERN.test(sessionId) ? join(dataDir, CONSENT_DIRNAME, sessionId) : null;
}

/**
 * Zapisuje rekord atomowo; `fsync` przed `rename` przy protokole zapisu decyzji. Rzuca przy złej sesji albo kluczu
 * i przy każdym błędzie zapisu (pełny dysk): wołający decyduje, co porażka znaczy dla cyklu.
 */
export function writeConsentRecord(dataDir: string, record: ConsentRecord, options: { fsync?: boolean } = {}): void {
  const dir = recordsDir(dataDir, record.sessionId);
  if (dir === null || !HOOK_CALL_KEY_PATTERN.test(record.key)) throw new Error('rekord kanału: zła sesja albo klucz');
  writeAtomic(dir, `${record.key}.json`, `${JSON.stringify(record)}\n`, options);
}

function parseRecord(path: string): unknown {
  const read = readRegularFileSync(path, { maxBytes: RECORD_MAX_BYTES, followSymlink: false });
  if (read === null || read.truncated) return null;
  return JSON.parse(read.bytes.toString('utf8')) as unknown;
}

/** Wszystkie rekordy kanału (wszystkie sesje). Plik w złym kształcie, innej wersji albo pod cudzą nazwą pominięty. */
export function readConsentRecords(dataDir: string): ConsentCycleRecord[] {
  const root = join(dataDir, CONSENT_RECORDS_DIRNAME);
  const out: ConsentCycleRecord[] = [];
  let sessions: string[];
  try {
    sessions = listDir(root);
  } catch {
    return out;
  }
  for (const sessionId of sessions) {
    if (!ENGINE_SESSION_ID_PATTERN.test(sessionId)) continue;
    let names: string[];
    try {
      names = listDir(join(root, sessionId));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let parsed: unknown;
      try {
        parsed = parseRecord(join(root, sessionId, name));
      } catch {
        continue;
      }
      const entry = recordSchema.safeParse(parsed);
      if (!entry.success || entry.data.sessionId !== sessionId || `${entry.data.key}.json` !== name) continue;
      out.push(entry.data as ConsentCycleRecord);
    }
  }
  return out;
}

/**
 * The `decisionAt` (ms epoch) of the newest device approval decided at or after `since`, or `null`. An approval is a
 * record in `applied` with the `allow` decision (also an "always"), which only the device route writes: a desk
 * decision (`settled-at-desk`, `deskDecision`), a release and a denial do not count. The time is the decision's, not
 * the move to `applied`, so an answer decided before `since` never counts. Read-only (`rarog dialogs last-approval`).
 */
export function latestDeviceApprovalAt(dataDir: string, since: number): number | null {
  let latest: number | null = null;
  for (const record of readConsentRecords(dataDir)) {
    if (record.state !== 'applied' || record.decision !== 'allow' || record.deskDecision !== undefined) continue;
    const at = record.decisionAt;
    if (at === null || at < since) continue;
    if (latest === null || at > latest) latest = at;
  }
  return latest;
}

/** Wiek, po którym plik `consent/` nikomu nie służy: hook czeka najwyżej `timeout`, plus zapas. */
export const CONSENT_FILE_TTL_MS = HOOK_ANSWER_TIMEOUT_S * 1000 + CONSENT_TTL_MARGIN_MS;

export interface ConsentSweepResult {
  readonly consentFiles: number;
  readonly records: number;
}

/** Sprzątanie startu: `consent/` starsze niż {@link CONSENT_FILE_TTL_MS}, rekordy ponad retencję. Nie rzuca. */
export function sweepConsentFiles(dataDir: string, now: () => number = Date.now): ConsentSweepResult {
  const at = now();
  return {
    consentFiles: sweepAgedSessionFiles(join(dataDir, CONSENT_DIRNAME), at, CONSENT_FILE_TTL_MS),
    records: sweepAgedSessionFiles(join(dataDir, CONSENT_RECORDS_DIRNAME), at, CONSENT_RECORD_RETENTION_MS),
  };
}

/** Log startu kanału zgód ({@link recoverThenSweepConsent}). */
export interface ConsentStartLog {
  info(line: string): void;
  /** Nieudane odzyskanie rekordów; wołający zapisuje błąd w logu (z redakcją). */
  failed(err: unknown): void;
}

/**
 * Start serwera z cyklem kanału zgód: odzyskanie rekordów poprzedniego procesu (`recover` cyklu), a sprzątanie
 * startu ({@link sweepConsentFiles}) WYŁĄCZNIE po udanym odzyskaniu. Rekord `sent` sprzed restartu ma najpierw
 * zobaczyć swój plik odpowiedzi: `.claimed` skasowany przed odzyskaniem dałby `revoked: restart` zamiast `claimed`
 * i zepsuł audyt okna zgód. Nieudane odzyskanie zostawia pliki następnemu startowi. Serwer bez cyklu (`off`, `shadow`)
 * tego nie woła: pliki `consent/` powstają tylko przy `main` i `all` i czekają na następny start z cyklem, który je
 * najpierw rozliczy. Wynik: `true` = odzyskanie się udało (i sprzątanie poszło).
 */
export async function recoverThenSweepConsent(
  recover: () => Promise<{ readonly records: number; readonly changed: number }>,
  dataDir: string,
  log: ConsentStartLog,
): Promise<boolean> {
  try {
    const recovered = await recover();
    if (recovered.records > 0) {
      log.info(`consent: recovered ${String(recovered.records)} records, ${String(recovered.changed)} changed`);
    }
  } catch (err: unknown) {
    log.failed(err);
    return false;
  }
  const swept = sweepConsentFiles(dataDir);
  if (swept.consentFiles + swept.records > 0) {
    log.info(`consent: start cleanup — consent/ ${String(swept.consentFiles)},`
      + ` consent-records/ ${String(swept.records)}`);
  }
  return true;
}
