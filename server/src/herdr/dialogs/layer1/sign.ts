/**
 * Podpis pliku odpowiedzi kanału zgód (warstwa 1), jego weryfikacja i skrót karty `cardSha256`.
 *
 * Serwer po decyzji z urządzenia podpisuje plik `consent/<sesja>/<klucz>.json` ({@link ConsentFile}) sekretem, który
 * hook zarejestrował na gnieździe rejestracji. Hook przejmuje plik i sprawdza podpis, zanim wykona decyzję. Obie
 * strony muszą liczyć to samo co do bajtu, więc wszystko, co wchodzi do podpisu, jest ustalone tu wprost:
 *
 * - klucz HMAC-SHA256 to {@link CONSENT_SECRET_BYTES} bajtów sekretu; sekret krąży jako hex małymi literami;
 * - wiadomość to {@link CONSENT_MAC_PREFIX} i pola {@link CONSENT_MAC_FIELDS} w tej kolejności, złączone `|`, jako
 *   bajty UTF-8; `at` w zapisie dziesiętnym liczby całkowitej;
 * - wiadomość jest jednoznaczna, bo żadne pole nie niesie `|`: `reasonId` z zamkniętej listy, `decision` ta, do
 *   której `reasonId` należy, skróty jako 64 znaki hex małymi literami, `at` jako liczba całkowita bez straty
 *   precyzji, `sessionId` i `key` niepuste i bez separatora; innych pól podpis nie przyjmuje;
 * - `cardSha256` to sha256 kanonicznej postaci {@link ConsentCardFields} (`hook/canon.ts`), więc podmiana zrzutu
 *   poza `tool_input` zmienia skrót;
 * - `mac` porównywany w stałym czasie (`timingSafeEqual`).
 *
 * Weryfikacja przyjmuje plik o polach DOKŁADNIE takich jak {@link ConsentFile}: pole `message` albo inne
 * nieznane pole czyni plik nieważnym.
 *
 * An `allow-always` file signs {@link CONSENT_ALWAYS_MAC_FIELDS}: the fields above and `permissionsSha256`, the
 * digest of the permission updates the hook writes. The digest is there exactly with `reasonId: allow-always`, so
 * dropping it or adding it breaks the shape or the signature, and a hook copy that does not know `allow-always`
 * rejects such a file as `shape`.
 *
 * The receipt signature of `POST /claim` ({@link consentReceiptMac}) uses the same key under its own prefix
 * {@link CONSENT_RECEIPT_MAC_PREFIX}, so a file's `mac` never stands for a receipt and the other way round. Wspólne wektory, liczone poza Node: `server/test/fixtures/hook-kanon/podpis.json`
 * (`server/test/hook-canon.test.ts`).
 *
 * CZYSTY moduł: bez I/O i stanu. Importują go dziś tylko testy.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalSha256 } from '../hook/canon.ts';
import {
  CONSENT_ALWAYS_MAC_FIELDS, CONSENT_MAC_FIELDS, CONSENT_MAC_PREFIX, CONSENT_REASONS, CONSENT_RECEIPT_MAC_FIELDS,
  CONSENT_RECEIPT_MAC_PREFIX, CONSENT_SECRET_BYTES, type ConsentCardFields, type ConsentFile, type ConsentReasonId,
} from './contract.ts';

/** Pola pliku odpowiedzi objęte podpisem: cały plik poza `mac`. */
export type ConsentSignedFields = Omit<ConsentFile, 'mac'>;

/**
 * Zapas `notBefore` przed chwilą rejestracji: hook przyjmuje plik z `at ≥ rejestracja − zapas`. Serwer
 * poznaje sekret dopiero z rejestracji, więc ważnie podpisany plik z `at` sprzed niej to powtórka albo błąd serwera.
 * Zapas mieści korektę zegara (NTP) między rejestracją a decyzją.
 */
export const CONSENT_NOT_BEFORE_MARGIN_MS = 60_000;

/**
 * Powody odrzucenia pliku przez {@link verifyConsentFile}, w kolejności sprawdzania:
 *
 * - `shape` — plik nie jest obiektem o polach {@link ConsentFile} albo pole jest poza kontraktem podpisu;
 * - `message` — plik niesie pole `message`; sprawdzane zaraz po tym, czy plik jest obiektem;
 * - `mac` — podpis nie zgadza się z polami pliku i sekretem (podrobiony plik, obcy sekret, `mac` innego klucza,
 *   innej decyzji, innego `reasonId`);
 * - `binding` — ważny podpis, ale inna sesja albo inny klucz niż prośba hooka;
 * - `input` — ważny podpis, ale inny `inputSha256` niż wejście ze stdin;
 * - `card` — ważny podpis, ale inny `cardSha256` niż karta ze stdin;
 * - `permissions` — a valid `allow-always` whose `permissionsSha256` is not the digest of the hook's own
 *   `permission_suggestions` on the closed list;
 * - `stale` — ważny podpis, ale `at` przed `notBefore`.
 *
 * `input`, `card` i `permissions` to rozjazd karty, reszta to rozjazd podpisu.
 */
