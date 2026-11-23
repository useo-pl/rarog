/**
 * Pull requesty sesji — rozpoznanie w pliku rozmowy i lista. CZYSTE: bez I/O, zegara i logów.
 *
 * Sesja tworzy PR poleceniem `gh pr create` w narzędziu `Bash`: agent główny, subagent albo agent workflow,
 * każdy we własnym pliku rozmowy. Dysk czyta `pull-request-files.ts`; ten moduł dostaje sparsowane wpisy
 * JEDNEGO pliku w kolejności zapisu. Opis całości: `docs/pull-requests.md`.
 *
 * Rozpoznanie, każdy warunek z powodu (pomiar na magazynie CLI tego konta: 196 plików z napisem
 * `gh pr create`, 83 wyniki takiego wywołania; w każdym, w którym `gh` utworzył PR, adres stał w treści bloku
 * `tool_result` jako osobna linia):
 *
 * - **wywołanie** — blok `tool_use` narzędzia `Bash`, którego `input.command` WYKONUJE `gh pr create`:
 *   segment łańcucha (`&&`, `||`, `;`, `|`, `&`, nowa linia, nawias) zaczyna się od `gh pr create`, po
 *   przypisaniach zmiennych i `env`/`command`. Tekst w cudzysłowie, argument `echo`, treść heredoca
 *   i komentarz nie są poleceniem ({@link shellSegments});
 * - **wynik** — blok `tool_result` z `tool_use_id` wywołania z TEGO SAMEGO pliku i linia treści DOKŁADNIE
 *   `https://github.com/<owner>/<repo>/pull/<numer>`. Kod wyjścia całego `Bash` nie rozstrzyga
 *   (`gh pr create --fill && false` tworzy PR i kończy się błędem), więc `is_error` niczego nie odsiewa.
 *   Odpada linia po komunikacie `gh` „…already exists:” (PR istniał przed tym wywołaniem) i odnośnik
 *   `pull/new/<gałąź>` z `git push` (nie ma numeru). Treść bloku to wyjście i błędy razem, jak pisze je CLI:
 *   wynik z błędem jest napisem bez podziału na strumienie;
 * - **czas** — `timestamp` wpisu z wynikiem; wpis bez czasu nie daje PR-a.
 * - **background** — a recognized call whose result has no PR URL but a `backgroundTaskId` (`run_in_background`, or
 *   moved to the background after the CLI's timeout) waits for the CLI's end notification from the same file. The
 *   notification with the call's `tool_use_id` and task id asks the reader for its output file
 *   ({@link PullRequestOutput}); the file text goes through the same line rule ({@link pullRequestsFromOutput}) and
 *   the time is the notification's `timestamp`. This module never reads the file.
 *
 * Lista: adres → repo, numer, chwila utworzenia i tytuł z argumentu `--title`/`-t` (tylko dosłowny, bez
 * rozwinięć powłoki). Ten sam adres drugi raz nie dodaje wiersza: zostaje najwcześniejszy czas, tytuł
 * z pierwszego wywołania, które go podało. Najnowszy pierwszy, najwyżej {@link PULL_REQUESTS_MAX}.
 * Z polecenia wychodzi tylko tytuł; treść (`--body`), ścieżki i reszta argumentów nie wychodzą nigdy.
 */
import type { SessionPullRequest } from '@rarog/shared';
import { asRecord } from '../../drivers/tool-text.ts';
import { clipUnits, stripControlChars } from '../../text.ts';
import { parseJsonlEntry } from '../jsonl-pending.ts';
import { harnessNoticeText } from './artifacts.ts';
import { CLI_SHAPES } from './cli-shapes.ts';
import { isBackgroundTaskId } from './ids.ts';
import { isTaskNotification, parseTaskNotification } from './notification.ts';

const BASH = CLI_SHAPES.taskTools.literals.bash;
const TOOL_RESULT = CLI_SHAPES.toolResult.literals.field;
const BACKGROUND_TASK_ID = CLI_SHAPES.taskStart.literals.backgroundTaskId;

/** Ile PR-ów najwyżej stoi na liście; lista jedzie w każdej ramce snapshotu, jak artefakty. */
export const PULL_REQUESTS_MAX = 20;

