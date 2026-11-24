/**
 * Notatki PROJEKTU — JEDEN dokument tekstowy na katalog.
 *
 * Czym to jest: notes człowieka przypięty do katalogu, nie do sesji i nie do agenta. Sesje
 * przychodzą i giną (`agent.list` jest jedyną prawdą o nich), a „deploy wymaga restartu herdr"
 * dotyczy PROJEKTU i ma przeżyć każdą z nich. Dlatego kluczem jest katalog, a nie `sessionId`.
 *
 * Czym NIE jest: kanałem kontekstu dla agenta. Żadna sesja Claude tych notatek nie widzi,
 * nic z nich nie jedzie do promptu i nie ma eksportu do plików projektu — to osobna decyzja,
 * której nikt jeszcze nie podjął.
 *
 * Starszy kształt pliku to TABLICA notatek z `id`, `source` i kasowaniem po jednej. Feedback
 * z telefonu był jednoznaczny („lista jest zbędna, ma być jedno pole") — więc
 * jest tu jeden `text` i jeden `updatedAt`. Stary kształt CZYTAMY DALEJ i sklejamy (patrz
 * {@link readNotes}): na dysku mogą leżeć prawdziwe zdania, których nikt nie odtworzy.
 *
 * Trzy reguły, które nie są kosmetyką:
 *
 * 1. **Klucz na dysku to `sha256(realpathSync(cwd))`**, precedens `termIdFor` z terminala.
 *    `realpath` liczymy TUTAJ, bo `checkCwd` w routerze go NIE robi (oddaje `path.resolve`) —
 *    a bez rozwinięcia dowiązań ten sam projekt otwarty raz przez `/Users/d/Projects/x`, raz
 *    przez zsymlinkowaną ścieżkę, miałby dwa różne pliki notatek i człowiek zobaczyłby pustkę.
 * 2. **Read-modify-write całego pliku WYŁĄCZNIE synchronicznie** — `readFileSync` → mutacja →
 *    `writeFileSync` do tmp → `renameSync`, zero `await` po drodze. To jedyna gwarancja braku
 *    zgubionego zapisu przy dwóch urządzeniach piszących naraz: pętla zdarzeń Node nie ma jak
 *    wejść w środek tej sekwencji.
 * 3. **Błąd zapisu LECI WYJĄTKIEM** (router mapuje go na 500) — świadome odejście od konwencji
 *    „cichy no-op", którą stosuje np. `notify/apns-devices.ts`. Tam gubimy token urządzenia,
 *    który apka poda ponownie przy następnym starcie; tutaj gubilibyśmy JEDYNY egzemplarz
 *    zdania, które człowiek właśnie podyktował. „Zapisane" musi znaczyć zapisane.
 *
 * Reżim plików jest ten sam co przy `answers/` i `pending/`: katalog `0700`, plik `0600`,
 * zapis atomowy. Retencji NIE MA — treść kasuje wyłącznie człowiek.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { notesEmpty } from '@rarog/shared';
import type { NotesDoc } from '@rarog/shared';
import { type OwnText, say, textOf } from '@rarog/shared/sentences';
import { DIRECT_DISK } from '../folder-gate/disk.ts';

/**
 * Katalog plików notatek w `<dataDir>`. Cytują go `docs/security-model.md` (runbook)
 * i `docs/server-config.md`.
 */
export const NOTES_DIRNAME = 'notes';

/** Ile znaków hex ma nazwa pliku projektu — ta sama miara co `TERM_ID_LENGTH`. */
export const NOTES_KEY_LENGTH = 16;

/**
 * Separator sklejania STAREGO pliku (tablica notatek) w jeden dokument: pusta linia, czyli
 * to samo, czym człowiek rozdziela akapity w polu. Wpisy idą NAJSTARSZY PIERWSZY — dokument
 * czyta się od góry jak dziennik, a odwrotna kolejność stawiałaby na wierzchu zdanie napisane
 * ostatnie i mieszała chronologię przy pierwszej ręcznej poprawce.
 */
