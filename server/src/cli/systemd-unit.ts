/**
 * Jednostka `systemd --user` serwera Raroga na Linuksie: nazwa i plik jednostki, escapowanie pól, render szablonu
 * `templates/rarog.service`, parser `ExecStart` NASZEGO pliku oraz odczyt stanu (`systemctl --user show`) i
 * właściwości menedżera użytkownika (`busctl --user`). Jedna definicja dla `rarog restart`, `rarog service`
 * i `rarog doctor`; `rarog setup` asks it where a unit lies (`locateUnit`) before it offers to write `herdr.service`.
 *
 * Escapowanie per rodzaj pola (pomiar na systemd 255):
 * - wszędzie `%` → `%%` (specyfikatory działają w `ExecStart=`, `WorkingDirectory=` i ścieżkach `StandardOutput=`);
 * - program (pierwszy element `ExecStart`) w cudzysłowie BEZ `$$`: systemd szuka programu przed podstawianiem
 *   zmiennych, więc `$$` w ścieżce programu to status 203;
 * - dalsze argumenty w cudzysłowie, `\` i `"` escapowane, `$` → `$$`;
 * - program i pola ścieżek odmawiają `\`, `"` i nowej linii (systemd ich tam nie odcytowuje), a nowa linia nie
 *   przechodzi nigdzie.
 *
 * Parser `ExecStart` rozumie dokładnie to, co pisze renderer (test w obie strony): `systemctl show -p ExecStart`
 * drukuje argv bez cytowania, więc granicy argumentu ze spacją stamtąd nie da się odtworzyć.
 *
 * Stan jednostki czytamy z WARTOŚCI, nie z kodu wyjścia: brak jednostki to kod 0 i `LoadState=not-found`, brak
 * magistrali użytkownika to kod 1 (trzeci stan „nie wiem”), a `masked` ma `FragmentPath` = nasz plik, więc
 * `LoadState` rozstrzyga pierwszy.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { INSTALL_ROOT } from '../install/mode.ts';
import { readRegularFileSync } from '../safe-read.ts';
import { Refusal } from './io.ts';
import type { CliIo } from './io.ts';

/** Jednostka usługi w menedżerze użytkownika. */
export const UNIT_NAME = 'rarog.service';
/** Szablon jednostki; wartości wstawia {@link renderServiceUnit} po escapowaniu per pole. */
export const UNIT_TEMPLATE = path.join(INSTALL_ROOT, 'server', 'src', 'cli', 'templates', UNIT_NAME);
/** Sufit czekania na `systemctl`/`busctl` (magistrala użytkownika odpowiada w milisekundach). */
const SYSTEMD_TIMEOUT_MS = 10_000;

/** Katalog jednostek użytkownika, w którym `rarog service install` zapisuje swoją. */
export function userUnitDir(home: string): string {
  return path.join(home, '.config', 'systemd', 'user');
}

/** Plik jednostki z `rarog service install`. */
export function unitFilePath(home: string): string {
  return path.join(userUnitDir(home), UNIT_NAME);
}

/** Te same ścieżki: dosłownie albo po rozwinięciu dowiązań (dom pod dowiązaniem). */
export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Escapowanie i render
// ---------------------------------------------------------------------------

/** Znaki, których program i pola ścieżek nie przenoszą (systemd ich tam nie odcytowuje). */
function rawIssue(value: string, field: string): string | null {
  if (value.includes('\n') || value.includes('\r')) return `${field}: newline in the value`;
  if (value.includes('"') || value.includes('\\')) return `${field}: character \`"\` or \`\\\` in the path`;
  return null;
}

/** Pole ścieżki (`WorkingDirectory=`, `StandardOutput=append:`): ścieżka bezwzględna, `%` → `%%`. */
export function escapeUnitPath(value: string, field: string): string {
  const issue = rawIssue(value, field);
  if (issue !== null) throw new Refusal(`${issue}; the systemd unit cannot carry it.`);
  if (!path.isAbsolute(value)) throw new Refusal(`${field}: "${value}" is not an absolute path.`);
  // systemd obcina białe znaki na końcu wartości: ścieżka nimi zakończona trafiłaby gdzie indziej.
  if (value !== value.trimEnd()) throw new Refusal(`${field}: trailing whitespace in the path.`);
  return value.replaceAll('%', '%%');
}