/** Ile jednostek UTF-16 tytułu jedzie na telefon — tyle co tytuł artefaktu. */
export const PULL_REQUEST_TITLE_MAX = 120;

/**
 * Ile wywołań `gh pr create` bez wyniku pamięta jeden plik. Wynik stoi zwykle w następnym wpisie; sufit chroni
 * pamięć przed plikiem, w którym wyniki nie przychodzą (przerwane wywołania).
 */
export const PULL_REQUEST_CALLS_MAX = 64;

/**
 * Adres PR w gramatyce GitHuba: właściciel z liter, cyfr i łączników (do 39 znaków), nazwa repo z liter, cyfr,
 * kropki, podkreślenia i łącznika, numer dodatni bez zer wiodących (do 9 cyfr, bezpieczna liczba całkowita).
 * Jedna definicja: tę samą gramatykę czyta moduł stanu PR-ów (`pr-status/source.ts`, `parsePrUrl`).
 */
export const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9][0-9]{0,8})$/;

/**
 * Koniec linii, po której `gh pr create` podaje adres PR, który JUŻ istniał (wyjście z błędem, zmierzone
 * w dokumentacji `gh`: `a pull request for branch "x" into branch "main" already exists:`).
 */
const ALREADY_EXISTS = 'already exists:';

/**
 * Igły prefiltra: wywołanie niesie `create` (między `pr` i `create` parser dopuszcza dowolne białe znaki, w JSON
 * tabulator stoi jako `\t`), wynik `/pull/`. Bajty, bo porównujemy porcje pliku.
 * A result moved to the background carries `backgroundTaskId`, its end notification the harness origin value.
 */
const NEEDLES: readonly Buffer[] = [
  'create', '/pull/', BACKGROUND_TASK_ID, CLI_SHAPES.notificationOrigin.literals.kind,
].map((needle) => Buffer.from(needle, 'utf8'));

/**
 * Czy linia pliku MOŻE nieść wywołanie `gh pr create` albo wynik z adresem PR. Tani prefiltr przed
 * `JSON.parse`: fałszywe „tak” kosztuje jedno parsowanie. `/` w napisie JSON nie jest ucieczką, więc adres
 * stoi w linii dosłownie.
 */
export function mayCarryPullRequest(line: Buffer): boolean {
  return NEEDLES.some((needle) => line.includes(needle));
}

/** Adres PR rozłożony na części; `null` = linia nie jest DOKŁADNIE adresem PR. */
export function parsePullRequestUrl(text: string): Pick<SessionPullRequest, 'url' | 'repo' | 'number'> | null {
  const hit = PR_URL.exec(text);
  if (hit === null) return null;
  const owner = hit[1] ?? '';
  const repo = hit[2] ?? '';
  if (repo === '.' || repo === '..') return null;
  return { url: text, repo: `${owner}/${repo}`, number: Number(hit[3]) };
}

/** Słowo polecenia po zdjęciu cudzysłowów; `literal` = bez rozwinięć powłoki (`$`, odwrotny apostrof). */
export interface ShellWord {
  readonly text: string;
  readonly literal: boolean;
  /** The first character was quoted or escaped: `">x"` and `\>x` are arguments, not redirects. */
  readonly quotedStart?: true;
  /** The word runs a command substitution (`$(…)` or backticks), whose stderr reaches the result. */
  readonly runs?: true;
}

type Context = 'sq' | 'dq' | 'sub' | 'bt';

/**
 * Polecenie powłoki → segmenty łańcucha, każdy jako lista słów. Leksyka na tyle, na ile trzeba, żeby poznać
 * pierwsze słowa segmentu: cudzysłowy pojedyncze i podwójne, ucieczka `\`, podstawienie `$(…)` i odwrotne
 * apostrofy (z zagnieżdżeniem), heredoc (`<<EOF`, `<<'EOF'`, `<<-EOF`; treść do linii z ogranicznikiem jest
 * pomijana) i komentarz `#` na początku słowa. Separatory segmentów tylko na najwyższym poziomie: `;`, `&`, `|`,
 * nowa linia i nawias podpowłoki. Słowo z podstawieniem albo `$` poza apostrofami nie jest dosłowne.
 * Niedomknięty cudzysłów kończy polecenie tym, co zebrano.
 */