const MIGRATION_SEPARATOR = '\n\n';

/**
 * Powody, dla których czynność się nie udała — rozróżnialne, bo router odpowiada na każdy inaczej.
 *
 * `cwd-not-allowed` (400) jest tu osobno od 500 z jednego powodu: `realpathSync` na katalogu,
 * którego NIE MA, rzuca `ENOENT`, a `checkCwd` taką ścieżkę przepuszcza, jeśli stoi na liście
 * projektów (lista pochodzi z historii CLI, więc bywa w niej katalog już skasowany).
 * Bez tego rozróżnienia człowiek dostawałby „Błąd serwera" za katalog, którego sam nie ma.
 */
export type NotesError = 'cwd-not-allowed' | 'conflict';

export class NotesFailure extends Error {
  /** `sentence` to zdanie odpowiedzi REST (400 albo 409); `message` to ten sam tekst (logi bez zmian). */
  constructor(readonly code: NotesError, readonly sentence: OwnText, readonly current?: NotesDoc) {
    super(textOf(sentence));
    this.name = 'NotesFailure';
  }
}

/** Plik notatek projektu. `cwd` w środku jest po to, żeby dało się odzyskać osierocone pliki. */
interface NotesFile extends NotesDoc {
  cwd: string;
}

/**
 * Ścieżka pliku notatek projektu.
 *
 * `realpathSync` jest tu, a nie w routerze, bo to TOŻSAMOŚĆ pliku od niego zależy — a router
 * zna tylko `path.resolve`. Katalog, którego nie ma, kończy się `NotesFailure('cwd-not-allowed')`,
 * czyli 400 ze zdaniem o katalogu, a nie 500 o serwerze.
 */
export function notesPath(dataDir: string, cwd: string): string {
  let real: string;
  try {
    real = DIRECT_DISK.sync('realpath', { path: cwd });
  } catch {
    throw new NotesFailure(
      'cwd-not-allowed',
      say('rest.notes-cwd-not-allowed'),
    );
  }
  const key = createHash('sha256').update(real).digest('hex').slice(0, NOTES_KEY_LENGTH);
  return join(dataDir, NOTES_DIRNAME, `${key}.json`);
}

/**
 * Sklejenie STAREGO kształtu pliku (`{notes: [...]}`) w jeden dokument.
 *
 * Wymagamy WYŁĄCZNIE tekstu wpisu — `id`, `source` i znaczniki bywały w pliku zapisane przez
 * wersję, której już nie ma, a odsianie wpisu za brak pola, którego dziś nikt nie czyta,
 * kasowałoby zdanie człowieka przy okazji migracji. Brakujący `createdAt` idzie na koniec
 * (`Number.MAX_SAFE_INTEGER` jest tu „nie wiem kiedy", a nie „najstarsze").
 *
 * `updatedAt` dokumentu to NAJWIĘKSZY znacznik z wpisów. Dzięki temu wersja nie cofa się przy
 * migracji: klient, który miał na ekranie starą notatkę, nie nadpisze sklejonego dokumentu
 * „zgodnie z kontraktem".
 */
export function mergeLegacyNotes(raw: unknown): NotesDoc {
  if (!Array.isArray(raw)) return { text: '', updatedAt: 0 };
  const entries: { text: string; createdAt: number; updatedAt: number }[] = [];
  for (const item of raw) {
    const note = item as { text?: unknown; createdAt?: unknown; updatedAt?: unknown } | null;
    if (note === null || typeof note.text !== 'string' || note.text === '') continue;
    entries.push({
      text: note.text,
      createdAt: typeof note.createdAt === 'number' ? note.createdAt : Number.MAX_SAFE_INTEGER,
      updatedAt: typeof note.updatedAt === 'number' ? note.updatedAt : 0,
    });
  }
  entries.sort((a, b) => a.createdAt - b.createdAt);
  return {
    text: entries.map((entry) => entry.text).join(MIGRATION_SEPARATOR),
    updatedAt: entries.reduce((max, entry) => Math.max(max, entry.updatedAt), 0),
  };
}

