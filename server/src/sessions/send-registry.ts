/**
 * Rejestr wysyłek z `clientMessageId` — idempotencja `POST /api/sessions/:id/messages`.
 *
 * Klient natywny trzyma wiadomość w trwałej kolejce i przy zerwanym połączeniu nie wie, czy POST
 * doszedł. „Ponów" wysyła TE SAME bajty z TYM SAMYM identyfikatorem, a ten moduł pilnuje, żeby
 * do panelu poszły najwyżej raz:
 *
 * - **lookup przed wszystkim innym** — wpis przyjęty (`accepted`) oddaje 202 `replayed: true`
 *   bez drugiej mutacji i bez slotu throttle'a, wpis w toku (`pending`) oddaje TĘ SAMĄ obietnicę
 *   (dwa równoległe POST-y kończą się jednym wynikiem), ten sam id z inną treścią albo do innej
 *   sesji to {@link ClientIdConflictError} (409 `client-id-conflict`);
 * - **rezerwacja jest synchroniczna** — wpis `pending` powstaje w tej samej turze pętli zdarzeń,
 *   w której zaczyna się wysyłka, i znika przy KAŻDEJ odmowie, także rzuconej synchronicznie:
 *   odmowa znaczy „nic nie poszło", więc ponowienie z tym samym id ma przejść;
 * - **do rejestru trafia WYŁĄCZNIE przyjęcie (202)** i jest zapisane na dysk PRZED odpowiedzią.
 *   Nieudany zapis nie zmienia odpowiedzi (wiadomość już poszła do panelu), zostawia linię
 *   w logu i wpis w RAM — duplikat grozi dopiero po restarcie.
 *
 * Gwarancja jest OGRANICZONA i opisana w `docs/implementation-spec.md` („Idempotent send"):
 * awaria procesu między zleceniem driverowi a zapisem dopuszcza duplikat, 202 znaczy „przyjęte",
 * nie „dostarczone", a wpis żyje 24 h.
 *
 * Plik (`outbox-ids.json` w `dataDir`, `0o600`): wersja formatu i lista
 * `{id, sessionId, digest, at}` — DWA identyfikatory, skrót sha256 i czas. Treści wiadomości tu
 * nie ma. Mechanika zapisu jak w `herdr/identity.ts`: łańcuch obietnic szereguje zapisy (dwa
 * przyjęcia w jednej turze nie wyścigują się o `rename`), `tmp` + `rename` (proces zabity
 * w trakcie nie zostawia pliku uciętego w połowie), odczyt walidowany — plik uszkodzony albo
 * w nieznanej wersji to pusty rejestr i linia w logu, NIGDY wyjątek przy starcie.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataUrlMime } from '@rarog/shared';
import type { FileAttachment } from '@rarog/shared';
import { CLIENT_ID_CONFLICT_ERROR } from '@rarog/shared/rest';
import { type ServerSentence, say, textOf } from '@rarog/shared/sentences';

/** Nazwa pliku w `dataDir`. Strażnik `docs-zgodnosc.test.ts` wyprowadza z niej wpis w docs. */
export const SEND_REGISTRY_FILENAME = 'outbox-ids.json';

/**
 * Wersja formatu pliku. Inna wartość = plik nowszego (albo cudzego) Raroga: czytamy go jak
 * pusty, a pierwszy zapis nadpisuje go formatem tej wersji. Cena to możliwy duplikat ponowienia,
 * nie utrata wiadomości.
 */
export const SEND_REGISTRY_FORMAT = 1;

/** Okno idempotencji: po 24 h ten sam id jest traktowany jak nowa wiadomość. */
export const SEND_REGISTRY_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * Sufit wpisów (najstarszy wypada pierwszy). Wpis to ~150 bajtów, a jeden człowiek wysyła kilkaset
 * wiadomości dziennie; 2000 to zapas na kilka dni intensywnej pracy, a plik przepisywany przy
 * każdym przyjęciu zostaje poniżej 300 kB.
 */