export function shellSegments(command: string): ShellWord[][] {
  const segments: ShellWord[][] = [];
  const stack: Context[] = [];
  /** Ograniczniki heredoców czekających na koniec bieżącej linii. */
  const heredocs: { delimiter: string; tabs: boolean }[] = [];
  let words: ShellWord[] = [];
  let text = '';
  let literal = true;
  let inWord = false;
  let quotedStart = false;
  let runs = false;

  const endWord = (): void => {
    if (inWord) {
      words.push({ text, literal, ...(quotedStart ? { quotedStart: true } : {}), ...(runs ? { runs: true } : {}) });
    }
    text = '';
    literal = true;
    inWord = false;
    quotedStart = false;
    runs = false;
  };
  const endSegment = (): void => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  const append = (chars: string): void => {
    text += chars;
    inWord = true;
  };
  /** Pomija treść czekających heredoców od pozycji `from` (początek linii); oddaje pozycję za nimi. */
  const skipHeredocs = (from: number): number => {
    let at = from;
    while (heredocs.length > 0) {
      const { delimiter, tabs } = heredocs.shift() ?? { delimiter: '', tabs: false };
      for (;;) {
        if (at >= command.length) return at;
        const end = command.indexOf('\n', at);
        const line = command.slice(at, end === -1 ? command.length : end);
        at = end === -1 ? command.length : end + 1;
        if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) break;
      }
    }
    return at;
  };
  /** Ogranicznik heredoca od pozycji za `<<`; oddaje pozycję za nim. */
  const readHeredoc = (from: number): number => {
    let at = from;
    const tabs = command[at] === '-';
    if (tabs) at += 1;
    while (command[at] === ' ' || command[at] === '\t') at += 1;
    let delimiter = '';
    while (at < command.length && !/[\s;&|<>()]/.test(command[at] ?? '')) {
      const ch = command[at] ?? '';
      if (ch === '\'' || ch === '"') {
        const close = command.indexOf(ch, at + 1);
        const end = close === -1 ? command.length : close;
        delimiter += command.slice(at + 1, end);
        at = end + 1;
      } else {
        if (ch !== '\\') delimiter += ch;
        at += 1;
      }
    }
    if (delimiter !== '') heredocs.push({ delimiter, tabs });
    return at;
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i] ?? '';
    const next = command[i + 1] ?? '';
    const top = stack.at(-1);
    if (top === 'sq') {
      if (ch === '\'') stack.pop();
      else append(ch);
      i += 1;
      continue;
    }
    if (top === 'dq') {
      if (ch === '"') {
        stack.pop();
      } else if (ch === '\\' && '$`"\\\n'.includes(next) && next !== '') {
        if (next !== '\n') append(next);
        i += 1;
      } else if (ch === '$' && next === '(') {
        stack.push('sub');
        literal = false;
        runs = true;
        append('$(');
        i += 1;
      } else if (ch === '`') {
        stack.push('bt');
        literal = false;
        runs = true;
        append(ch);
      } else {
        if (ch === '$') literal = false;
        append(ch);
      }
      i += 1;
      continue;
    }
    if (top === 'bt') {
      if (ch === '\\' && next !== '') {
        append(ch + next);
        i += 2;
        continue;
      }
      if (ch === '`') stack.pop();
      append(ch);
      i += 1;
      continue;
    }
    if (top === 'sub') {
      // Wnętrze podstawienia: słowa nie są potrzebne, tylko jego granice.
      if (ch === '\\' && next !== '') {
        append(ch + next);
        i += 2;
        continue;
      }
      if (ch === ')') stack.pop();
      else if (ch === '(') stack.push('sub');
      else if (ch === '\'') stack.push('sq');
      else if (ch === '"') stack.push('dq');
      else if (ch === '`') stack.push('bt');
      else if (ch === '<' && next === '<' && command[i + 2] !== '<') {
        append('<<');
        i = readHeredoc(i + 2);
        continue;
      } else if (ch === '\n' && heredocs.length > 0) {
        append(ch);
        i = skipHeredocs(i + 1);
        continue;
      }
      append(ch);
      i += 1;
      continue;
    }
    // Najwyższy poziom.
    if (ch === '\\') {
      if (next === '\n') i += 2;
      else {
        if (next !== '') {
          if (!inWord) quotedStart = true;
          append(next);
        }
        i += 2;
      }
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endSegment();
      i = skipHeredocs(i + 1);
      continue;
    }
    // `&` w przekierowaniu (`2>&1`, `>&2`, `&>plik`) należy do słowa, nie rozdziela segmentów.
    if (ch === '&' && (command[i - 1] === '>' || command[i - 1] === '<' || next === '>')) {
      append(ch);
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '(' || ch === ')') {
      endSegment();
      i += 1;
      continue;
    }
    if (ch === '#' && !inWord) {
      const end = command.indexOf('\n', i);
      i = end === -1 ? command.length : end;
      continue;
    }
    if (ch === '<' && next === '<' && command[i + 2] !== '<') {
      endWord();
      i = readHeredoc(i + 2);
      continue;
    }
    if (ch === '\'' || ch === '"') {
      stack.push(ch === '\'' ? 'sq' : 'dq');
      if (!inWord) quotedStart = true;
      inWord = true;
    } else if (ch === '$' && next === '(') {
      stack.push('sub');
      literal = false;
      runs = true;
      append('$(');
      i += 1;
    } else if (ch === '`') {
      stack.push('bt');
      literal = false;
      runs = true;
      append(ch);
    } else {
      if (ch === '$') literal = false;
      append(ch);
    }
    i += 1;
  }
  endSegment();
  return segments;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Słowa, po których polecenie dalej stoi w tym samym segmencie. */