/** Program `ExecStart` (pierwszy element): ścieżka bezwzględna w cudzysłowie, `%` → `%%`, `$` bez zmian. */
export function escapeExecProgram(value: string): string {
  const issue = rawIssue(value, 'ExecStart program');
  if (issue !== null) throw new Refusal(`${issue}; the systemd unit cannot carry it.`);
  if (!path.isAbsolute(value)) throw new Refusal(`ExecStart program: "${value}" is not an absolute path.`);
  return `"${value.replaceAll('%', '%%')}"`;
}

/** Dalszy argument `ExecStart`: w cudzysłowie, `\` i `"` escapowane, `%` → `%%`, `$` → `$$`. */
export function escapeExecArgument(value: string): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Refusal('ExecStart argument: newline in the value; the systemd unit cannot carry it.');
  }
  if (value === '') throw new Refusal('ExecStart argument: empty string.');
  // Zamiana funkcją: w napisie zamiany `replaceAll` samo `$$` znaczy jeden `$`.
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')
    .replaceAll('$', () => '$$');
  return `"${escaped}"`;
}

/** Wartość `ExecStart=`: program i argumenty, każde pole według swojego rodzaju. */
export function renderExecStart(argv: readonly string[]): string {
  const [program, ...args] = argv;
  if (program === undefined) throw new Refusal('ExecStart: empty argument list.');
  return [escapeExecProgram(program), ...args.map(escapeExecArgument)].join(' ');
}

export interface ServiceUnitInput {
  /** `service.wrapper` + węzeł + `<repo>/bin/rarog.mjs serve`. */
  readonly execStart: readonly string[];
  readonly workingDirectory: string;
  /** `<dataDir>/server.log` na oba strumienie. */
  readonly log: string;
}

/** Szablon z repo przez `safe-read.ts`: plik zwykły, bez dowiązania, z sufitem. */
function readUnitTemplate(): string {
  const read = readRegularFileSync(UNIT_TEMPLATE, { maxBytes: 64 * 1024, followSymlink: false });
  if (read === null || read.truncated) {
    throw new Error(`${UNIT_TEMPLATE}: the template is not a regular file ≤ 64 KiB.`);
  }
  return read.bytes.toString('utf8');
}

/**
 * Jednostka z szablonu: katalog roboczy, `ExecStart` i log, każde pole escapowane według swojego rodzaju. Wartość,
 * której jednostka nie przeniesie, to {@link Refusal} z nazwą pola. Pola podstawia jeden przebieg po szablonie:
 * wartość z napisem `{{LOG}}` nie zostanie podstawiona drugi raz, a pole spoza listy to błąd.
 */
export function renderServiceUnit(input: ServiceUnitInput, template = readUnitTemplate()): string {
  const values: Readonly<Record<string, string>> = {
    WORKING_DIRECTORY: escapeUnitPath(input.workingDirectory, 'WorkingDirectory'),
    EXEC_START: renderExecStart(input.execStart),
    LOG: escapeUnitPath(input.log, 'server log'),
  };
  return template.replace(/\{\{([A-Z_]*)\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`${UNIT_TEMPLATE}: template field {{${name}}} is left unfilled.`);
    return value;
  });
}

// ---------------------------------------------------------------------------
// Parser ExecStart naszego pliku
// ---------------------------------------------------------------------------

