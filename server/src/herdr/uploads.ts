/**
 * Załączniki z telefonu → pliki, które agent w cudzym panelu może po prostu przeczytać.
 *
 * Dwa rodzaje wejścia, jedna hydraulika: ZDJĘCIA (png/jpeg po downscale) i PLIKI (PDF, log,
 * kod — cokolwiek, co da się dołączyć z telefonu). Różnica jest jedna i jest po stronie TUI:
 * ścieżkę obrazka `claude` sam zamienia w załącznik, a plik agent otwiera `Read`-em. Katalog,
 * prawa, sprzątanie, wykluczenie z gita i format doklejenia ścieżek są WSPÓLNE — rozjazd
 * między nimi byłby wyciekiem albo śmieciem w cudzym repo, zależnie od tego, co się rozjedzie.
 *
 * Sesja SDK dostaje obrazek w wiadomości do silnika. Panel herdr ma tylko jeden kanał wejścia —
 * tekst wklejany do pty — więc jedyna droga na zdjęcie to: zapisz plik, podaj ŚCIEŻKĘ, agent
 * zrobi `Read`. Cała odpowiedzialność tego modułu to zrobić to tak, żeby ten `Read` przeszedł
 * bez dialogu zgody i żeby po sobie posprzątać.
 *
 * Decyzje, które nie są kosmetyką:
 *
 * - **`<cwd>/.rarog-uploads/`, a nie `~/.rarog/uploads`.** Plik spoza workspace'u panelu wywołuje
 *   dialog zgody na `Read`, którego nie ma jak zatwierdzić z telefonu — zdjęcia zamieniłyby
 *   się w pętlę „wyślij i idź do terminala".
 * - **`0700` na katalogu, `0600` na pliku.** Zdjęcie z telefonu bywa zrzutem ekranu z hasłem.
 * - **Nazwa `<ms>-<16 hex>`.** Sama sygnatura czasowa jest zgadywalna: między zapisem a `Read`
 *   agenta ktoś mógłby podstawić inny plik pod przewidzianą nazwę. Załącznik plikowy dokłada
 *   na końcu nazwę oryginalną (`<ms>-<8 hex>-raport-q3.pdf`): bez niej ani agent, ani człowiek
 *   nie wie, co dostał, a jedyne, czego nazwa od użytkownika nie może dotknąć, to POCZĄTEK.
 * - **Wpis w `.git/info/exclude`, nie w `.gitignore`.** Nie modyfikujemy śledzonego pliku w cudzym
 *   repo. Bez wykluczenia licznik `dirtyCount` na karcie sesji zapalałby się od naszych plików.
 * - **Błąd zapisu rzuca.** Cicha wysyłka samego tekstu bez zdjęć to UI, które kłamie: użytkownik
 *   pyta „co jest na tym zrzucie", a agent dostaje pytanie bez zrzutu.
 * - **Nigdy nie idziemy za DOWIĄZANIEM.** `.rarog-uploads` i `.git` leżą w cudzym katalogu roboczym,
 *   a git przechowuje dowiązania z dowolnym celem — `git clone` wrogiego repozytorium do korzenia
 *   projektów materializuje `.rarog-uploads -> ~/Documents` bez żadnej powłoki atakującego. Dlatego
 *   każde dotknięcie tych dwóch nazw poprzedza `lstat` (NIE `stat`, który widzi cel dowiązania):
 *   zapis i `chmod 0700` rzucają, a sprzątanie pomija katalog i mówi o tym w logu.
 * - **The start sweep reads a registry, not the disk tree.** Every successful write records the real path of its
 *   `<cwd>` in `<dataDir>/uploads-dirs.json` (`uploads-registry.ts`), and `sweepAll` cleans only those directories,
 *   each only while `realpath` still gives the entry itself. It walks the roots once, when the registry is missing
 *   or unreadable, and writes the registry from what it found.
 */
import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import {
  FILE_DATA_URL_PATTERN, IMAGE_DATA_URL_PATTERN, UPLOAD_IMAGE_FILE_PATTERN,
} from '@rarog/shared';
import type { FileAttachment } from '@rarog/shared';
import { type AnyText, type ServerSentence, foreign, say, textOf } from '@rarog/shared/sentences';
import { HERDR_UPLOAD_TTL_MS } from '../config.ts';
import { inWorkAreaOnDisk } from '../config/work-area.ts';
import { isProtectedPath } from '../config/protected-dirs.ts';
import { appendRegularFile, readRegularFile } from '../safe-read.ts';
import type { UploadsRegistry } from './uploads-registry.ts';

/** Katalog załączników (zdjęć i plików) wewnątrz workspace'u panelu: zapis, odczyt miniatur i sprzątanie. */
export const UPLOAD_DIR_NAME = '.rarog-uploads';
/** Po tylu godzinach plik jest śmieciem, nie załącznikiem (definicja: `config.ts`). */
export { HERDR_UPLOAD_TTL_MS };
export const UPLOAD_DIR_MODE = 0o700;
export const UPLOAD_FILE_MODE = 0o600;
/**
 * Kształt nazwy zdjęcia — testy i audyt mają po czym poznać nasz plik. JEDNA definicja
 * z protokołem (`UPLOAD_IMAGE_FILE_PATTERN`): ten sam wzorzec bramkuje `read` po stronie
 * serwera i pole `file` wizytówki po stronie schematu, więc nie mają prawa się rozjechać.
 */