const PREFIX_COMMANDS: readonly string[] = ['env', 'command'];

/** Tytuł z argumentów `gh pr create`; `undefined` = brak albo nie dosłowny. */
function titleOf(args: readonly ShellWord[]): string | undefined {
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at];
    if (word === undefined) break;
    let value: ShellWord | undefined;
    if (word.text === '--title' || word.text === '-t') value = args[at + 1];
    else if (word.text.startsWith('--title=')) value = { text: word.text.slice('--title='.length), literal: word.literal };
    if (value === undefined) continue;
    if (!value.literal) return undefined;
    const title = clipUnits(stripControlChars(value.text).trim(), PULL_REQUEST_TITLE_MAX);
    return title === '' ? undefined : title;
  }
  return undefined;
}

/**
 * Programy, które obok `gh pr create` w tym samym poleceniu nie wypiszą adresu PR linią samą w sobie: przejście do
 * katalogu, git (komunikat `remote:` o PR stoi z przedrostkiem), ustawienia powłoki i filtry wyjścia `create`
 * w potoku. Każdy inny program (także `gh pr view`, `cat` bez przekierowania do pliku, testy) czyni wynik
 * niejednoznacznym, poza wyjątkami niżej: adres mógł przyjść od niego, a nie od `create`. Lista słów, nie
 * wywołań: jednym napisem, bo strażnik (`pliki-zwykle-guard.test.ts`) dopuszcza literał nazwy gita tylko
 * na linii spawnu runnera.
 */
const QUIET_PROGRAMS: readonly string[] = 'cd pushd popd git export unset set true false sleep test [ tail head tee grep wc'
  .split(' ');
/** `echo` i `printf` są ciche, gdy wszystkie słowa są dosłowne i żadne nie niesie adresu PR. */
const PRINT_PROGRAMS: readonly string[] = ['echo', 'printf'];
const PR_URL_ANYWHERE = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/[1-9]/;
/**
 * Programs that are quiet when their stdout goes to a file: an agent writes the PR body this way in the same call
 * (`cat > body.txt <<'EOF'`), measured as the most common reason a created PR went unrecognized. Their stderr
 * carries only error messages, never a bare PR URL line.
 */
