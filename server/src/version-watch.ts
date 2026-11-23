/**
 * Serwer mówi o nowej wersji Claude Code albo herdr: jedna linia w `server.log` na każdą nową wartość i jeden push
 * `version-changed` na paczkę zmian.
 *
 * Dwa źródła, oba istniejące odczyty, bez nowych timerów:
 *
 * - Claude Code: wydanie zainstalowane z dowiązania `~/.local/bin/claude` przy każdym PEŁNYM odczycie czytnika
 *   (`cli-version.ts`, migawka co 30 s); {@link observeCliVersions} owija czytnik. Szybki tik rejestru
 *   (`registryOnly`) dowiązania nie czyta, więc nic nie zgłasza.
 * - herdr: wynik walidowanego `ping` na ticku resyncu nadzorcy (`herdr/supervisor.ts`, `onVersion`). Bramka
 *   protokołu gniazda zapamiętuje wersję do utraty gniazda, a `herdr update --handoff` zmienia program pod tym
 *   samym gniazdem.
 *
 * Reguły obserwatora:
 *
 * - Stan żyje w `<dataDir>/versions-seen.json` (`{format: 1, versions: {"claude-code"?, herdr?}}`, `0o600`, zapis
 *   tmp+rename). Program bez zapisanej wersji (pierwszy start, plik bez tego pola) zapisuje ją bez pushu i bez linii.
 * - `null`, brak odczytu i wersja spoza {@link VERSION_RE} (chwilowy brak herdr, dowiązanie bez numeru wydania) niczego nie
 *   zmieniają, także pliku.
 * - Każda inna wartość niż zapisana, także niższa, to zmiana. Zmiany z okna {@link VERSION_PUSH_SETTLE_MS} od
 *   pierwszej (okno liczy się od niej, także gdy timer czekał już na zapis wersji bazowej) idą JEDNYM pushem
 *   (jednoczesna aktualizacja obu programów, restart serwera po obu); każda dostaje jedną linię `versions: <program> <stara> → <nowa> (push: <wynik>)`.
 * - Plik zapisuje się dopiero po oknie, razem z pushem. Restart serwera w oknie zostawia starą wersję w pliku, więc
 *   następny start zgłosi zmianę jeszcze raz: push nie ginie. Nieudany zapis ponawia następny odczyt, bez pushu.
 * - Plik nieczytelny albo spoza kształtu: jedna linia, stan od zera (zapis bieżących wersji bez pushu).
 * - Obserwator nigdy nie rzuca. Odczyty i zapisy idą jednym łańcuchem, po kolei.
 *
 * Push to same numery wersji (`notify/content.ts`, `buildVersionContent`), bez treści sesji. Apka pokazuje baner
 * w tle i na wierzchu, a tap otwiera ekran „Serwer”.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CliVersionReader } from './cli-version.ts';
import type { Scheduler, TimerHandle } from './drivers/runtime.ts';
import { systemScheduler } from './drivers/runtime.ts';
import { buildVersionContent } from './notify/content.ts';
import type { PushContent, SendOutcome, VersionChange, VersionedProduct } from './notify/content.ts';
import { readRegularFile } from './safe-read.ts';

/** Nazwa pliku stanu w `dataDir`. */
export const VERSIONS_SEEN_FILENAME = 'versions-seen.json';

/**
 * Okno sklejania zmian w jeden push. Oba źródła odczytują co 30 s (`CLI_VERSION_POLL_MS`, `HERDR_RESYNC_MS`), więc
 * w 45 s każde zdąży raz, z zapasem na wolny resync.
 */
export const VERSION_PUSH_SETTLE_MS = 45_000;

/**
 * Kształt wersji, którą obserwator przyjmuje: numer w rodzaju `2.1.321` albo `0.9.5-rc.1`, najwyżej 20 znaków, więc
 * zdanie z czterema wersjami mieści się na banerze, a linia logu nie niesie niczego poza numerem.
 */
export const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,19}$/u;

