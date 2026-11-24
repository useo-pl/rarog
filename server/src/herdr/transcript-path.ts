/**
 * Gdzie leży plik transkryptu sesji silnika — po UUID, a nie po założeniu o katalogu.
 *
 * Problem, który ten moduł rozwiązuje: `join(root, projectSlug(cwd), uuid)` jest prawdziwe
 * w 99 % przypadków i FAŁSZYWE dokładnie tam, gdzie boli. `claude --resume <uuid>` uruchomiony
 * w innym katalogu niż oryginalny dopisuje do pliku w SLUGU ORYGINALNYM (zweryfikowane), tak
 * samo rozwidlenie sesji. Rarog szukałby wtedy pliku pod adresem, pod którym on nigdy nie
 * powstanie — a warstwa treści zgłaszałaby GŁOŚNY alarm „transkrypt nie powstaje" na sesji,
 * która jest zdrowa i pisze normalnie.
 *
 * Kolejność jest kompromisem kosztu: najpierw jedno `stat` pod oczywistym adresem (trafienie
 * w niemal każdym przypadku), a dopiero po pudle jeden `readdir` korzenia (42 katalogi,
 * zmierzone) i równoległe `stat` kandydatów. Glob jest tanim wyjątkiem, nie ścieżką domyślną.
 *
 * Granica bezpieczeństwa: `uuid` przechodzi `ENGINE_SESSION_ID_PATTERN` PRZED jakimkolwiek
 * `join`. Identyfikator bywa wejściem z requestu (`resumeFrom`), a `../../…` czytałoby dowolny
 * plik konta użytkownika.
 *
 * The module also keeps the requests to look a file not found yet up now (`LookupRequests`); the follower's retry
 * chain runs the lookups.
 */
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { projectSlug } from '../cli-store.ts';
import { ENGINE_SESSION_ID_PATTERN, parseImportLine } from '../transcript-import.ts';

/** Rozszerzenie plików magazynu CLI. */
export const TRANSCRIPT_EXT = '.jsonl';

/** Czy pod tą ścieżką jest zwykły plik? Brak dostępu = „nie ma", nigdy wyjątek. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Szuka pliku transkryptu po UUID sesji silnika.
 *
 * @param root korzeń magazynu CLI (`~/.claude/projects`)
 * @param cwd katalog, w którym sesja pracuje TERAZ — daje slug pierwszego strzału
 * @param uuid `agentSessionId` (nazwa pliku bez rozszerzenia)
 * @returns ścieżka pliku albo `null`, gdy nie ma go ani pod slugiem, ani nigdzie w korzeniu
 */
export async function locateTranscript(
  root: string, cwd: string, uuid: string,
): Promise<string | null> {
  if (!ENGINE_SESSION_ID_PATTERN.test(uuid)) return null;
  const name = `${uuid}${TRANSCRIPT_EXT}`;

  const slug = projectSlug(cwd);
  const direct = join(root, slug, name);
  if (await isFile(direct)) return direct;

  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== slug)
      .map((entry) => entry.name)
      // Kolejność `readdir` zależy od systemu plików; sortujemy, żeby wynik globu był
      // POWTARZALNY — inaczej ten sam plik znajdowałby się raz tu, raz tam.
      .sort();
  } catch {
    return null;
  }

  const candidates = dirs.map((dir) => join(root, dir, name));
  const hits = await Promise.all(candidates.map(async (path) => (
    await isFile(path) ? path : null
  )));
  return hits.find((path): path is string => path !== null) ?? null;
}

/**
 * Requests to look a transcript file up now, and which lookup answers them. A lookup answers only the requests made
 * before it began: one that began earlier may have read the store before the file was created, so after its miss
 * a request stays open and the follower looks again at once.
 */
export class LookupRequests {
  #asked = 0;
  #answered = 0;
  #running = 0;

  /** A request; `true` when no lookup is running, so the caller starts one now. */
  ask(): boolean {
    this.#asked += 1;
    return this.#running === 0;
  }

  /** A lookup begins; the mark goes to {@link LookupRequests.ended}. */
  began(): number {
    this.#running += 1;
    return this.#asked;
  }

  /** The lookup that began at `mark` ended, with a file or without one. */
  ended(mark: number): void {
    this.#running -= 1;
    this.#answered = Math.max(this.#answered, mark);
  }

  /** The file is found: that answers every request, also one made while the lookup ran. */
  found(): void {
    this.#answered = this.#asked;
  }

  /** A request that no ended lookup answers yet. */
  get unanswered(): boolean {
    return this.#answered < this.#asked;
  }
}

/**
 * Ile bajtów prefiksu wystarczy, żeby rozstrzygnąć „czy w tym pliku była rozmowa".
 *
 * Sesja wznowiona ma pierwszą wypowiedź w pierwszych kilku linijkach; pół megabajta nagłówka
 * bez ani jednej wypowiedzi to plik, którego i tak nie da się wziąć za świeży `/clear`.
 */
const CONVERSATION_PROBE_BYTES = 512 * 1024;

/**
 * Czy plik transkryptu niesie ROZMOWĘ, czy tylko hydraulikę CLI?
 *
 * Samo istnienie pliku nie odróżnia `/clear` od `/resume`: CLI zakłada
 * plik nowej sesji NATYCHMIAST po `/clear` i od razu wpisuje do niego `custom-title`, `mode`,
 * `file-history-snapshot` oraz echo samej komendy (`<command-name>/clear</command-name>`).
 * Test „plik istnieje" widziałby to jako wznowienie i mówiłby użytkownikowi, że panel przełączył
 * się na wcześniejszą sesję — dokładnie odwrotnie niż w rzeczywistości.
 *
 * Rozstrzyga więc TREŚĆ: `parseImportLine` oznacza `conversational` wyłącznie wypowiedź człowieka
 * albo agenta — wpisy meta, sidechainy i hydraulikę CLI odsiewa (`transcript-import.ts`). Wpis
 * komendy lokalnej i jej wynik są notkami `system` z `message`, ale nie
 * wypowiedzią: po `/clear` nowy plik niesie właśnie je (`<command-name>/clear`, pusty wynik), więc
 * test „jest `message`” wziąłby `/clear` za `/resume`. Po `/resume` wypowiedzi są pełen plik.
 *
 * Czytamy tylko prefiks: pliki bywają 40-megabajtowe, a odpowiedź stoi na początku.
 *
 * @returns `true`, gdy w prefiksie jest choć jedna wypowiedź (albo gdy prefiks skończył się
 *          przed końcem pliku — tak duży plik nie jest świeżym `/clear`); `false` przy każdym
 *          problemie z odczytem, bo komunikat obiecujący historię jest gorszy od odwrotnego.
 */
export async function transcriptHasConversation(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'r');
  } catch {
    return false;
  }
  try {
    const buffer = Buffer.alloc(CONVERSATION_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, CONVERSATION_PROBE_BYTES, 0);
    const text = buffer.toString('utf8', 0, bytesRead);
    // Ostatnia linia prefiksu bywa ucięta w połowie wpisu — bierzemy tylko domknięte.
    const cut = text.lastIndexOf('\n');
    if (cut !== -1) {
      for (const line of text.slice(0, cut).split('\n')) {
        const entry = parseImportLine(line);
        if (entry !== null && entry.conversational) return true;
      }
    }
    return bytesRead >= CONVERSATION_PROBE_BYTES;
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