/**
 * Wczytanie dokumentu. Brak pliku = projekt bez notatek (normalny stan, nie błąd).
 *
 * Plik NIECZYTELNY (obcięty zapis cudzego procesu, ręczna edycja) też oddaje pustkę,
 * i to jest świadomy wybór między dwoma złymi: wywrócenie odczytu zostawiłoby człowieka
 * z ekranem błędu bez drogi wyjścia, a pusty dokument pozwala pisać dalej. Starego pliku przy
 * tym NIE kasujemy — zapis idzie przez `rename`, więc do pierwszej mutacji leży nietknięty
 * i da się go obejrzeć.
 */
function readFile(path: string, cwd: string): NotesFile {
  const empty: NotesFile = { cwd, text: '', updatedAt: 0 };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return empty;
  }
  let parsed: { cwd?: unknown; notes?: unknown; text?: unknown; updatedAt?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return empty;
  }
  const knownCwd = typeof parsed.cwd === 'string' ? parsed.cwd : cwd;
  /*
   * MIGRACJA: plik w starym kształcie ma tablicę `notes` i żadnego `text`. Sklejamy go
   * przy KAŻDYM odczycie i nie zapisujemy od razu — nowy kształt ląduje na dysku dopiero przy
   * pierwszej mutacji. Odczyt nie ma prawa niczego pisać (GET jest bezskutkowy), a dopóki nikt
   * nie napisał nowej wersji, stary plik jest kopią zapasową sam dla siebie.
   */
  if (Array.isArray(parsed.notes)) return { cwd: knownCwd, ...mergeLegacyNotes(parsed.notes) };
  if (typeof parsed.text !== 'string' || typeof parsed.updatedAt !== 'number') return empty;
  return { cwd: knownCwd, text: parsed.text, updatedAt: parsed.updatedAt };
}

/**
 * Zapis atomowy: tmp w TYM SAMYM katalogu + `rename` — dosłownie wzorzec `writeHookAnswer`
 * (`herdr/dialogs/hook/answers.ts`) i z tego samego powodu, tylko odwrotnie skierowanego: tam czytelnik był
 * obcym procesem, tutaj jest nim drugie żądanie tego samego serwera. Połowa pliku parsuje się
 * na wyjątek, a przy złym cięciu — na poprawny JSON z uciętym tekstem.
 *
 * Błąd NIE jest połykany (patrz nagłówek pliku): wychodzi wyjątkiem do routera i wraca 500.
 */
function writeFile(path: string, dataDir: string, file: NotesFile): void {
  const tmp = `${path}.${String(process.pid)}.tmp`;
  mkdirSync(join(dataDir, NOTES_DIRNAME), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(tmp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Sprzątanie best-effort — tmp bez `rename` nikogo nie obchodzi.
    }
    throw err;
  }
}

/**
 * Magazyn notatek widziany z routera: odczyt i zapis z wersjonowaniem, te same wyjątki
 * (`NotesFailure`) co funkcje niżej. Produkcja: pliki w `<dataDir>/notes/` ({@link fileNotes}); demo:
 * pamięć procesu (`demo/notes.ts`), bo tryb pokazowy nie dotyka dysku, a jego projekty nie istnieją.
 */
export interface NotesBackend {
  read(cwd: string): NotesDoc;
  write(cwd: string, text: string, expectedUpdatedAt: number): NotesDoc;
}

/** Magazyn produkcyjny: dokładnie {@link readNotes} i {@link writeNotes} na katalogu danych Raroga. */
export function fileNotes(dataDir: string): NotesBackend {
  return {
    read: (cwd) => readNotes(dataDir, cwd),
    write: (cwd, text, expectedUpdatedAt) => writeNotes(dataDir, cwd, text, expectedUpdatedAt),
  };
}