export const CONSENT_VERIFY_FAILURES = [
  'shape', 'message', 'mac', 'binding', 'input', 'card', 'permissions', 'stale',
] as const;
export type ConsentVerifyFailure = (typeof CONSENT_VERIFY_FAILURES)[number];

/** Co weryfikujący zna sam: własny sekret, sesję i klucz prośby, skróty ze stdin i `notBefore`. */
export interface ConsentExpectation {
  /** Sekret hooka, {@link CONSENT_SECRET_BYTES} bajtów jako hex małymi literami. */
  readonly secret: string;
  readonly sessionId: string;
  readonly key: string;
  readonly inputSha256: string;
  readonly cardSha256: string;
  /** Najwcześniejsze dopuszczalne `at` (epoch ms): chwila rejestracji − {@link CONSENT_NOT_BEFORE_MARGIN_MS}. */
  readonly notBefore: number;
  /** Digest of the verifier's own updates on the closed list; `null` or no field = no `allow-always` is valid. */
  readonly permissionsSha256?: string | null;
}

export type ConsentVerdict =
  | { readonly ok: true; readonly file: ConsentFile }
  | { readonly ok: false; readonly reason: ConsentVerifyFailure };

const MAC_SEPARATOR = '|';
const SECRET_HEX = new RegExp(`^[0-9a-f]{${String(CONSENT_SECRET_BYTES * 2)}}$`);
/** sha256 i HMAC-SHA256: 32 bajty jako hex małymi literami. */
const DIGEST_HEX = /^[0-9a-f]{64}$/;
/** Pola pliku odpowiedzi: podpisane i `mac`; plik `allow-always` z polem skrótu zmian uprawnień. */
const FILE_FIELDS: readonly string[] = [...CONSENT_MAC_FIELDS, 'mac'];
const ALWAYS_FILE_FIELDS: readonly string[] = [...CONSENT_ALWAYS_MAC_FIELDS, 'mac'];
const ALWAYS_REASON: ConsentReasonId = 'allow-always';

/** Signed fields of the file: with the digest of the updates exactly for `allow-always`. */
function macFieldsOf(fields: Readonly<Record<string, unknown>>): readonly string[] {
  return fields['reasonId'] === ALWAYS_REASON ? CONSENT_ALWAYS_MAC_FIELDS : CONSENT_MAC_FIELDS;
}

const isReasonId = (value: unknown): value is ConsentReasonId =>
  typeof value === 'string' && Object.hasOwn(CONSENT_REASONS, value);

const isPlainText = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && !value.includes(MAC_SEPARATOR);

/** Czy pola mieszczą się w kontrakcie podpisu (opis modułu). `decision` musi być tą z `reasonId`. */
function signedFieldsValid(fields: Readonly<Record<string, unknown>>): boolean {
  const { sessionId, key, decision, reasonId, inputSha256, cardSha256, at, permissionsSha256 } = fields;
  const always = reasonId === ALWAYS_REASON;
  if (always ? typeof permissionsSha256 !== 'string' || !DIGEST_HEX.test(permissionsSha256)
    : permissionsSha256 !== undefined) return false;
  return isPlainText(sessionId) && isPlainText(key)
    && isReasonId(reasonId) && CONSENT_REASONS[reasonId].decision === decision
    && typeof inputSha256 === 'string' && DIGEST_HEX.test(inputSha256)
    && typeof cardSha256 === 'string' && DIGEST_HEX.test(cardSha256)
    && typeof at === 'number' && Number.isSafeInteger(at) && at >= 0;
}

function assertSecret(secret: string): void {
  if (!SECRET_HEX.test(secret)) {
    throw new TypeError(`sekret kanału zgód to ${String(CONSENT_SECRET_BYTES)} bajtów jako hex małymi literami`);
  }
}

/**
 * Wiadomość podpisu: {@link CONSENT_MAC_PREFIX} i pola {@link CONSENT_MAC_FIELDS} złączone `|`. Pola poza kontraktem
 * (opis modułu) to `TypeError`: serwer nie podpisuje wiadomości, którą dałoby się odczytać na dwa sposoby.
 */
export function consentMacMessage(fields: ConsentSignedFields): string {
  if (!signedFieldsValid(fields)) throw new TypeError('pola pliku odpowiedzi poza kontraktem podpisu');
  const record = fields as unknown as Readonly<Record<string, unknown>>;
  return CONSENT_MAC_PREFIX + macFieldsOf(record).map((name) => String(record[name])).join(MAC_SEPARATOR);
}