const TO_FILE_PROGRAMS: readonly string[] = ['cat', 'echo', 'printf'];
/** File tools that print nothing to stdout unless asked to be verbose. */
const FILE_PROGRAMS: readonly string[] = 'rm mkdir cp mv ln touch chmod mktemp'.split(' ');
const VERBOSE_FLAG = /^(-[A-Za-z]*v[A-Za-z]*|--verbose)$/;
/** The Markdown line-length check (`awk 'length > 120 {print NR": "length}' body.txt`): lines start with a number. */
const AWK_LINE_LENGTH = /^length(\(\))?\s*>\s*[0-9]+\s*\{\s*print\s+F?NR\s*": "\s*length(\(\))?\s*\}$/;
/** A redirect of stdout (`>`, `>>`, `1>`, `&>`), with its target in the same word or in the next one. */
const STDOUT_REDIRECT = /^(?:1|&)?>>?(.*)$/;

/**
 * Whether the segment's stdout ends in a regular file: the last stdout redirect points to a path that is not
 * a descriptor (`>&2`) and not a device other than `/dev/null` (`/dev/stdout` lands in the result).
 */
function stdoutToFile(words: readonly ShellWord[]): boolean {
  let target: string | null = null;
  for (let at = 1; at < words.length; at += 1) {
    if (words[at]?.quotedStart === true) continue;
    const hit = STDOUT_REDIRECT.exec(words[at]?.text ?? '');
    if (hit === null) continue;
    const inline = hit[1] ?? '';
    target = inline === '' ? (words[at + 1]?.text ?? '') : inline;
    if (inline === '') at += 1;
  }
  if (target === null || target === '' || target.startsWith('&')) return false;
  return !target.startsWith('/dev/') || target === '/dev/null';
}

/** Whether a file tool, `sed -i` or the `awk` line-length check stays silent on stdout. */
function isSilentTool(program: string, args: readonly ShellWord[]): boolean {
  if (FILE_PROGRAMS.includes(program)) return !args.some((word) => VERBOSE_FLAG.test(word.text));
  if (program === 'sed') {
    const inPlace = args.some((word) => /^(-[A-Za-z]*i|--in-place)/.test(word.text));
    return inPlace && !args.some((word) => word.text.includes('/dev/'));
  }
  if (program === 'awk') {
    const [script, ...files] = args;
    // An operand `ORS=…` is a variable assignment, not a file, and changes what awk prints.
    return script !== undefined && script.literal && AWK_LINE_LENGTH.test(script.text.trim())
      && !files.some((word) => word.text.startsWith('-') || ASSIGNMENT.test(word.text));
  }
  return false;
}

/** `timeout` from GNU coreutils (`gtimeout` from Homebrew): runs the program that follows its options and duration. */
const TIMEOUT_PROGRAMS: readonly string[] = ['timeout', 'gtimeout'];
const TIMEOUT_FLAGS: readonly string[] = ['--preserve-status', '--foreground', '-v', '--verbose'];
/** Options of `timeout` whose value is the next word. */
const TIMEOUT_VALUE_OPTIONS: readonly string[] = ['-s', '--signal', '-k', '--kill-after'];
/** Options of `timeout` with the value in the same word. */
const TIMEOUT_JOINED_OPTION = /^(?:-[sk].|--signal=.|--kill-after=.)/;
const TIMEOUT_DURATION = /^[0-9]+(?:\.[0-9]+)?[smhd]?$/;

/**
 * Index of the program after `timeout` at `at`: options, then the duration. `null` = another shape, so `timeout`
 * stays the program (neither `create` nor quiet).
 */
function afterTimeout(segment: readonly ShellWord[], at: number): number | null {
  let next = at + 1;
  for (;;) {
    const word = segment[next];
    if (word === undefined || !word.literal) return null;
    if (word.text === '--') {
      next += 1;
      break;
    }
    if (TIMEOUT_FLAGS.includes(word.text) || TIMEOUT_JOINED_OPTION.test(word.text)) next += 1;
    else if (TIMEOUT_VALUE_OPTIONS.includes(word.text)) {
      if (segment[next + 1]?.literal !== true) return null;
      next += 2;
    } else break;
  }
  return TIMEOUT_DURATION.test(segment[next]?.text ?? '') ? next + 1 : null;
}