/** Jedno słowo `ExecStart` w cudzysłowie od pozycji `start` (na `"`); `{ issue }` przy znaku spoza renderera. */
function parseWord(text: string, start: number, program: boolean): { value: string; end: number } | { issue: string } {
  let value = '';
  let i = start + 1;
  for (;;) {
    const ch = text[i];
    if (ch === undefined) return { issue: 'unclosed quote' };
    if (ch === '"') return { value, end: i + 1 };
    if (ch === '\\') {
      const next = text[i + 1];
      if (program || (next !== '\\' && next !== '"')) return { issue: `\\${next ?? ''} outside what the renderer writes` };
      value += next;
      i += 2;
    } else if (ch === '%') {
      if (text[i + 1] !== '%') return { issue: 'specifier % (the renderer writes only %%)' };
      value += '%';
      i += 2;
    } else if (ch === '$' && !program) {
      if (text[i + 1] !== '$') return { issue: 'variable $ in an argument (the renderer writes only $$)' };
      value += '$';
      i += 2;
    } else {
      value += ch;
      i += 1;
    }
  }
}

/**
 * argv z jedynej linii `ExecStart=` tekstu jednostki — odwrotność {@link renderExecStart}. Wszystko spoza
 * gramatyki renderera (słowo bez cudzysłowu, przedrostek `-`/`@`/`:`, inne escapowanie, specyfikator, druga linia
 * `ExecStart`) to `{ issue }`: jednostka nie pochodzi z `rarog service install` albo ktoś ją zmienił ręcznie.
 */
export function parseExecStart(unitText: string): { argv: string[] } | { issue: string } {
  const lines = unitText.split('\n').map((line) => line.replace(/\r$/, ''))
    .filter((line) => /^\s*ExecStart\s*=/.test(line));
  if (lines.length !== 1) return { issue: `${String(lines.length)} ExecStart= lines (expected one)` };
  const text = (lines[0] ?? '').replace(/^\s*ExecStart\s*=/, '');
  const argv: string[] = [];
  let i = 0;
  for (;;) {
    while (text[i] === ' ' || text[i] === '\t') i += 1;
    if (i >= text.length) break;
    if (text[i] !== '"') return { issue: `unquoted word at position ${String(i)}` };
    const word = parseWord(text, i, argv.length === 0);
    if ('issue' in word) return word;
    argv.push(word.value);
    i = word.end;
    if (i < text.length && text[i] !== ' ' && text[i] !== '\t') return { issue: 'character right after a quote' };
  }
  if (argv.length === 0) return { issue: 'empty ExecStart= line' };
  return { argv };
}

// ---------------------------------------------------------------------------
// Stan jednostki i menedżera użytkownika
// ---------------------------------------------------------------------------

/** Pierwsza linia stderr i kod (albo sygnał, błąd uruchomienia) — bez stdout, który może nieść środowisko. */
function failureOf(command: string, result: ReturnType<typeof spawnSync>): string {
  if (result.error !== undefined) return `${command}: ${result.error.message}`;
  const how = result.status === null ? `signal ${String(result.signal)}` : `code ${String(result.status)}`;
  const stderr = (String(result.stderr ?? '').trim().split('\n')[0] ?? '').trim();
  return `${command}: ${how}${stderr !== '' ? `, ${stderr}` : ''}`;
}

/** `Klucz=wartość` z wyjścia `systemctl show` (wartość może zawierać `=`). */
export function parseShow(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) values.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return values;
}

/** Właściwości `show`, z których {@link classifyUnit} rozstrzyga stan (każda musi być w wyjściu). */
export const UNIT_STATE_PROPS = ['LoadState', 'FragmentPath', 'DropInPaths', 'NeedDaemonReload'] as const;
/**
 * Środowisko ustawione w samej jednostce. Szablon nie ma żadnego z tych wpisów, więc niepusty = jednostka zmieniona
 * ręcznie (np. `Environment=` ze zmienną katalogu danych w głównym pliku, bez drop-inu, przeniósłby
 * serwer na inny katalog danych). Pusta tablica bywa pominięta w wyjściu, więc brak właściwości = pusta.
 */
export const UNIT_ENV_PROPS = ['Environment', 'EnvironmentFiles', 'PassEnvironment', 'UnsetEnvironment'] as const;

/**
 * `systemctl --user show <jednostka> -p …` (domyślnie `rarog.service`): wartości podanych właściwości albo
 * `{ failure }` („nie wiem”: brak magistrali, brak `systemctl`, kod różny od 0, brak którejś właściwości z `props`
 * w wyjściu; `optional` mogą nie przyjść).
 */