export const UPLOAD_NAME_PATTERN = UPLOAD_IMAGE_FILE_PATTERN;

/** Bajty zdjęcia z `.rarog-uploads/` razem z typem — odpowiedź `read`. */
export interface UploadImage {
  bytes: Buffer;
  /** `image/png` albo `image/jpeg` — z rozszerzenia nazwy, bo tylko te dwa `write` zapisuje. */
  mime: string;
}

/** MIME z rozszerzenia nazwy zdjęcia; `null` dla nazwy spoza wzorca. */
export function uploadImageMime(name: string): string | null {
  if (!UPLOAD_NAME_PATTERN.test(name)) return null;
  return name.endsWith('.png') ? 'image/png' : 'image/jpeg';
}
/**
 * Kształt nazwy ZAŁĄCZNIKA PLIKOWEGO: `<unix-ms>-<8 hex>-<nazwa po sanityzacji>`.
 *
 * Oryginalna nazwa ZOSTAJE, bo to jedyna rzecz, po której człowiek w `.rarog-uploads/`
 * i agent w promptcie poznają, co dostali: `raport-q3.pdf` zamiast `1755-9f3a2c11`.
 * Czas i entropia stoją Z PRZODU: nazwa od użytkownika nigdy nie decyduje o początku nazwy
 * na dysku (żadnego `-rf`, żadnej kropki na starcie), a porządek i TTL zostają czytelne.
 */
export const UPLOAD_FILE_NAME_PATTERN = /^\d+-[0-9a-f]{8}-[A-Za-z0-9._-]{1,80}$/;
/** Ile znaków oryginalnej nazwy zostaje po sanityzacji. */
export const MAX_SANITIZED_NAME_CHARS = 80;
/** Nazwa dla załącznika, z którego po sanityzacji nie zostało nic użytecznego. */
export const FALLBACK_UPLOAD_NAME = 'plik';
/** Linia wykluczenia katalogu załączników w `.git/info/exclude`. */
export const EXCLUDE_LINE = `${UPLOAD_DIR_NAME}/`;
/** Sufit odczytu `.git/info/exclude`: dłuższy plik to nie wykluczenia człowieka — nie dopisujemy. */
export const EXCLUDE_MAX_BYTES = 64 * 1024;
/**
 * Sufit odczytu zdjęcia przez `read`. Zdjęcie po downscale ma najwyżej `MAX_IMAGE_DATA_URL_BYTES`
 * (1,5 MB data URL), więc większy plik pod nazwą zdjęcia nie jest zdjęciem Raroga i nie idzie do pamięci.
 */
export const UPLOAD_READ_MAX_BYTES = 4 * 1024 * 1024;
/*
 * Nagłówka bloku zdjęć („Zdjęcia:") CELOWO nie ma — patrz `appendImagePaths`: ścieżka stojąca
 * w osobnej linii zawiesza prompt w polu wejściowym panelu (zmierzone na żywo).
 */
/**
 * Jak głęboko `sweepAll` schodzi w korzenie projektów.
 *
 * 3 poziomy pokrywają realne układy (`~/Projects/<klient>/<projekt>`), a jednocześnie nie
 * zamieniają sprzątania w rekurencyjny skan całego dysku przy każdym starcie Raroga.
 * The walk also skips the macOS-protected folders under home (`config/protected-dirs.ts`). With a registry the walk
 * runs only while the registry is missing or unreadable.
 */
export const SWEEP_MAX_DEPTH = 3;

/**
 * Błąd, którego router ma nie zamieniać w 500.
 *
 * `code` jest dokładnie tym, po czym `managerErrorStatus` rozpoznaje 400 — świadomie zamiast
 * importu `BadRequestError` z managera: `manager.ts` importuje ten moduł, więc import w drugą
 * stronę robiłby cykl.
 */
export class UploadError extends Error {
  readonly code = 'bad-request';
  override readonly name = 'UploadError';
  /** Zdanie dla ciała REST (`errorBodyOf`); `Error.message` to jego tekst, jak w `HerdrError`. */
  readonly sentence: AnyText;

  constructor(sentence: AnyText, options?: ErrorOptions) {
    super(textOf(sentence), options);
    this.sentence = sentence;
  }
}

