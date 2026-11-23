/**
 * Przegląd pliku GŁÓWNEGO rozmowy sprzed okna ogona: linie o zadaniach w tle z tej części
 * pliku, której follower przy podpięciu nie czyta.
 *
 * Follower (`herdr/jsonl-follow.ts`) przy podpięciu czyta ogon pliku (do 8 MiB): tyle wystarcza
 * na historię rozmowy, ale za mało dla listy zadań. Subagent, którego start i wznowienie leżą
 * przed oknem, był po każdym restarcie Raroga niewidoczny do swojego następnego postoju,
 * a własne komendy subagentów sprzed okna miały „los nieznany". Ten moduł podaje maszynie stanów
 * (`reducer.ts`) resztę pliku: od początku do miejsca, w którym zaczyna się okno.
 *
 * Trzy decyzje:
 *
 * 1. **Strumieniowo.** Plik idzie porcjami (`chunkBytes`), w pamięci stoi najwyżej jedna porcja
 *    i jedna niedokończona linia. Każda porcja to osobny odczyt, więc pętla zdarzeń dostaje
 *    oddech między porcjami.
 * 2. **Prefiltr przed `JSON.parse`.** Większość bajtów pliku to wyniki zwykłych narzędzi, które
 *    listy zadań nie zmieniają. Parsowana jest tylko linia, która MOŻE ją zmienić
 *    ({@link mayCarryTask}), oraz każda linia, dopóki reduktor nie zna czasu pierwszego wpisu
 *    (`firstEntryAt`, z niego bierze się `since`). Wynik ma być taki sam jak przy podaniu
 *    reduktorowi każdej linii: pilnuje tego test różnicowy na fixture'ach, a pomiar na
 *    183 plikach sesji tego konta (344,5 MiB, 103 777 linii) nie dał ani jednej różnicy stanu po
 *    żadnej linii ani dla 1094 początków okna w środku pliku. Parsowanych było 14% linii i 20%
 *    bajtów, a cały przegląd kosztował około 1,3 ms na MiB.
 * 3. **Granica co do bajtu.** Okno ogona zaczyna się w środku linii i tę pierwszą, uciętą linię
 *    wyrzuca. Przegląd bierze więc wszystko do pierwszego `\n` o pozycji nie mniejszej niż
 *    początek okna, włącznie: żadna linia nie trafia do reduktora dwa razy i żadna nie ginie.
 *
 * Dwie znane różnice wobec „każdej linii", obie bez skutku w zmierzonych plikach:
 *
 * - mapa wywołań czekających na wynik w reduktorze. Wynik zwykłej komendy `Bash` prefiltra nie
 *   przechodzi, więc jej wywołanie zostaje w mapie, aż wypchnie je sufit (`PENDING_CALLS_MAX`,
 *   256 najnowszych). Start zadania stoi zaraz po swoim wywołaniu, więc sufit go nie dosięga;
 *   to ten sam kompromis co w czytniku pliku subagenta;
 * - linia dłuższa niż `lineMaxBytes` jest pomijana w całości, także gdyby mówiła o zadaniu.
 *
 * Drugie ujście: lista artefaktów sesji (`artifacts.ts`) z własnym prefiltrem
 * ({@link mayCarryArtifact}). Przy podpięciu followera oba ujścia dostają linie w jednym przejściu.
 * Po skróceniu pliku albo przeskoku przyrostu follower woła przegląd jeszcze raz, z samym ujściem
 * artefaktów, od początku pliku do miejsca, od którego czyta dalej: lista, która tylko się sumuje, nie
 * odbuduje się z przyszłych linii jak lista zadań.
 *
 * Moduł nigdy nie rzuca: awaria odczytu to wynik `failed`, a wołający zostaje przy samym oknie.
 * Słowa CLI, po których prefiltr poznaje linię, stoją w rejestrze `cli-shapes.ts`.
 */
import { open } from 'node:fs/promises';
import { parseJsonlEntry } from '../jsonl-pending.ts';
import type { ArtifactsTracker } from './artifacts.ts';
import { CLI_SHAPES, literalSource } from './cli-shapes.ts';
import { emptyCarry, takeLines } from './jsonl-lines.ts';
import { TASK_TOOLS } from './reducer.ts';
import type { BackgroundTasksTracker } from './reducer.ts';