/** Słowa segmentu od programu (po przypisaniach `X=1`, `env`/`command` i `timeout` z czasem). */
function commandWords(segment: readonly ShellWord[]): readonly ShellWord[] {
  let at = 0;
  for (;;) {
    const word = segment[at];
    if (word === undefined) break;
    if (ASSIGNMENT.test(word.text) || (word.literal && PREFIX_COMMANDS.includes(word.text))) at += 1;
    else if (word.literal && TIMEOUT_PROGRAMS.includes(word.text)) {
      const program = afterTimeout(segment, at);
      if (program === null) break;
      at = program;
    } else break;
  }
  return segment.slice(at);
}

/** Czy segment to `gh pr create` (program `gh` albo ścieżka do niego, słowa dosłowne). */
function isCreate(words: readonly ShellWord[]): boolean {
  const [program, group, action] = words;
  if (program === undefined || group === undefined || action === undefined) return false;
  if (!program.literal || !group.literal || !action.literal) return false;
  return (program.text === 'gh' || program.text.endsWith('/gh')) && group.text === 'pr' && action.text === 'create';
}

/** Czy segment obok `create` na pewno nie dostarczy adresu PR do wyniku (segment bez słów też). */
function isQuiet(words: readonly ShellWord[]): boolean {
  const [program] = words;
  if (program === undefined) return true;
  if (!program.literal) return false;
  if (QUIET_PROGRAMS.includes(program.text)) return true;
  if (words.some((word) => PR_URL_ANYWHERE.test(word.text))) return false;
  // A command substitution prints to stderr whatever the redirects of the program say.
  if (words.some((word) => word.runs === true)) return false;
  if (TO_FILE_PROGRAMS.includes(program.text) && stdoutToFile(words)) return true;
  if (isSilentTool(program.text, words.slice(1))) return true;
  if (!PRINT_PROGRAMS.includes(program.text)) return false;
  return words.every((word) => word.literal);
}

/**
 * Czy polecenie `Bash` wykonuje `gh pr create`; `null` = nie albo wynik niejednoznaczny. Adres PR w wyniku należy
 * do `create` tylko wtedy, gdy pozostałe segmenty polecenia są ciche ({@link isQuiet}): `gh pr view … || gh pr
 * create` albo `printf` z adresem dałyby adres PR, którego to polecenie nie utworzyło. Wynik niesie tytuł
 * z `--title`/`-t`, gdy polecenie podało go dosłownie (bez rozwinięć powłoki) i niepusty.
 * Several `gh pr create` segments in one call all count, but then no title: the result does not say which URL
 * belongs to which create (the first one may have failed).
 */
export function pullRequestCommand(command: string): { title?: string } | null {
  const creates: (readonly ShellWord[])[] = [];
  for (const segment of shellSegments(command)) {
    const words = commandWords(segment);
    if (isCreate(words)) {
      creates.push(words);
      continue;
    }
    if (!isQuiet(words)) return null;
  }
  const [create] = creates;
  if (create === undefined) return null;
  if (creates.length > 1) return {};
  const title = titleOf(create.slice(3));
  return title === undefined ? {} : { title };
}

/** Memory of one file between entries. */
export interface PullRequestCalls {
  /** Wywołania `gh pr create` czekające na wynik: `tool_use_id` → tytuł. */
  readonly pending: Map<string, { readonly title?: string }>;
  /** Recognized calls running in the background, waiting for the end notification: `tool_use_id` → task id, title. */
  readonly background: Map<string, { readonly taskId: string; readonly title?: string }>;
}

export function createPullRequestCalls(): PullRequestCalls {
  return { pending: new Map(), background: new Map() };
}

/**
 * A request to read the output file of a recognized call that ran in the background. `path` comes from the
 * notification as is: the reader checks its shape before any read.
 */
export interface PullRequestOutput {
  readonly path: string;
  readonly taskId: string;
  /** The notification's `timestamp`: the PR exists by then. */
  readonly createdAt: string;
  readonly title?: string;
}

/** What one entry gives: PRs found now and output files to read. */
export interface PullRequestFindings {
  readonly pullRequests: SessionPullRequest[];
  readonly outputs: PullRequestOutput[];
}