export interface HerdrUploads {
  /**
   * Zapisuje zdjęcia w `<cwd>/.rarog-uploads/` i zwraca ścieżki BEZWZGLĘDNE (w kolejności wejścia).
   *
   * @param images data URL-e png/jpeg zwalidowane wcześniej przez router; sprawdzamy je drugi raz,
   *               bo ten sam moduł woła driver, a wejście z gniazda nie ma prawa być zaufane.
   */
  write(cwd: string, images: readonly string[]): Promise<readonly string[]>;
  /**
   * Zapisuje ZAŁĄCZNIKI PLIKOWE (PDF, log, kod — cokolwiek) i zwraca ścieżki BEZWZGLĘDNE.
   *
   * Ten sam katalog, te same prawa, ten sam sweep i to samo wykluczenie z gita co zdjęcia —
   * różni się wyłącznie nazwa (zostaje w niej nazwa oryginalna) i to, że agent otwiera taki
   * plik `Read`-em zamiast dostać go jako załącznik TUI.
   *
   * @param files nazwy i data URL-e zwalidowane wcześniej przez router; sprawdzamy je drugi raz,
   *              bo ten sam moduł woła driver, a wejście z gniazda nie ma prawa być zaufane.
   */
  writeFiles(cwd: string, files: readonly FileAttachment[]): Promise<readonly string[]>;
  /**
   * Oddaje bajty ZDJĘCIA zapisanego wcześniej przez `write` — do miniatury w kliencie.
   *
   * Jedyna droga odczytu z `.rarog-uploads/` i świadomie wąska: `name` musi mieć kształt
   * `UPLOAD_NAME_PATTERN` (nazwa nadana przez Raroga, nigdy ścieżka ani plik użytkownika),
   * katalog i plik przechodzą ten sam `lstat` co przy zapisie (dowiązanie = brak), a katalog
   * dokłada WOŁAJĄCY z `cwd` sesji — żądanie z telefonu nie ma jak wskazać innego. Załączniki
   * plikowe (PDF, log) tą drogą nie wychodzą: Rarog nie jest przeglądarką plików.
   *
   * `null` znaczy „nie ma takiego zdjęcia" — po sweepie 48 h, przy złej nazwie i przy każdym
   * błędzie dysku. Nigdy nie rzuca: brak miniatury to chip w transkrypcie, nie awaria.
   */
  read(cwd: string, name: string): Promise<UploadImage | null>;
  /** Kasuje z jednego katalogu pliki starsze niż TTL. Nigdy nie rzuca. */
  sweep(cwd: string): Promise<void>;
  /**
   * Start sweep. With a readable registry: only the registered directories that still resolve to themselves, the
   * roots are not read, and an entry whose `.rarog-uploads` is gone or empty after the sweep, or whose path now leads
   * through a symlink, leaves the registry. With the registry missing or unreadable, or without a registry: a walk
   * of the roots; with a registry it is then written from the directories that still hold files or could not be
   * read. Never throws.
   */
  sweepAll(roots: readonly string[]): Promise<void>;
}

/**
 * Czytnik zdjęć ograniczony do korzeni Raroga: katalog spoza `RAROG_HERDR_ROOTS`
 * nie oddaje niczego, a dysk nie jest pytany.
 *
 * Katalog przychodzi z SESJI (`session.cwd`), nie z żądania — ale to katalog z chwili pojawienia się
 * panelu, a zasięg karty (`outOfScope`) idzie za `cd`. Panel, który wystartował poza korzeniami
 * i przeszedł pod korzeń, ma więc zasięg i stary, prywatny katalog; sama bramka `outOfScope`
 * w routerze by go przepuściła. Ta sama funkcja co w nadzorcy (`scopeOf`).
 */
export function readUploadWithinRoots(
  uploads: Pick<HerdrUploads, 'read'>, roots: readonly string[], home: string = homedir(),
): (cwd: string, name: string) => Promise<UploadImage | null> {
  /*
   * The work area of the roots, the rule of `scopeOf`: a protected folder of home is not read either, also
   * through a link or a root that is a symlink to home. A directory outside the roots still costs no disk access.
   */
  return (cwd, name) => (inWorkAreaOnDisk(cwd, roots, home) ? uploads.read(cwd, name) : Promise.resolve(null));
}

export interface UploadsOptions {
  /** Zegar — testy podają swój, żeby sprawdzić TTL bez czekania 48 h. */
  now?: () => number;
  ttlMs?: number;
  maxDepth?: number;
  /** Home directory for the protected-folder check; tests pass a temporary one. */
  home?: string;
  /**
   * Registry of the directories written to (`uploads-registry.ts`). Without it nothing is recorded and every
   * `sweepAll` walks the roots.
   */
  registry?: UploadsRegistry;
}

/**
 * What one directory sweep left: `gone` (no attachments directory there: missing, a symlink or not a directory),
 * `empty` (no regular file left), `kept` (regular files left) or `unknown` (it could not be read).
 */
type SweepOutcome = 'gone' | 'empty' | 'kept' | 'unknown';