/** Jedna porcja odczytu. Między porcjami pętla zdarzeń dostaje oddech. */
export const MAIN_SCAN_CHUNK_BYTES = 1024 * 1024;
/**
 * Sufit przeglądu: ile bajtów przed oknem wolno przejść. Ponad nim przegląd się NIE odbywa
 * i lista zadań powstaje z samego okna, jak przed przeglądem.
 *
 * 1 GiB. Pomiar: największy plik rozmowy w magazynie CLI tego konta ma 236 MiB (żywy
 * 169 MiB), a przegląd kosztuje ok. 2,5 ms na MiB, więc plik równy sufitowi to ok. 2,5 s w tle,
 * porcjami z oddechem dla pętli zdarzeń. Sufit tuż nad największym plikiem byłby za niski: rozmowa,
 * która go przerośnie, po restarcie serwera gubiłaby zadania w tle i artefakty sprzed okna. Sufit jest od
 * plików, których nikt nie przewidział, nie od zwykłej pracy. Ten sam sufit ma przegląd nazwy rozmowy
 * (`TITLE_SCAN_MAX_BYTES` w `jsonl-follow.ts`).
 */
export const MAIN_SCAN_MAX_BYTES = 1024 * 1024 * 1024;
/**
 * Sufit długości jednej linii; dłuższa jest pomijana w całości, bez składania jej w pamięci.
 * Najdłuższa linia w plikach głównych tego konta ma 1,3 MiB (wynik `Read` z obrazem).
 */
export const MAIN_SCAN_LINE_MAX_BYTES = 8 * 1024 * 1024;

const NEWLINE = 0x0a;

/** Nazwa pola tak, jak stoi w linii pliku: w cudzysłowie. Cytat w treści ma cudzysłów po ukośniku. */
const field = (name: string): string => `"${name}"`;

/** Wzorzec „którykolwiek z tych napisów", dosłownie: znaki specjalne wyrażeń regularnych bez znaczenia. */
const anyOf = (needles: readonly string[]): RegExp => new RegExp(needles.map(literalSource).join('|'));

/**
 * Blok wywołania narzędzia: `"tool_use"` w cudzysłowie. Wynik narzędzia niesie `tool_use_id`,
 * którego ten napis nie łapie.
 */
const TOOL_USE = '"tool_use"';
/**
 * Igły, z których każda wystarcza sama. Każda odpowiada jednej drodze w `reducer.ts`:
 *
 * - znacznik meldunku: koniec, postój albo zdarzenie zadania, we wszystkich trzech nośnikach
 *   (wpis `user`, kolejka, załącznik);
 * - pola startu w wyniku narzędzia: subagent, workflow (rodzaj zadania), komenda;
 * - pola startu monitora (`timeoutMs`, `persistent`): reduktor rozpoznaje go po co najmniej jednym z nich;
 * - pole wznowienia subagenta;
 * - zdanie `TaskStop` i pole `TaskOutput`: dwie drogi końca bez meldunku.
 */
const NEEDLES: readonly string[] = [
  CLI_SHAPES.notification.literals.open,
  field(CLI_SHAPES.taskStart.literals.agentId),
  field(CLI_SHAPES.taskStart.literals.taskType),
  field(CLI_SHAPES.taskStart.literals.backgroundTaskId),
  field(CLI_SHAPES.monitorStart.literals.timeoutMs),
  field(CLI_SHAPES.monitorStart.literals.persistent),
  field(CLI_SHAPES.agentResume.literals.resumedAgentId),
  CLI_SHAPES.taskStop.literals.messagePrefix,
  field(CLI_SHAPES.taskOutput.literals.retrievalStatus),
];
/** Cokolwiek, co w ogóle warto oglądać: wywołanie narzędzia albo któraś z igieł. */
const ANY = anyOf([TOOL_USE, ...NEEDLES]);
/** Sama igła, bez wywołania narzędzia. */
const NEEDLE = anyOf(NEEDLES);
/**
 * Nazwy narzędzi, po których może powstać zadanie w tle, tak jak stoją w linii: w cudzysłowie.
 * Lista jest TA SAMA, po której reduktor zapamiętuje wywołanie (`TASK_TOOLS`), więc nowe
 * narzędzie w reduktorze od razu przechodzi przez prefiltr.
 */
const TASK_TOOL = anyOf(TASK_TOOLS.map(field));