export const SEND_REGISTRY_MAX = 2_000;

/** Tekst zdania 409 (`session.client-id-conflict`) — klient pokazuje je wprost. */
export const CLIENT_ID_CONFLICT_MESSAGE = say('session.client-id-conflict').text;

/** Fraza linii logu o nieudanym zapisie pliku identyfikatorów (odpowiedź zostaje 202, wpis żyje w RAM). */
export const SEND_REGISTRY_WRITE_FAILED_LOG = 'outbox-ids: write failed';

const FILE_MODE = 0o600;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ID_MAX_LENGTH = 128;

/**
 * Ten sam `clientMessageId` z INNĄ treścią (albo do innej sesji). Router mapuje go na 409 z kodem
 * `client-id-conflict` — po `code`, tak jak resztę wyjątków managera (`managerErrorStatus`).
 */
export class ClientIdConflictError extends Error {
  readonly code = CLIENT_ID_CONFLICT_ERROR;
  override readonly name = 'ClientIdConflictError';
  /** Zdanie 409 dla `errorBodyOf` w routerze; `message` to ten sam tekst (logi bez zmian). */
  readonly sentence: ServerSentence;

  constructor() {
    const sentence = say('session.client-id-conflict');
    super(textOf(sentence));
    this.sentence = sentence;
  }
}

/**
 * sha256 TREŚCI wysyłki: tekst i uporządkowana lista załączników `(rodzaj, nazwa, MIME, sha256
 * bajtów)` — zdjęcia, potem pliki, w kolejności z ciała (ta sama, w jakiej idą do promptu).
 *
 * Same metadane nie wystarczą: dwa zdjęcia tej samej wagi z jednym podpisem dawałyby ten sam skrót,
 * a „Ponów" z innym zdjęciem byłoby cicho połknięte jako powtórka. Kodowanie przez `JSON.stringify`
 * tablicy łańcuchów jest jednoznaczne (granic pól nie da się przesunąć treścią).
 */
export function sendDigest(
  text: string, images: readonly string[] = [], files: readonly FileAttachment[] = [],
): string {
  const attachments = [
    ...images.map((dataUrl) => ['image', '', dataUrlMime(dataUrl), contentDigest(dataUrl)]),
    ...files.map((file) => ['file', file.name, dataUrlMime(file.dataUrl), contentDigest(file.dataUrl)]),
  ];
  return sha256(JSON.stringify([text, attachments]));
}