/**
 * Dokleja ścieżki załączników (zdjęć I plików) na KONIEC OSTATNIEJ LINII promptu, po spacji.
 *
 * JEDEN blok na wszystkie załączniki i jedna implementacja doklejania — świadomie. Druga
 * funkcja „a teraz jeszcze pliki" oznaczałaby drugi format do zmierzenia na żywym panelu
 * i drugi sposób, w jaki prompt może zawisnąć w cudzym polu wejściowym.
 *
 * Format jest wynikiem pomiaru na żywym panelu (sesja `rarog-spike`),
 * a nie estetyki. Plan zakładał osobny blok:
 *
 *     <zdanie>
 *
 *     Zdjęcia:
 *     /ścieżka/do/pliku.png
 *
 * i to **nie działa**. TUI `claude` rozpoznaje ścieżkę pliku graficznego i zamienia ją
 * w załącznik `[Image #N]`, ale gdy ścieżka stoi w linii SAMA, prompt zostaje w polu
 * wejściowym NIEWYSŁANY. Zdjęcie z telefonu kończyło podróż w cudzym polu tekstowym,
 * a Rarog raportował „wysłano" — czyli dokładnie to UI, które kłamie.
 *
 * Zmierzone warianty: „zdanie <ścieżka>" ✔ wysłane · „linia\n\nlinia <ścieżka>" ✔ wysłane ·
 * „zdanie\n\nZdjęcia:\n<ścieżka>" ✘ zawisło w polu · prompt wieloliniowy BEZ ścieżki ✔ wysłany.
 * Stąd reguła: nowe linie użytkownika zostają nietknięte, ścieżka nigdy nie zaczyna linii.
 *
 * Pomiar na CLI 2.1.302 i herdr 0.9.5: nic nie zawisa. Dochodzą sama ścieżka, dwie
 * ścieżki po spacji, goła ścieżka pliku i „zdanie\n\nZdjęcia:\n<ścieżka>". Format zostaje, bo
 * działa na obu wersjach.
 *
 * Wiadomość z samych załączników dostaje przed ścieżkami {@link ATTACHMENTS_ONLY_PROMPT}.
 * Nie dla CLI, tylko dla echa: kopię promptu z pliku rozmowy follower poznaje po TEKŚCIE (`echoKey`), a samo
 * zdjęcie tekstu nie ma. Nazwa pliku stoi tylko we wpisie-towarzyszu `[Image: source: …]`, którego CLI nie
 * pisze przy prompcie wchłoniętym w trwającą turę (`queued_command`) — bez stałego tekstu zdjęcie wysłane
 * w trakcie pracy agenta stałoby w transkrypcie dwa razy.
 *
 * Efekt uboczny, który jest zaletą: agent dostaje OBRAZ jako załącznik, a nie ścieżkę do
 * przeczytania narzędziem `Read` — więc nie ma dialogu zgody, którego nie da się
 * zatwierdzić z telefonu.
 *
 * Dla załącznika NIEobrazkowego efektu „[Image #N]" nie ma — ścieżka zostaje ścieżką, którą
 * agent otwiera `Read`-em. Format jest ten sam, bo w jednej wiadomości mogą być oba rodzaje,
 * a mieszanie dwóch układów w jednym promptcie to wracająca regresja, nie estetyka.
 *
 * Ścieżki są bezwzględne: agent ma je wziąć dosłownie, a nie zgadywać względem swojego `cwd`.
 */
export function appendAttachmentPaths(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  const body = text.trimEnd();
  return `${body === '' ? ATTACHMENTS_ONLY_PROMPT : body} ${paths.join(' ')}`;
}

/**
 * Tekst promptu wiadomości z samych załączników. Widzi go agent, a po ponownym wczytaniu transkryptu
 * także dymek człowieka; echo z wysyłki go nie pokazuje (manager zapisuje tekst bez ścieżek i bez tego tekstu).
 */
export const ATTACHMENTS_ONLY_PROMPT = '(załącznik)';

/**
 * Nazwa z czasów, gdy załącznikiem mógł być tylko obrazek.
 *
 * @deprecated używaj `appendAttachmentPaths` — alias żyje tylko po to, żeby przyrost z plikami
 * nie wymagał zmiany w każdym wołającym naraz.
 */
export const appendImagePaths = appendAttachmentPaths;

interface ParsedImage {
  bytes: Buffer;
  ext: 'png' | 'jpg';
}

/** Rozbiera data URL na bajty i rozszerzenie; `null` = cokolwiek innego niż png/jpeg base64. */
export function parseImageDataUrl(dataUrl: string): ParsedImage | null {
  if (!IMAGE_DATA_URL_PATTERN.test(dataUrl)) return null;
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  const ext = dataUrl.slice(0, comma).includes('image/png') ? 'png' : 'jpg';
  const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  if (bytes.length === 0) return null;
  return { bytes, ext };
}

/** Nazwa pliku: czas (porządek i TTL) + entropia (nieodgadywalność). */
function uploadName(nowMs: number, ext: string): string {
  return `${String(nowMs)}-${randomBytes(8).toString('hex')}.${ext}`;
}

/** Rozbiera data URL załącznika na bajty; `null` = zły kształt albo pusta treść. */
export function parseFileDataUrl(dataUrl: string): Buffer | null {
  if (!FILE_DATA_URL_PATTERN.test(dataUrl)) return null;
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  return bytes.length === 0 ? null : bytes;
}