export function showUnit(io: CliIo, props: readonly string[], optional: readonly string[] = [], unit = UNIT_NAME):
  { readonly values: ReadonlyMap<string, string> } | { readonly failure: string } {
  const args = ['--user', 'show', unit, ...[...props, ...optional].flatMap((prop) => ['-p', prop])];
  const result = spawnSync('systemctl', args, { env: io.env, encoding: 'utf8', timeout: SYSTEMD_TIMEOUT_MS });
  if (result.error !== undefined || result.status !== 0) return { failure: failureOf('systemctl --user show', result) };
  const values = parseShow(result.stdout);
  const missing = props.filter((prop) => !values.has(prop));
  if (missing.length > 0) return { failure: `systemctl --user show: no ${missing.join(', ')} in the output` };
  return { values };
}

/** Napisy z `busctl --json=short` właściwości typu `as` (`{"type":"as","data":[…]}`); `null` = inny kształt. */
export function parseBusctlStrings(stdout: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { type, data } = parsed as Record<string, unknown>;
  if (type !== 'as' || !Array.isArray(data) || !data.every((item) => typeof item === 'string')) return null;
  return data as string[];
}

/**
 * Właściwość menedżera użytkownika (`Environment`, `UnitPath`) przez `busctl --user --json=short get-property`:
 * dokładne napisy, bez cytowania `$'…'` z `systemctl show-environment`. Porażka mówi kod i pierwszą linię
 * stderr; stdout (środowisko menedżera) nie trafia do komunikatu.
 */
export function managerStrings(io: CliIo, property: 'Environment' | 'UnitPath'):
  { readonly values: readonly string[] } | { readonly failure: string } {
  const args = ['--user', '--json=short', 'get-property', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
    'org.freedesktop.systemd1.Manager', property];
  const result = spawnSync('busctl', args, { env: io.env, encoding: 'utf8', timeout: SYSTEMD_TIMEOUT_MS });
  if (result.error !== undefined || result.status !== 0) return { failure: failureOf(`busctl … ${property}`, result) };
  const values = parseBusctlStrings(result.stdout);
  return values === null ? { failure: `busctl … ${property}: the output is not a list of strings (as)` } : { values };
}

/**
 * Where the user manager has the unit `name`: `present` with its file (`null` = the manager knows it without a unit
 * file), `absent` with the `UnitPath` read, or `unknown` with the reason.
 */
export type UnitLocation =
  | { readonly kind: 'present'; readonly file: string | null }
  | { readonly kind: 'absent'; readonly unitPath: readonly string[] }
  | { readonly kind: 'unknown'; readonly failure: string };

/**
 * Whether the user manager has the unit `name` anywhere, read without a write: known to the manager (`LoadState` other
 * than `not-found`, its file in `FragmentPath`), otherwise a file of that name in a directory of the manager's
 * `UnitPath`, first match wins as in systemd (a unit written after the last `daemon-reload`, which the manager does
 * not know yet). A missing entry or a parent that is not a directory counts as absent; any other error of `lstat`,
 * and `systemctl --user show` or `busctl` without an answer, is `unknown`.
 */
export function locateUnit(io: CliIo, name: string): UnitLocation {
  const shown = showUnit(io, ['LoadState'], ['FragmentPath'], name);
  if ('failure' in shown) return { kind: 'unknown', failure: shown.failure };
  if ((shown.values.get('LoadState') ?? '') !== 'not-found') {
    const fragment = shown.values.get('FragmentPath') ?? '';
    return { kind: 'present', file: fragment === '' ? null : fragment };
  }
  const unitPath = managerStrings(io, 'UnitPath');
  if ('failure' in unitPath) return { kind: 'unknown', failure: unitPath.failure };
  for (const dir of unitPath.values) {
    const file = path.join(dir, name);
    try {
      lstatSync(file);
      return { kind: 'present', file };
    } catch (failure) {
      const code = (failure as NodeJS.ErrnoException).code ?? 'error';
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return { kind: 'unknown', failure: `${file}: ${code}` };
    }
  }
  return { kind: 'absent', unitPath: unitPath.values };
}