/** Adds to a map with a ceiling: `Map` keeps insertion order, so the first key is the oldest call. */
function remember<T>(map: Map<string, T>, id: string, value: T): void {
  map.set(id, value);
  if (map.size > PULL_REQUEST_CALLS_MAX) {
    const [oldest] = map.keys();
    if (oldest !== undefined) map.delete(oldest);
  }
}

/** Bloki treści wpisu; nie-tablica = brak bloków (ta sama reguła co w `artifacts.ts`). */
function blocksOf(entry: Record<string, unknown>): Record<string, unknown>[] {
  const content = asRecord(entry['message'])?.['content'];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): Record<string, unknown>[] => {
    const block = asRecord(item);
    return block === null || Array.isArray(item) ? [] : [block];
  });
}

/** Treść bloku `tool_result`: napis albo tablica bloków tekstu (sklejone nową linią). */
function resultText(block: Record<string, unknown>): string {
  const content = block['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((item): string[] => {
    const part = asRecord(item);
    return part?.['type'] === 'text' && typeof part['text'] === 'string' ? [part['text']] : [];
  }).join('\n');
}

/** Adresy PR z treści wyniku: linie dokładnie adresem, bez tych po „already exists:”. */
function urlsOf(text: string): Pick<SessionPullRequest, 'url' | 'repo' | 'number'>[] {
  const found: Pick<SessionPullRequest, 'url' | 'repo' | 'number'>[] = [];
  let previous = '';
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const pr = parsePullRequestUrl(line);
    if (pr !== null && !previous.trimEnd().endsWith(ALREADY_EXISTS)) found.push(pr);
    if (line.trim() !== '') previous = line;
  }
  return found;
}

/** Task id of a result that went to the background (`toolUseResult.backgroundTaskId`); `null` = none or bad shape. */
function backgroundTaskIdOf(entry: Record<string, unknown>): string | null {
  const result = asRecord(entry[TOOL_RESULT]);
  const taskId = result?.[BACKGROUND_TASK_ID];
  return typeof taskId === 'string' && isBackgroundTaskId(taskId) ? taskId : null;
}

/** A valid entry time, or `null`. */
function timeOf(entry: Record<string, unknown>): string | null {
  const at = entry['timestamp'];
  return typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : null;
}

/**
 * The end notification of a call waiting in the background → a read request. Only a harness notification
 * (`origin`), with a status (an event without one is not the end), the `tool_use_id` of a waiting call and its
 * task id. The waiting call leaves the memory, so a second copy of the notification asks nothing.
 */
function outputOf(entry: Record<string, unknown>, calls: PullRequestCalls): PullRequestOutput | null {
  const text = harnessNoticeText(entry);
  if (!isTaskNotification(text)) return null;
  const notification = parseTaskNotification(text);
  if (notification.status === '') return null;
  const waiting = calls.background.get(notification.toolUseId);
  if (waiting === undefined || waiting.taskId !== notification.id) return null;
  calls.background.delete(notification.toolUseId);
  const createdAt = timeOf(entry);
  if (createdAt === null) return null;
  const output = { path: notification.outputFile, taskId: waiting.taskId, createdAt };
  return waiting.title === undefined ? output : { ...output, title: waiting.title };
}

/**
 * Jeden SPARSOWANY wpis pliku (wynik `parseJsonlEntry`) → PR-y, które z niego wyszły. Wywołanie
 * `gh pr create` trafia do `calls`; wynik zdejmuje swoje wywołanie z `calls`, także wtedy, gdy adresu nie ma.
 * A result without a URL that went to the background moves the call to the background memory; its end
 * notification gives a read request in `outputs`.
 */