/**
 * Przepisuje nazwę od użytkownika na alfabet, którym da się bezpiecznie zapisać plik.
 *
 * Cztery reguły, każda za konkretny wypadek:
 * 1. `basename` — `../../.ssh/authorized_keys` ma być nazwą pliku, nie ścieżką. Ręcznie po `/`
 *    I po `\`, bo `basename` z POSIX-a nie widzi separatora z Windowsa, a nazwa przychodzi
 *    z cudzej przeglądarki, nie z tego systemu plików.
 * 2. Wszystko spoza `[A-Za-z0-9._-]` → `-`. Spacje, cudzysłowy, `$(…)`, znaki sterujące
 *    i emoji znikają: ta nazwa pojawia się w promptcie cudzego terminala.
 * 3. Kropka na starcie → prefiks `plik-`. Załącznik nie ma prawa wylądować jako plik ukryty
 *    ani jako `.gitignore` w cudzym repo (nazwa i tak dostaje przedrostek z czasem, ale
 *    reguła zostaje jawna — od niej zależy czytelność `ls` w `.rarog-uploads/`).
 * 4. Docięcie do 80 znaków — nazwa pliku na dysku ma jeszcze zmieścić czas i entropię
 *    w limicie 255 bajtów, a 80 znaków wystarcza, żeby poznać, co to za plik.
 */
export function sanitizeUploadName(name: string): string {
  const base = basename(name.split('\\').join('/'));
  let cleaned = '';
  for (const ch of base) {
    cleaned += /[A-Za-z0-9._-]/.test(ch) ? ch : '-';
  }
  // Sama interpunkcja („---", „..") nie niesie żadnej informacji — i nie ma czego poprzedzać
  // prefiksem, więc sprawdzamy to PRZED regułą 3, a nie po niej.
  if (!/[A-Za-z0-9]/.test(cleaned)) return FALLBACK_UPLOAD_NAME;
  if (cleaned.startsWith('.')) cleaned = `${FALLBACK_UPLOAD_NAME}-${cleaned}`;
  cleaned = cleaned.slice(0, MAX_SANITIZED_NAME_CHARS);
  // Docięcie mogło zjeść jedyne litery („-" × 80 + „a.pdf") — nazwa musi zostać niepusta.
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : FALLBACK_UPLOAD_NAME;
}

/** Nazwa załącznika: czas + entropia + nazwa od użytkownika (w tej kolejności). */
function uploadFileName(nowMs: number, name: string): string {
  return `${String(nowMs)}-${randomBytes(4).toString('hex')}-${sanitizeUploadName(name)}`;
}

/**
 * Odmowa zapisu do wpisu, który nie jest katalogiem; rodzaj wpisu wybiera zdanie, bo użytkownik ma wiedzieć,
 * co dokładnie ma usunąć z katalogu projektu.
 */
function notDirectory(info: Stats, dir: string): ServerSentence {
  if (info.isSymbolicLink()) return say('uploads.dir-not-directory.symlink', { dir });
  if (info.isFile()) return say('uploads.dir-not-directory.file', { dir });
  return say('uploads.dir-not-directory.other', { dir });
}

/**
 * Przepuszcza `.rarog-uploads` tylko wtedy, gdy jest ZWYKŁYM katalogiem (albo go jeszcze nie ma).
 *
 * Sedno: `mkdir({recursive:true})` na dowiązaniu do katalogu kończy się SUKCESEM, a `chmod`
 * i `writeFile` podążają za dowiązaniem. Bez tej bramki podłożone `.rarog-uploads -> ~/Documents`
 * przestawiałoby prawa cudzego katalogu na 0700 i wpuszczało tam zdjęcia z telefonu. `stat` by tego
 * nie zobaczył — widzi cel, nie dowiązanie; cała różnica jest w `lstat`.
 *
 * Błąd jest GŁOŚNY, bo alternatywą jest wysyłka, która trafia nie tam, gdzie mówi UI. Wyścig między
 * tym sprawdzeniem a `chmod` wymagałby ŻYWEGO procesu atakującego na Macu, a wektor, przed którym
 * ta bramka stoi (sklonowane repozytorium z dowiązaniem w drzewie), takiego procesu nie daje.
 */
async function assertPlainUploadDir(dir: string): Promise<void> {
  let info: Stats;
  try {
    info = await lstat(dir);
  } catch {
    return; // wpisu nie ma (albo nie da się go obejrzeć) — resztę powie `mkdir`
  }
  if (info.isDirectory()) return;
  throw new UploadError(notDirectory(info, dir));
}