/**
 * Czy linia pliku głównego MOŻE zmienić listę zadań w tle. Tani prefiltr przed `JSON.parse`:
 * fałszywe „tak" kosztuje jedno parsowanie, fałszywego „nie" być nie może.
 *
 * Wywołanie narzędzia liczy się tylko razem z nazwą narzędzia zadań: reduktor zapamiętuje
 * wyłącznie takie wywołania (opis i treść komendy dla zadania, które z nich powstanie), a wywołań
 * `Write` i `Edit` z całą treścią pliku jest w rozmowie najwięcej bajtów.
 *
 * Jak: linia czytana bajt w bajt jako napis (`latin1`: jeden bajt to jeden znak, bez
 * dekodowania UTF-8) i JEDEN przebieg wzorca z wszystkimi igłami. Igły są czystym ASCII, a bajty
 * znaków wielobajtowych UTF-8 mają najstarszy bit ustawiony, więc dopasowanie w takim napisie
 * jest dopasowaniem w bajtach. Większość bajtów pliku to linie bez żadnej igły i dla nich to
 * jedyny przebieg; osobne szukanie każdej igły w buforze kosztowało pięć razy więcej (pomiar
 * na pliku 66 MiB: 133 ms kontra 27 ms).
 */
export function mayCarryTask(line: Buffer): boolean {
  return mayCarryTaskText(line.toString('latin1'));
}

/** {@link mayCarryTask} na linii już przepisanej bajt w bajt na napis (`latin1`). */
function mayCarryTaskText(text: string): boolean {
  if (!ANY.test(text)) return false;
  // Coś jest: albo igła, która wystarcza sama, albo wywołanie narzędzia (wtedy liczy się nazwa).
  return NEEDLE.test(text) || TASK_TOOL.test(text);
}

/**
 * Igła listy artefaktów (`artifacts.ts`): prefiks adresu artefaktu. Stoi i w wyniku publikacji
 * (`url`), i w meldunku o usunięciu (zdarzenie `Watch on <adres> ended`), czyli w każdej linii, z której
 * lista może się zmienić. Czysty ASCII, więc szukanie w napisie `latin1` jest szukaniem w bajtach.
 */
const ARTIFACT_NEEDLE = CLI_SHAPES.artifactPublish.literals.urlPrefix;

/**
 * Czy linia pliku głównego MOŻE zmienić listę artefaktów sesji. Ten sam rodzaj prefiltra co
 * {@link mayCarryTask}: fałszywe „tak" (adres w wyniku `Bash`, w prompcie) kosztuje jedno parsowanie,
 * fałszywego „nie" być nie może, bo rozpoznanie wymaga adresu w formie z tym prefiksem.
 */
export function mayCarryArtifact(line: Buffer): boolean {
  return line.toString('latin1').includes(ARTIFACT_NEEDLE);
}