/** sha256 BAJTÓW data URL-a (base64 odkodowane), nie jego tekstu. */
function contentDigest(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  const header = comma === -1 ? '' : dataUrl.slice(0, comma);
  const body = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
  // Schematy ciała (`imageDataUrlSchema`, `fileDataUrlSchema`) przepuszczają wyłącznie base64;
  // gałąź tekstowa jest pasem bezpieczeństwa dla wołającego spoza routera.
  const bytes = header.endsWith(';base64') ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
  return sha256(bytes);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface SendRegistryKey {
  readonly clientMessageId: string;
  readonly sessionId: string;
  /** {@link sendDigest} ciała żądania. */
  readonly digest: string;
}

export interface SendRegistryOutcome {
  /** `true` = ten id był już przyjęty; nic nie poszło drugi raz. */
  readonly replayed: boolean;
}

export interface SendRegistry {
  /**
   * Wykonuje `send` najwyżej raz na `clientMessageId` w oknie 24 h.
   *
   * Rzuca SYNCHRONICZNIE {@link ClientIdConflictError} i każdy wyjątek rzucony synchronicznie
   * przez `send` (rezerwacja jest wtedy już zwolniona). Obietnica rozwiązuje się PO zapisie
   * rejestru na dysk (albo po nieudanej próbie — wtedy linia w logu).
   */
  run(key: SendRegistryKey, send: () => Promise<void>): Promise<SendRegistryOutcome>;
  /** Liczba wpisów przyjętych (bez wygasłych sprzed ostatniego odczytu) — diagnostyka i testy. */
  readonly size: number;
  /** Czeka na zakończenie zleconych zapisów (testy, `dispose()` managera). */
  flush(): Promise<void>;
}

export interface SendRegistryOptions {
  readonly dataDir: string;
  readonly now?: () => number;
  /** Sufit wpisów — WYŁĄCZNIE seam testowy; domyślnie {@link SEND_REGISTRY_MAX}. */
  readonly max?: number;
  /** Awaria odczytu albo zapisu — same liczby i nazwy plików, nigdy treść. */
  readonly logger?: (line: string) => void;
}

interface AcceptedEntry {
  readonly sessionId: string;
  readonly digest: string;
  readonly at: number;
}

interface PendingEntry {
  readonly sessionId: string;
  readonly digest: string;
  promise: Promise<SendRegistryOutcome>;
}

export function sendRegistryPath(dataDir: string): string {
  return path.join(dataDir, SEND_REGISTRY_FILENAME);
}

const NOT_REPLAYED: SendRegistryOutcome = Object.freeze({ replayed: false });
const REPLAYED: SendRegistryOutcome = Object.freeze({ replayed: true });

const isNonEmptyString = (value: unknown, max = Infinity): value is string =>
  typeof value === 'string' && value !== '' && value.length <= max;

/**
 * Wczytanie rejestru. Brak pliku = pierwszy start (cisza). Plik nie-JSON, w innej wersji albo
 * bez listy = pusty rejestr i JEDNA linia w logu. Pojedynczy wpis bez kompletu pól albo starszy
 * niż okno wypada po cichu.
 */
function loadAccepted(
  file: string, now: number, log: (line: string) => void,
): Map<string, AcceptedEntry> {
  const entries = new Map<string, AcceptedEntry>();
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err: unknown) {
    if ((err as { code?: unknown }).code !== 'ENOENT') {
      log(`outbox-ids: read failed (${describe(err)}) — send registry starts empty`);
    }
    return entries;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    log('outbox-ids: corrupt file (not JSON) — send registry starts empty');
    return entries;
  }
  const body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as { format?: unknown; entries?: unknown }
    : null;
  if (body?.format !== SEND_REGISTRY_FORMAT || !Array.isArray(body.entries)) {
    log('outbox-ids: unknown file format — send registry starts empty');
    return entries;
  }
  for (const item of body.entries) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as { id?: unknown; sessionId?: unknown; digest?: unknown; at?: unknown };
    if (!isNonEmptyString(entry.id, ID_MAX_LENGTH)) continue;
    if (!isNonEmptyString(entry.sessionId, ID_MAX_LENGTH)) continue;
    if (typeof entry.digest !== 'string' || !DIGEST_PATTERN.test(entry.digest)) continue;
    // Czas MUSI być skończoną liczbą: `NaN` w porównaniu z oknem jest zawsze fałszem, więc
    // wpis-śmieć żyłby wiecznie.
    if (typeof entry.at !== 'number' || !Number.isFinite(entry.at)) continue;
    if (now - entry.at >= SEND_REGISTRY_WINDOW_MS) continue;
    entries.delete(entry.id);
    entries.set(entry.id, { sessionId: entry.sessionId, digest: entry.digest, at: entry.at });
  }
  return entries;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createSendRegistry(opts: SendRegistryOptions): SendRegistry {
  const file = sendRegistryPath(opts.dataDir);
  const now = opts.now ?? ((): number => Date.now());
  const log = opts.logger ?? ((): void => {});
  const max = opts.max ?? SEND_REGISTRY_MAX;
  const accepted = loadAccepted(file, now(), log);
  const pending = new Map<string, PendingEntry>();
  let chain: Promise<void> = Promise.resolve();
  /** Zapis zlecony, który jeszcze nie ruszył — następne przyjęcia dołączają do niego. */
  let queued: Promise<void> | null = null;

  /** Wpisy starsze niż okno wypadają; kolejność `Map` = kolejność przyjęć. */
  const prune = (at: number): void => {
    for (const [id, entry] of accepted) {
      if (at - entry.at >= SEND_REGISTRY_WINDOW_MS) accepted.delete(id);
    }
  };

  /*
   * Migawkę bierzemy w chwili STARTU zapisu, nie zlecenia: zapis czekający w łańcuchu obejmie
   * każde przyjęcie sprzed swojego startu, więc dwadzieścia przyjęć w jednej turze to dwa zapisy,
   * a nie dwadzieścia przepisań całego pliku. Obietnica każdego przyjęcia i tak rozwiązuje się
   * dopiero po zapisie, który je zawiera.
   */
  const persist = (): Promise<void> => {
    if (queued !== null) return queued;
    queued = chain.then(async () => {
      queued = null;
      const payload = `${JSON.stringify({
        format: SEND_REGISTRY_FORMAT,
        entries: [...accepted].map(([id, entry]) => ({ id, ...entry })),
      })}\n`;
      const tmp = `${file}.tmp`;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(tmp, payload, { encoding: 'utf8', mode: FILE_MODE });
      await rename(tmp, file);
    }).catch((err: unknown) => {
      /*
       * Łańcuch nie może zostać odrzucony (ten sam powód co w `herdr/identity.ts`): odrzucona
       * obietnica pomijałaby każdy następny zapis do końca życia procesu. Wiadomość już poszła
       * do panelu, więc odpowiedź zostaje 202 — tracimy wyłącznie ochronę przed duplikatem
       * PO restarcie, a w RAM wpis żyje dalej.
       */
      log(
        `${SEND_REGISTRY_WRITE_FAILED_LOG} (${describe(err)}) — ${String(accepted.size)} entr(y/ies)`
        + ' kept in RAM; a retry after restart may duplicate the message',
      );
    });
    chain = queued;
    return queued;
  };

  const accept = (key: SendRegistryKey): Promise<void> => {
    accepted.delete(key.clientMessageId);
    accepted.set(key.clientMessageId, { sessionId: key.sessionId, digest: key.digest, at: now() });
    while (accepted.size > max) {
      const oldest = accepted.keys().next();
      if (oldest.done === true) break;
      accepted.delete(oldest.value);
    }
    return persist();
  };

  return {
    run(key: SendRegistryKey, send: () => Promise<void>): Promise<SendRegistryOutcome> {
      const id = key.clientMessageId;
      prune(now());
      const inFlight = pending.get(id);
      const known = inFlight ?? accepted.get(id);
      if (known !== undefined) {
        if (known.sessionId !== key.sessionId || known.digest !== key.digest) {
          throw new ClientIdConflictError();
        }
        return inFlight !== undefined ? inFlight.promise : Promise.resolve(REPLAYED);
      }

      // Rezerwacja i start wysyłki w TEJ SAMEJ turze pętli — drugi POST z tym id, który wejdzie
      // choćby mikrosekundę później, zobaczy już `pending` i dołączy do tej obietnicy.
      const slot: PendingEntry = {
        sessionId: key.sessionId, digest: key.digest, promise: Promise.resolve(NOT_REPLAYED),
      };
      pending.set(id, slot);
      let started: Promise<void>;
      try {
        started = send();
      } catch (err: unknown) {
        pending.delete(id);
        throw err;
      }
      slot.promise = started.then(
        async () => {
          // `pending` żyje do końca zapisu: powtórka w trakcie zapisu dołącza do tej obietnicy,
          // zamiast dostać `replayed` z RAM, zanim wpis trafi na dysk.
          try {
            await accept(key);
          } finally {
            pending.delete(id);
          }
          return NOT_REPLAYED;
        },
        (err: unknown) => {
          // Odmowa = nic nie poszło do panelu; ponowienie z tym samym id ma dostać nową szansę.
          pending.delete(id);
          throw err;
        },
      );
      return slot.promise;
    },
    get size(): number {
      return accepted.size;
    },
    flush(): Promise<void> {
      return chain;
    },
  };
}