/**
 * Dopisuje linię {@link EXCLUDE_LINE} do `.git/info/exclude`, gdy jej brak — idempotentnie.
 *
 * Best-effort: brak repo, brak praw czy worktree z `.git` jako PLIKIEM (wtedy `info/exclude`
 * leży gdzie indziej) nie mają prawa zablokować wysyłki zdjęcia.
 *
 * `lstat`, nie `stat`: `.git` jako DOWIĄZANIE to cudzy katalog `.git`, do którego dopisywalibyśmy
 * wykluczenie (i tworzyli w nim `info/`). Dowiązane `.git` traktujemy jak `.git`-plik — po prostu
 * odpuszczamy wykluczenie. To samo dla `info/` i samego `exclude`: `git clone` nie materializuje
 * niczego WEWNĄTRZ `.git`, ale agent w sandboksie zapisuje `.git` wprost, więc dowiązanie, FIFO albo
 * urządzenie może stać na każdym członie ścieżki.
 *
 * Trzy stany pliku i jeden zapis: brak (`ENOENT`) — utworzenie z linią; plik zwykły w sufit
 * {@link EXCLUDE_MAX_BYTES} bez linii — dopisanie; cokolwiek innego (dowiązanie, FIFO, urządzenie, plik
 * ponad sufit) — BEZ zapisu. Zapis po nieudanym odczycie byłby `appendFile`, które na FIFO bez
 * czytelnika blokuje wątek puli libuv. Dopisanie sprawdza typ jeszcze raz na własnym deskryptorze
 * (`appendRegularFile`).
 */
async function ensureGitExclude(cwd: string): Promise<void> {
  const gitDir = join(cwd, '.git');
  try {
    const info = await lstat(gitDir);
    if (!info.isDirectory()) return;
    const infoDir = join(gitDir, 'info');
    await mkdir(infoDir).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    });
    if (!(await lstat(infoDir)).isDirectory()) return;
    const file = join(infoDir, 'exclude');
    let current = '';
    try {
      const read = await readRegularFile(file, { maxBytes: EXCLUDE_MAX_BYTES, followSymlink: false });
      if (read === null || read.truncated) return;
      current = read.bytes.toString('utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }
    const present = new Set(current.split('\n').map((line) => line.trim()));
    if (present.has(EXCLUDE_LINE)) return;
    const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
    await appendRegularFile(file, `${prefix}${EXCLUDE_LINE}\n`);
  } catch {
    // celowo cicho — patrz komentarz nad funkcją
  }
}

class Uploads implements HerdrUploads {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxDepth: number;
  readonly #home: string;
  readonly #registry: UploadsRegistry | undefined;

  constructor(opts: UploadsOptions = {}) {
    this.#now = opts.now ?? Date.now;
    this.#ttlMs = opts.ttlMs ?? HERDR_UPLOAD_TTL_MS;
    this.#maxDepth = opts.maxDepth ?? SWEEP_MAX_DEPTH;
    this.#home = opts.home ?? homedir();
    this.#registry = opts.registry;
  }

  async write(cwd: string, images: readonly string[]): Promise<readonly string[]> {
    if (images.length === 0) return [];
    const dir = await this.#prepareDir(cwd);

    const paths: string[] = [];
    try {
      for (const image of images) {
        const parsed = parseImageDataUrl(image);
        if (parsed === null) {
          throw new UploadError(say('uploads.not-image'));
        }
        paths.push(await this.#writeOne(dir, uploadName(this.#now(), parsed.ext), parsed.bytes));
      }
    } finally {
      await this.#remember(cwd, paths);
    }
    return paths;
  }

  async writeFiles(cwd: string, files: readonly FileAttachment[]): Promise<readonly string[]> {
    if (files.length === 0) return [];
    const dir = await this.#prepareDir(cwd);

    const paths: string[] = [];
    try {
      for (const file of files) {
        const bytes = parseFileDataUrl(file.dataUrl);
        if (bytes === null) {
          const shown = sanitizeUploadName(file.name);
          throw new UploadError(say('uploads.bad-content', { name: shown }));
        }
        paths.push(await this.#writeOne(dir, uploadFileName(this.#now(), file.name), bytes));
      }
    } finally {
      await this.#remember(cwd, paths);
    }
    return paths;
  }

  /**
   * Records `cwd` in the registry once a file is on disk, also when a later file of the same message failed: the
   * start sweep must find every file Rarog left. AFTER the write, never before: a start sweep that saw the directory
   * empty drops it unless it was recorded after the sweep's mark, so a record made before the bytes land could be
   * dropped together with the file it should cover. The entry is the real path of `cwd` (no symlink in it): the
   * start sweep cleans an entry only while it still resolves to itself. A `cwd` whose real path cannot be read is
   * not recorded. Never throws: it runs in a `finally`.
   */
  async #remember(cwd: string, written: readonly string[]): Promise<void> {
    if (written.length === 0 || this.#registry === undefined) return;
    const real = await realpath(cwd).catch(() => null);
    if (real !== null) await this.#registry.add(real);
  }

  /**
   * Katalog gotowy do zapisu: prawa 0700, sweep i wykluczenie z gita.
   *
   * Wspólne dla zdjęć i plików — to jest DOKŁADNIE ta część, która nie ma prawa się rozjechać
   * między dwiema drogami wejścia (0700 na jednej, 0755 na drugiej byłoby wyciekiem).
   */
  async #prepareDir(cwd: string): Promise<string> {
    const dir = join(cwd, UPLOAD_DIR_NAME);
    // PRZED `mkdir`, bo `mkdir` na dowiązaniu nie rzuca, a `chmod` niżej idzie za dowiązaniem.
    await assertPlainUploadDir(dir);
    try {
      await mkdir(dir, { recursive: true, mode: UPLOAD_DIR_MODE });
      // `mkdir` przycina tryb umaskiem, a katalog z załącznikami ma być 0700 NIEZALEŻNIE od
      // ustawień powłoki, z której wystartował Rarog.
      await chmod(dir, UPLOAD_DIR_MODE);
    } catch (err) {
      throw new UploadError(say('uploads.mkdir-failed', { dir, reason: foreign(describe(err)) }));
    }

    // Sprzątamy PRZED zapisem, żeby katalog nie puchł przy użytkowniku, który nigdy nie restartuje
    // Raroga. Błąd sprzątania nie ma prawa zablokować wysyłki.
    await this.sweep(cwd);
    await ensureGitExclude(cwd);
    return dir;
  }

  async #writeOne(dir: string, name: string, bytes: Buffer): Promise<string> {
    const path = join(dir, name);
    try {
      // `wx` — nigdy nie nadpisujemy cudzego pliku, nawet gdyby nazwa się powtórzyła.
      await writeFile(path, bytes, { mode: UPLOAD_FILE_MODE, flag: 'wx' });
    } catch (err) {
      throw new UploadError(say('uploads.write-failed', { path, reason: foreign(describe(err)) }));
    }
    return path;
  }