/** Dokument notatek projektu. Brak pliku = `{ text: '', updatedAt: 0 }`, nie błąd. */
export function readNotes(dataDir: string, cwd: string): NotesDoc {
  const { text, updatedAt } = readFile(notesPath(dataDir, cwd), cwd);
  return { text, updatedAt };
}

/**
 * Które z PODANYCH katalogów mają niepustą notatkę — jeden bit na projekt, zero treści.
 *
 * Po co: ikona notatki w wierszu projektu (sidebar). Pasek pigułek pyta o JEDEN
 * katalog i robi to `GET`-em; sidebar pokazuje kilkanaście wierszy naraz, więc ta sama droga
 * znaczyłaby kilkanaście żądań. Odpowiedź jedzie więc w ramce `sessions-snapshot`, a liczy się
 * TUTAJ.
 *
 * Pytamy o KATALOGI, które klient i tak zna (`cwd` sesji z tej samej ramki), a nie skanujemy
 * katalogu `notes/`: plik nazywa się skrótem ścieżki, więc listing trzeba by i tak otworzyć,
 * żeby poznać `cwd` — a przy okazji wystawiłby projekty, których w tej ramce nie ma. Koszt to
 * jeden `realpath` + jeden `read` na projekt, raz na otwarcie strumienia (nie na render):
 * przy kilkunastu projektach to ułamek milisekundy, więc cache byłby trzecim stanem do
 * unieważniania bez zysku.
 *
 * Wejście DUPLIKATY dopuszcza (dwie sesje w jednym katalogu) — wyjście jest odsiane.
 * Katalog, którego nie ma, albo plik nie do odczytania NIE przewraca ramki: brak notatki jest
 * normalnym stanem projektu, a lista sesji nie ma prawa zginąć przez notatki.
 */
export function projectsWithNotes(dataDir: string, cwds: readonly string[]): string[] {
  const out: string[] = [];
  for (const cwd of new Set(cwds)) {
    try {
      // `notesEmpty` z kontraktu, a nie własny `trim`: pustkę liczy JEDNA definicja, ta sama,
      // którą niesie bit `empty` w evencie `notes`.
      if (!notesEmpty(readNotes(dataDir, cwd).text)) out.push(cwd);
    } catch {
      // `NotesFailure('cwd-not-allowed')` z `realpath` na skasowanym katalogu — pomijamy.
    }
  }
  return out;
}

/**
 * Zapis z WERSJONOWANIEM. `expectedUpdatedAt` to znacznik, który klient miał na ekranie;
 * niezgodność = 409 z AKTUALNYM dokumentem w wyjątku, żeby front pokazał obie treści zamiast
 * po cichu skasować cudzą poprawkę.
 *
 * Nowy `updatedAt` bierzemy z zegara, ale nigdy nie cofamy się przed poprzedni: dwa zapisy
 * w tej samej milisekundzie dałyby ten sam znacznik, czyli wersję nie do odróżnienia od
 * poprzedniej — a wtedy trzecie urządzenie nadpisałoby drugie „zgodnie z kontraktem".
 */
export function writeNotes(
  dataDir: string,
  cwd: string,
  text: string,
  expectedUpdatedAt: number,
  now: () => number = Date.now,
): NotesDoc {
  const path = notesPath(dataDir, cwd);
  const file = readFile(path, cwd);
  if (file.updatedAt !== expectedUpdatedAt) {
    throw new NotesFailure(
      'conflict',
      say('rest.notes-conflict'),
      { text: file.text, updatedAt: file.updatedAt },
    );
  }
  const next: NotesFile = {
    cwd,
    text,
    updatedAt: Math.max(now(), file.updatedAt + 1),
  };
  writeFile(path, dataDir, next);
  return { text: next.text, updatedAt: next.updatedAt };
}