/** Tyle uchwytu pliku, ile przegląd używa: odczyt zakresu i zamknięcie. */
export interface ScannedFile {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface MainScanOptions {
  /** Ścieżka pliku głównego rozmowy. */
  readonly path: string;
  /**
   * Bajt, od którego follower przeczytał okno ogona. Przegląd bierze linie do pierwszego `\n`
   * o pozycji nie mniejszej niż ten bajt, włącznie, czyli dokładnie to, czego okno nie dało.
   */
  readonly windowStart: number;
  /** Pierwszy bajt ZA oknem: dalej przegląd nie czyta (reszta należy do odczytu przyrostowego). */
  readonly windowEnd: number;
  /**
   * Reduktor zadań w tle, który dostaje linie. Świeży: wołający bierze go do użytku dopiero po wyniku
   * `done`. Nieobecny = przegląd tylko dla listy artefaktów (po skróceniu pliku albo przeskoku).
   */
  readonly tracker?: BackgroundTasksTracker;
  /**
   * Drugie ujście: lista artefaktów sesji. Ta sama reguła co wyżej — świeża, do użytku po `done`.
   * Linia, która przechodzi prefiltr któregokolwiek ujścia, jest parsowana RAZ i idzie do obu.
   */
  readonly artifacts?: ArtifactsTracker;
  /** `true` = wynik nikomu już niepotrzebny (follower zamknięty, inna sesja silnika). */
  readonly stale?: () => boolean;
  /** Sufity; testy zmniejszają je do bajtów. */
  readonly chunkBytes?: number;
  readonly maxBytes?: number;
  readonly lineMaxBytes?: number;
  /** Otwarcie pliku do odczytu. Podmienialne, bo test musi umieć wejść w ŚRODEK przeglądu. */
  readonly open?: (path: string) => Promise<ScannedFile>;
}

/**
 * Wynik przeglądu:
 *
 * - `done`: reduktor dostał wszystko sprzed okna (`bytes` przeczytanych, `lines` linii, z tego
 *   `parsed` sparsowanych);
 * - `too-large`: przed oknem stoi więcej niż sufit, nic nie czytano;
 * - `stale`: wołający przestał czekać w trakcie;
 * - `failed`: odczyt się nie udał (plik zniknął, skrócił się, błąd dysku).
 *
 * Przy każdym wyniku poza `done` ujścia z opcji (reduktor, lista artefaktów) są NIEKOMPLETNE i nie
 * nadają się do użytku.
 */
export type MainScanResult =
  | { readonly outcome: 'done'; readonly bytes: number; readonly lines: number; readonly parsed: number }
  | { readonly outcome: 'too-large' }
  | { readonly outcome: 'stale' }
  | { readonly outcome: 'failed'; readonly reason: string };

/**
 * Podaje ujściom linie o zadaniach i artefaktach z części pliku PRZED oknem ogona, w kolejności pliku.
 * Okno zaczynające się od początku pliku (`windowStart` równe zero) nie zostawia nic do przeglądu.
 */
export async function scanMainFileBefore(opts: MainScanOptions): Promise<MainScanResult> {
  const { windowStart, windowEnd, tracker, artifacts } = opts;
  if (windowStart <= 0) return { outcome: 'done', bytes: 0, lines: 0, parsed: 0 };
  if (windowStart > (opts.maxBytes ?? MAIN_SCAN_MAX_BYTES)) return { outcome: 'too-large' };
  const chunkBytes = Math.max(1, opts.chunkBytes ?? MAIN_SCAN_CHUNK_BYTES);
  const lineMaxBytes = Math.max(1, opts.lineMaxBytes ?? MAIN_SCAN_LINE_MAX_BYTES);
  const stale = opts.stale ?? ((): boolean => false);

  let handle: ScannedFile;
  try {
    handle = await (opts.open ?? ((path) => open(path, 'r')))(opts.path);
  } catch (error) {
    return { outcome: 'failed', reason: describe(error) };
  }
  try {
    const carry = emptyCarry();
    const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(windowStart, windowEnd)));
    let lines = 0;
    let parsed = 0;
    const note = (line: Buffer): void => {
      lines += 1;
      const text = line.toString('latin1');
      // Do pierwszego wpisu z czasem reduktor dostaje KAŻDĄ linię: z niego bierze się `since`.
      const forTasks = tracker !== undefined && (tracker.firstEntryAt === '' || mayCarryTaskText(text));
      const forArtifacts = artifacts !== undefined && text.includes(ARTIFACT_NEEDLE);
      if (!forTasks && !forArtifacts) return;
      parsed += 1;
      // Oba ujścia dostają linię, którą przepuścił którykolwiek prefiltr: wzorcem jest „każda linia",
      // więc nadmiar niczego nie zmienia, a parsowanie jest jedno.
      const entry = parseJsonlEntry(line.toString('utf8'));
      tracker?.note(entry);
      artifacts?.note(entry);
    };

    // Część pierwsza: wszystko, co kończy się przed początkiem okna.
    let from = 0;
    while (from < windowStart) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, windowStart - from), from);
      if (stale()) return { outcome: 'stale' };
      if (bytesRead === 0) return { outcome: 'failed', reason: 'plik krótszy niż początek okna' };
      from += bytesRead;
      for (const line of takeLines(carry, buffer.subarray(0, bytesRead), lineMaxBytes)) note(line);
    }
    // Część druga: linia, w której środku zaczyna się okno. Okno ją wyrzuciło, więc należy do
    // przeglądu: czytamy do pierwszego `\n` włącznie i ani bajtu dalej.
    while (from < windowEnd) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, windowEnd - from), from);
      if (stale()) return { outcome: 'stale' };
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const end = chunk.indexOf(NEWLINE);
      from += end === -1 ? bytesRead : end + 1;
      for (const line of takeLines(carry, end === -1 ? chunk : chunk.subarray(0, end + 1), lineMaxBytes)) note(line);
      if (end !== -1) break;
    }
    return { outcome: 'done', bytes: from, lines, parsed };
  } catch (error) {
    return { outcome: 'failed', reason: describe(error) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Jedna linia o wyjątku do dziennika, bez stosu. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