  async read(cwd: string, name: string): Promise<UploadImage | null> {
    const mime = uploadImageMime(name);
    // Wzorzec PRZED jakimkolwiek `join`: nazwa z żądania to wejście niezaufane, a `..` czy
    // ukośnik odpadają tu, zanim staną się ścieżką.
    if (mime === null) return null;
    const dir = join(cwd, UPLOAD_DIR_NAME);
    const path = join(dir, name);
    try {
      // Ta sama bramka co przy zapisie: dowiązanie w miejscu katalogu = nie ma zdjęcia
      // (`lstat` widzi dowiązanie; `stat` widziałby cel). Wyścig między tym sprawdzeniem
      // a otwarciem pliku przyjęty świadomie, tak samo jak przy `write` — patrz
      // `assertPlainUploadDir`: wymaga żywego procesu atakującego na Macu.
      if (!(await lstat(dir)).isDirectory()) return null;
      /*
       * Sam plik czytamy przez JEDEN deskryptor: `O_NOFOLLOW` odmawia
       * otwarcia dowiązania w ostatnim członie ścieżki, a `fstat` na tym samym uchwycie pyta
       * o to, co naprawdę otwarto — między sprawdzeniem a odczytem nie ma już okna na podmianę.
       * Przez `safe-read.ts`: `O_NONBLOCK` (FIFO pod nazwą zdjęcia nie zajmuje wątku puli libuv)
       * i sufit {@link UPLOAD_READ_MAX_BYTES} (większy plik to nie zdjęcie Raroga).
       */
      const read = await readRegularFile(path, { maxBytes: UPLOAD_READ_MAX_BYTES, followSymlink: false });
      return read === null || read.truncated ? null : { bytes: read.bytes, mime };
    } catch {
      return null;
    }
  }

  async sweep(cwd: string): Promise<void> {
    await this.#sweepDir(join(cwd, UPLOAD_DIR_NAME));
  }

  async sweepAll(roots: readonly string[]): Promise<void> {
    const registry = this.#registry;
    if (registry === undefined) {
      await this.#walkRoots(roots);
      return;
    }
    const state = await registry.load();
    if (state.kind === 'ok') {
      await this.#sweepRegistered(registry, state.dirs);
      return;
    }
    await registry.rebuild(await this.#walkRoots(roots));
  }

  /**
   * Sweeps the registered directories whatever the current roots are: the server wrote there itself. A missing
   * directory or a read error does not stop the others. The mark is taken BEFORE the first read, so a directory an
   * upload records during the sweep stays registered even when the sweep saw it empty.
   */
  async #sweepRegistered(registry: UploadsRegistry, dirs: readonly string[]): Promise<void> {
    const mark = registry.mark();
    const leaving: string[] = [];
    for (const cwd of dirs) {
      const outcome = await this.#sweepEntry(cwd);
      if (outcome === 'gone' || outcome === 'empty') leaving.push(cwd);
    }
    if (leaving.length > 0) await registry.drop(leaving, mark);
  }