export function pullRequestsOf(value: unknown, calls: PullRequestCalls): PullRequestFindings {
  const entry = asRecord(value);
  if (entry === null || Array.isArray(value)) return { pullRequests: [], outputs: [] };
  const found: SessionPullRequest[] = [];
  const output = outputOf(entry, calls);
  for (const block of blocksOf(entry)) {
    if (block['type'] === 'tool_use') {
      const input = asRecord(block['input']);
      const command = input?.['command'];
      const id = block['id'];
      if (block['name'] !== BASH || typeof command !== 'string' || typeof id !== 'string') continue;
      const recognized = pullRequestCommand(command);
      if (recognized !== null) remember(calls.pending, id, recognized);
      continue;
    }
    if (block['type'] !== 'tool_result') continue;
    const id = block['tool_use_id'];
    if (typeof id !== 'string') continue;
    const known = calls.pending.get(id);
    if (known === undefined) continue;
    calls.pending.delete(id);
    const urls = urlsOf(resultText(block));
    const taskId = urls.length === 0 ? backgroundTaskIdOf(entry) : null;
    if (taskId !== null) {
      remember(calls.background, id, known.title === undefined ? { taskId } : { taskId, title: known.title });
      continue;
    }
    const createdAt = timeOf(entry);
    if (createdAt === null) continue;
    for (const pr of urls) {
      found.push(known.title === undefined ? { ...pr, createdAt } : { ...pr, createdAt, title: known.title });
    }
  }
  return { pullRequests: found, outputs: output === null ? [] : [output] };
}

/** Text of a background call's output file → its PRs, by the same line rule as a `tool_result`. */
export function pullRequestsFromOutput(text: string, output: PullRequestOutput): SessionPullRequest[] {
  const { createdAt, title } = output;
  return urlsOf(text).map((pr) => (title === undefined ? { ...pr, createdAt } : { ...pr, createdAt, title }));
}

export interface PullRequestList {
  /** Dokłada PR; oddaje `true`, gdy lista się zmieniła. */
  add(pr: SessionPullRequest): boolean;
  /**
   * Lista: najnowszy pierwszy, najwyżej {@link PULL_REQUESTS_MAX}. Za każdym odczytem NOWA tablica z NOWYMI
   * obiektami: lista jedzie dalej przez referencję.
   */
  readonly pullRequests: SessionPullRequest[];
}

/** Kolejność: czas utworzenia malejąco, przy remisie numer malejąco (stała kolejność). */
function newestFirst(a: SessionPullRequest, b: SessionPullRequest): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.number - a.number || (a.url < b.url ? -1 : 1);
}

/**
 * Lista PR-ów sesji ze wszystkich jej plików. Ten sam adres raz: najwcześniejszy czas (PR powstał przy
 * pierwszym wyniku), tytuł z pierwszego, który go niesie. Mapa ma ten sam sufit co lista: po przekroczeniu
 * wypada najstarszy PR (i tak stoi poza listą).
 */
export function createPullRequestList(): PullRequestList {
  const known = new Map<string, SessionPullRequest>();
  return {
    add(pr: SessionPullRequest): boolean {
      const current = known.get(pr.url);
      if (current === undefined) {
        known.set(pr.url, { ...pr });
        if (known.size > PULL_REQUESTS_MAX) {
          const [oldest] = [...known.values()].sort((a, b) => newestFirst(b, a));
          if (oldest !== undefined) known.delete(oldest.url);
        }
        return known.has(pr.url);
      }
      const earlier = Date.parse(pr.createdAt) < Date.parse(current.createdAt);
      const title = current.title ?? pr.title;
      const createdAt = earlier ? pr.createdAt : current.createdAt;
      if (createdAt === current.createdAt && title === current.title) return false;
      known.set(pr.url, title === undefined ? { ...current, createdAt } : { ...current, createdAt, title });
      return true;
    },
    get pullRequests(): SessionPullRequest[] {
      return [...known.values()].sort(newestFirst).slice(0, PULL_REQUESTS_MAX).map((pr) => ({ ...pr }));
    },
  };
}

/** Podpis listy — po nim driver poznaje ZMIANĘ. Pusta lista ma podpis `[]`. */
export function pullRequestsSignature(list: readonly SessionPullRequest[]): string {
  return JSON.stringify(list.map((pr) => [pr.url, pr.createdAt, pr.title ?? null]));
}

/**
 * Lista PR-ów z linii JEDNEGO pliku (kolejność zapisu) — ta sama maszyna co w czytniku, dla testów. Output files
 * of background calls are not read here.
 */
export function sessionPullRequests(lines: readonly string[]): SessionPullRequest[] {
  const calls = createPullRequestCalls();
  const list = createPullRequestList();
  for (const line of lines) for (const pr of pullRequestsOf(parseJsonlEntry(line), calls).pullRequests) list.add(pr);
  return list.pullRequests;
}