/** Środowisko z listy `NAZWA=wartość` (podział po pierwszym `=`; wpis bez `=` pominięty, pierwsze wygrywa). */
export function environmentOf(list: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const entry of list) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const name = entry.slice(0, eq);
    if (!Object.hasOwn(env, name)) env[name] = entry.slice(eq + 1);
  }
  return env;
}

/** Środowisko menedżera użytkownika — to, które dostaje proces jednostki (bez dodatków systemd). */
export function managerEnvironment(io: CliIo): { readonly env: NodeJS.ProcessEnv } | { readonly failure: string } {
  const read = managerStrings(io, 'Environment');
  return 'failure' in read ? read : { env: environmentOf(read.values) };
}

/**
 * Linger użytkownika (`loginctl show-user <user> -p Linger --value`): `yes` = menedżer użytkownika, a z nim
 * usługa, żyje bez sesji logowania (także po reboocie). Wartość albo powód porażki.
 */
export function lingerState(io: CliIo, user: string): { readonly value: string } | { readonly failure: string } {
  const result = spawnSync('loginctl', ['show-user', user, '-p', 'Linger', '--value'], {
    env: io.env, encoding: 'utf8', timeout: SYSTEMD_TIMEOUT_MS,
  });
  if (result.error !== undefined || result.status !== 0) return { failure: failureOf('loginctl show-user', result) };
  return { value: result.stdout.trim() };
}

/** Komenda włączenia lingera do wklejenia (wymaga roota, więc rarog jej nie uruchamia). */
export function enableLingerCommand(user: string): string {
  return `sudo loginctl enable-linger ${user}`;
}

/** Rozstrzygnięty stan jednostki wobec naszego pliku. */
export type UnitStatus =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ours'; readonly values: ReadonlyMap<string, string> }
  | {
    readonly kind: 'masked' | 'bad-setting' | 'other' | 'foreign' | 'drop-in' | 'stale' | 'environment';
    readonly detail: string;
  };

/**
 * Stan z wartości `show` ({@link UNIT_STATE_PROPS} i {@link UNIT_ENV_PROPS}): `not-found` = brak; `loaded` z naszym
 * `FragmentPath`, bez drop-inów, bez `NeedDaemonReload=yes` i bez środowiska w jednostce = nasza. Każde odstępstwo
 * osobno nazwane: `masked`, `bad-setting`, inny `LoadState`, cudzy plik, drop-in (może wstrzyknąć np.
 * `Environment=` ze zmienną katalogu danych, a `rarog serve` by ją przepuścił), plik zmieniony bez
 * `daemon-reload` (systemd wystartowałby starą definicję, a węzeł sprawdzamy z pliku), środowisko
 * w samej jednostce (w `detail` tylko nazwy właściwości, bez wartości).
 */
export function classifyUnit(values: ReadonlyMap<string, string>, home: string): UnitStatus {
  const load = values.get('LoadState') ?? '';
  if (load === 'not-found') return { kind: 'absent' };
  if (load === 'masked' || load === 'bad-setting') return { kind: load, detail: `LoadState=${load}` };
  if (load !== 'loaded') return { kind: 'other', detail: `LoadState=${load === '' ? '(empty)' : load}` };
  const fragment = values.get('FragmentPath') ?? '';
  if (!samePath(fragment, unitFilePath(home))) {
    return { kind: 'foreign', detail: fragment === '' ? 'FragmentPath empty' : fragment };
  }
  const dropIns = (values.get('DropInPaths') ?? '').trim();
  if (dropIns !== '') return { kind: 'drop-in', detail: dropIns };
  if (values.get('NeedDaemonReload') === 'yes') return { kind: 'stale', detail: 'NeedDaemonReload=yes' };
  const environment = UNIT_ENV_PROPS.filter((prop) => (values.get(prop) ?? '').trim() !== '');
  if (environment.length > 0) return { kind: 'environment', detail: environment.join(', ') };
  return { kind: 'ours', values };
}