  /**
   * One registry entry, swept only while its real path is still the entry itself. The `lstat` in `#sweepDir` sees
   * only the last name, `.rarog-uploads`; if the project directory or a parent was later replaced by a symlink,
   * `<cwd>/.rarog-uploads` would lie in another tree, and the sweep would delete its old files. Such an entry leaves
   * the registry with one log line and no file touched (`gone`). A path that no longer resolves is `gone`; any other
   * `realpath` error is `unknown`, so the entry stays for the next start without a sweep.
   */
  async #sweepEntry(cwd: string): Promise<SweepOutcome> {
    let real: string;
    try {
      real = await realpath(cwd);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : 'unknown';
    }
    if (real !== cwd) {
      console.warn(`rarog: dropping ${cwd} from the uploads registry — the path now leads through a symlink; `
        + 'its attachments directory is not cleaned.');
      return 'gone';
    }
    return this.#sweepDir(join(cwd, UPLOAD_DIR_NAME));
  }

  /**
   * Walk of the roots; returns the directories whose `.rarog-uploads` still holds files after the sweep, or could
   * not be read (`unknown`), so the next start tries those again. The walk enters no symlinked directory, so every
   * path it returns is already a real path.
   */
  async #walkRoots(roots: readonly string[]): Promise<string[]> {
    // Home and roots in their on-disk form before the walk: the protected-folder check compares paths as text, so
    // a root that names home in another case (`/users/demo`) or through a symlink would otherwise reach `Desktop`.
    // `fs/promises` `realpath` has the native semantics and returns the stored case on APFS. Only the roots and home
    // are resolved, not every visited folder; a root that does not resolve is skipped, as a missing one always was.
    const home = await realpath(this.#home).catch(() => this.#home);
    const resolved: string[] = [];
    for (const root of roots) {
      if (!isAbsolute(root)) continue;
      const real = await realpath(root).catch(() => null);
      if (real !== null) resolved.push(real);
    }
    const walk: Walk = { seen: new Set<string>(), roots: resolved, home, found: [] };
    for (const root of resolved) {
      await this.#sweepTree(root, this.#maxDepth, walk);
    }
    return walk.found;
  }

  async #sweepTree(dir: string, depth: number, walk: Walk): Promise<void> {
    if (walk.seen.has(dir)) return;
    walk.seen.add(dir);
    // No read at all in a macOS-protected folder (not even `lstat` of `.rarog-uploads`): macOS would ask for access
    // and the walk would wait for an answer nobody gives. A root placed inside such a folder keeps its subtree.
    if (isProtectedPath(dir, walk.roots, walk.home)) return;
    const outcome = await this.#sweepDir(join(dir, UPLOAD_DIR_NAME));
    if (outcome === 'kept' || outcome === 'unknown') walk.found.push(dir);
    if (depth <= 0) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Katalogi ukryte i `node_modules` odpadają: projektów tam nie ma, a skan kosztuje.
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      await this.#sweepTree(join(dir, entry.name), depth - 1, walk);
    }
  }

  async #sweepDir(dir: string): Promise<SweepOutcome> {
    let info: Stats;
    try {
      // `lstat` przed `readdir`: to jest ta ścieżka, która kasuje pliki BEZ żądania z telefonu
      // (sweep startowy leci przy każdym starcie serwera). `readdir` listuje CEL dowiązania,
      // a `unlink` przez nie przechodzi — dowiązane `.rarog-uploads` oznaczałoby ciche kasowanie
      // wszystkiego starszego niż 48 h w cudzym katalogu.
      info = await lstat(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : 'unknown';
    }
    if (!info.isDirectory()) {
      // Cisza wyglądałaby jak sprzątanie, które działa — a to jest ślad po wrogim repo.
      // Rodzaj wpisu po angielsku tylko dla logu; `entryKind` mówi to samo po polsku w komunikacie do apki.
      const kind = info.isSymbolicLink() ? 'a symlink' : info.isFile() ? 'a file' : 'an entry that is not a directory';
      console.warn(`rarog: skipping cleanup of ${dir} — it is ${kind}, not an attachments directory.`);
      return 'gone';
    }
    let names: string[];
    try {
      // `Dirent` z `readdir` nie podąża za dowiązaniem, więc `isFile()` odsiewa dowiązane wpisy.
      names = (await readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isFile())
        .map((e) => e.name);
    } catch {
      return 'unknown';
    }
    const cutoff = this.#now() - this.#ttlMs;
    let left = names.length;
    for (const name of names) {
      const path = join(dir, name);
      try {
        // `lstat` także tutaj — wiek liczymy z tego wpisu, który za chwilę kasujemy, a nie z celu.
        const entry = await lstat(path);
        if (entry.mtimeMs >= cutoff) continue;
        await unlink(path);
        left -= 1;
      } catch {
        // Plik zniknął w międzyczasie albo brak praw — sprzątanie jest best-effort.
      }
    }
    return left === 0 ? 'empty' : 'kept';
  }
}

/** One walk of the roots: visited directories, the resolved roots and home, and what still holds files. */
interface Walk {
  readonly seen: Set<string>;
  readonly roots: readonly string[];
  readonly home: string;
  readonly found: string[];
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createUploads(opts: UploadsOptions = {}): HerdrUploads {
  return new Uploads(opts);
}