function macOf(secret: string, fields: ConsentSignedFields): Buffer {
  assertSecret(secret);
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(consentMacMessage(fields), 'utf8').digest();
}

/** Kopia samych pól kontraktu: nadmiarowe pole wejścia nie trafia do pliku. */
function contractFields(fields: ConsentSignedFields): ConsentSignedFields {
  return {
    key: fields.key, sessionId: fields.sessionId, decision: fields.decision, reasonId: fields.reasonId,
    inputSha256: fields.inputSha256, cardSha256: fields.cardSha256, at: fields.at,
    ...(fields.permissionsSha256 === undefined ? {} : { permissionsSha256: fields.permissionsSha256 }),
  };
}

/**
 * Plik odpowiedzi z podpisem: pola kontraktu i `mac` (HMAC-SHA256 hex). Sekret albo pola poza kontraktem to
 * `TypeError`.
 */
export function signConsentFile(secret: string, fields: ConsentSignedFields): ConsentFile {
  const mac = macOf(secret, fields).toString('hex');
  return { ...contractFields(fields), mac };
}

/**
 * Weryfikacja pliku odpowiedzi po `JSON.parse`, w kolejności {@link CONSENT_VERIFY_FAILURES}. Ważny plik wraca jako
 * kopia samych pól kontraktu. Sekret poza kontraktem to `TypeError`: to błąd weryfikującego, nie pliku.
 */
export function verifyConsentFile(raw: unknown, expected: ConsentExpectation): ConsentVerdict {
  assertSecret(expected.secret);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'shape' };
  const record = raw as Readonly<Record<string, unknown>>;
  if (Object.hasOwn(record, 'message')) return { ok: false, reason: 'message' };
  const names = Object.keys(record);
  const shape = record['reasonId'] === ALWAYS_REASON ? ALWAYS_FILE_FIELDS : FILE_FIELDS;
  if (names.length !== shape.length || !shape.every((name) => Object.hasOwn(record, name))) {
    return { ok: false, reason: 'shape' };
  }
  const { mac } = record;
  if (!signedFieldsValid(record) || typeof mac !== 'string' || !DIGEST_HEX.test(mac)) {
    return { ok: false, reason: 'shape' };
  }
  const file = record as unknown as ConsentFile;
  if (!timingSafeEqual(macOf(expected.secret, file), Buffer.from(mac, 'hex'))) return { ok: false, reason: 'mac' };
  if (file.sessionId !== expected.sessionId || file.key !== expected.key) return { ok: false, reason: 'binding' };
  if (file.inputSha256 !== expected.inputSha256) return { ok: false, reason: 'input' };
  if (file.cardSha256 !== expected.cardSha256) return { ok: false, reason: 'card' };
  if (file.reasonId === ALWAYS_REASON && file.permissionsSha256 !== (expected.permissionsSha256 ?? null)) {
    return { ok: false, reason: 'permissions' };
  }
  if (file.at < expected.notBefore) return { ok: false, reason: 'stale' };
  return { ok: true, file: { ...contractFields(file), mac } };
}

/**
 * `cardSha256`: sha256 kanonicznej postaci pól karty (`hook/canon.ts`). Brak `agentId` albo `permissionMode`
 * (`undefined`) liczy się jak `null`, nadmiarowe pola wejścia nie wchodzą do skrótu.
 */
export function consentCardSha256(card: ConsentCardFields): string {
  return canonicalSha256({
    sessionId: card.sessionId, toolName: card.toolName, toolInput: card.toolInput, cwd: card.cwd,
    agentId: card.agentId, permissionMode: card.permissionMode,
  });
}

/** Fields of the receipt signature (`POST /claim`): the registration's session, the key and the taken file's `at`. */
export interface ConsentReceiptFields {
  readonly sessionId: string;
  readonly key: string;
  readonly at: number;
}

/**
 * Receipt signature: HMAC-SHA256 hex with the hook's secret over {@link CONSENT_RECEIPT_MAC_PREFIX} and
 * {@link CONSENT_RECEIPT_MAC_FIELDS} joined with `|`. Field rules as in the answer file (module header); a secret or
 * a field outside them is a `TypeError`.
 */
export function consentReceiptMac(secret: string, fields: ConsentReceiptFields): string {
  assertSecret(secret);
  const { sessionId, key, at } = fields;
  if (!isPlainText(sessionId) || !isPlainText(key) || typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) {
    throw new TypeError('receipt fields outside the signature contract');
  }
  const message = CONSENT_RECEIPT_MAC_PREFIX
    + CONSENT_RECEIPT_MAC_FIELDS.map((name) => String(fields[name])).join(MAC_SEPARATOR);
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(message, 'utf8').digest('hex');
}