/** Wersja pliku stanu. */
const FORMAT = 1;

/** Sufit odczytu pliku stanu: dwa numery wersji to ok. 100 B, dłuższy plik to plik nie nasz. */
const SEEN_MAX_BYTES = 4096;

/** Nazwa programu w linii logu. */
const PRODUCT_NAME: Readonly<Record<VersionedProduct, string>> = {
  'claude-code': 'Claude Code',
  herdr: 'herdr',
};

const PRODUCTS: readonly VersionedProduct[] = ['claude-code', 'herdr'];

type Versions = Partial<Record<VersionedProduct, string>>;

export interface VersionWatchOptions {
  readonly dataDir: string;
  /** Wysyłka pushu do urządzeń (`ApnsSink.send`); bez kanału APNs wołający oddaje `no-receiver`. */
  readonly send: (content: PushContent) => Promise<SendOutcome>;
  readonly log: (line: string) => void;
  /** Timer okna sklejania; domyślnie systemowy. */
  readonly scheduler?: Pick<Scheduler, 'setTimeout' | 'clearTimeout'>;
  /** Długość okna sklejania; domyślnie {@link VERSION_PUSH_SETTLE_MS}. */
  readonly settleMs?: number;
}

export interface VersionWatch {
  /** Odczyt wersji programu; `null` i `undefined` = „nie wiem”. Nigdy nie rzuca. */
  observe(product: VersionedProduct, version: string | null | undefined): void;
  /** Spełnia się, gdy przetworzone są wszystkie dotychczasowe odczyty i wysyłki (testy, zamykanie). */
  idle(): Promise<void>;
  /** Koniec obserwacji: timer okna znika, zmiana z niewysłanego okna zostaje do następnego startu. */
  dispose(): void;
}

/** Plik stanu → wersje; `null` = plik spoza kształtu. */
function parseSeen(text: string): Versions | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const versions = record['versions'];
  if (record['format'] !== FORMAT || typeof versions !== 'object' || versions === null || Array.isArray(versions)) {
    return null;
  }
  const out: Versions = {};
  for (const product of PRODUCTS) {
    const raw = (versions as Record<string, unknown>)[product];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || !VERSION_RE.test(raw)) return null;
    out[product] = raw;
  }
  return out;
}

/** Kod błędu systemu plików do linii logu (bez ścieżki i treści). */
const codeOf = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'error';
};

export function createVersionWatch(opts: VersionWatchOptions): VersionWatch {
  const scheduler = opts.scheduler ?? systemScheduler;
  const settleMs = opts.settleMs ?? VERSION_PUSH_SETTLE_MS;
  const file = join(opts.dataDir, VERSIONS_SEEN_FILENAME);
  let current: Versions = {};
  /** Wersje różne od pliku, czekające na zapis. */
  let dirty = false;
  /** Zmiany z bieżącego okna: program → wersja sprzed okna i ostatnia odczytana. */
  const batch = new Map<VersionedProduct, VersionChange>();
  let timer: TimerHandle | null = null;
  let disposed = false;
  let loaded = false;
  let chain: Promise<void> = Promise.resolve();

  /** Jeden krok łańcucha; błąd kroku nie zrywa łańcucha. */
  const enqueue = (step: () => Promise<void>): void => {
    chain = chain.then(step).catch((err: unknown) => {
      opts.log(`versions: internal error — ${(err as Error).message}`);
    });
  };

  const load = async (): Promise<void> => {
    loaded = true;
    let text: string | null;
    try {
      // Brama plików zwykłych: FIFO, urządzenie albo dowiązanie pod tą nazwą to plik nieczytelny,
      // a nie zawieszony odczyt.
      const read = await readRegularFile(file, { maxBytes: SEEN_MAX_BYTES, followSymlink: false });
      text = read === null || read.truncated ? null : read.bytes.toString('utf8');
    } catch (err) {
      if (codeOf(err) !== 'ENOENT') {
        opts.log(`versions: ${VERSIONS_SEEN_FILENAME} unreadable — starting over without a push`);
        dirty = true;
      }
      return;
    }
    const parsed = text === null ? null : parseSeen(text);
    if (parsed === null) {
      opts.log(`versions: ${VERSIONS_SEEN_FILENAME} unreadable — starting over without a push`);
      dirty = true;
      return;
    }
    current = parsed;
  };

  /** Zapis pliku stanu; `false` = nie wyszło (linia w logu), plik czeka na następną próbę. */
  const write = async (): Promise<boolean> => {
    const body = `${JSON.stringify({ format: FORMAT, versions: current })}\n`;
    const tmp = join(opts.dataDir, `.${VERSIONS_SEEN_FILENAME}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await mkdir(opts.dataDir, { recursive: true, mode: 0o700 });
      await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(tmp, file);
      return true;
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      opts.log(`versions: ${VERSIONS_SEEN_FILENAME} not written (${codeOf(err)})`);
      return false;
    }
  };

  const flush = async (): Promise<void> => {
    if (disposed) return;
    const changes = PRODUCTS.flatMap((product) => {
      const change = batch.get(product);
      return change === undefined || change.from === change.to ? [] : [change];
    });
    batch.clear();
    // Nieudany zapis zostawia `dirty`: następny odczyt (co 30 s) próbuje jeszcze raz, bez ponownego pushu, bo
    // zmiany z tego okna są już rozliczone. Bez tego restart wysłałby ten sam push drugi raz.
    if (dirty) dirty = !(await write());
    if (changes.length === 0) return;
    let outcome: SendOutcome;
    try {
      outcome = await opts.send(buildVersionContent(changes));
    } catch {
      outcome = 'failed';
    }
    for (const change of changes) {
      opts.log(`versions: ${PRODUCT_NAME[change.product]} ${change.from} → ${change.to} (push: ${outcome})`);
    }
  };

  /**
   * Okno sklejania. `restart` = pierwsza zmiana w pustej paczce: timer uzbrojony wcześniej tylko do zapisu (wersja
   * bazowa, plik do przepisania) startuje od nowa, więc pełne okno liczy się od pierwszej zmiany.
   */
  const arm = (restart = false): void => {
    if (disposed) return;
    if (timer !== null && restart) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
    if (timer !== null) return;
    timer = scheduler.setTimeout(() => {
      timer = null;
      enqueue(flush);
    }, settleMs);
    // Okno nie trzyma procesu przy życiu (zamykanie serwera): niewysłana zmiana wraca przy następnym starcie.
    (timer as { unref?: () => void } | null)?.unref?.();
  };

  return {
    observe(product, version) {
      if (disposed || typeof version !== 'string' || !VERSION_RE.test(version)) return;
      enqueue(async () => {
        if (!loaded) await load();
        if (disposed) return;
        const before = current[product];
        if (before === version) {
          // Plik do przepisania (zepsuty) czeka na okno także wtedy, gdy wersja się nie zmienia.
          if (dirty) arm();
          return;
        }
        current = { ...current, [product]: version };
        dirty = true;
        if (before === undefined) {
          arm();
          return;
        }
        const first = batch.size === 0;
        const from = batch.get(product)?.from ?? before;
        batch.set(product, { product, from, to: version });
        arm(first);
      });
    },
    idle: () => chain,
    dispose() {
      disposed = true;
      if (timer !== null) scheduler.clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * Czytnik wersji Claude Code (`cli-version.ts`), który każde PEŁNE odczytanie dowiązania zgłasza obserwatorowi.
 * Wynik i błędy czytnika przechodzą bez zmian.
 */
export function observeCliVersions(
  reader: CliVersionReader, watch: Pick<VersionWatch, 'observe'>,
): CliVersionReader {
  return async (readOpts) => {
    const snapshot = await reader(readOpts);
    if (readOpts?.registryOnly !== true) watch.observe('claude-code', snapshot.installed);
    return snapshot;
  };
}
