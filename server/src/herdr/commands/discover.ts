/**
 * Skille i komendy z DYSKU, które Rarog przepuszcza z telefonu — wąski, jawnie opisany podzbiór
 * tego, co ładuje Claude Code. Reszta źródeł CLI (skille z claude.ai, zagnieżdżone `.claude/`,
 * podkatalogi `commands/`, `--add-dir`, pluginy z własnymi ścieżkami w manifeście, prompty MCP) zostaje
 * poza katalogiem: komenda stamtąd dostaje jawną odmowę, a nie zgadnięte przepuszczenie. Opis podzbioru:
 * `docs/slash-commands.md`, „Session catalog and discovery”; ścieżki i klucze: `DISK_LAYOUT` w `registry.ts`.
 *
 * Źródła i reguły nazw (dokumentacja CLI, „How a skill gets its command name”):
 *
 * - skille użytkownika `~/.claude/skills/<katalog>/SKILL.md`: komenda = nazwa katalogu; `name`
 *   z frontmattera to DRUGA nazwa tylko wtedy, gdy nie koliduje z niczym, co znamy (CLI daje ją, „unless
 *   another command already uses that name”, a przy kolizji wykonałby tamtą komendę);
 * - komendy użytkownika `~/.claude/commands/<plik>.md` (pierwszy poziom): komenda = nazwa pliku,
 *   `name` z frontmattera NIE zmienia komendy;
 * - projekt: te same dwa katalogi pod `<dir>/.claude/` dla `cwd` i rodziców do pierwszego `.git`
 *   włącznie, nie wyżej niż korzeń z `RAROG_HERDR_ROOTS`;
 * - pluginy z `installed_plugins.json`: `scope: user` i `scope: project` z `projectPath` równym
 *   korzeniowi repo `cwd`, włączone wg `enabledPlugins` (`settings.local.json` > `settings.json`
 *   projektu > `~/.claude/settings.json`; brak wpisu → `defaultEnabled` manifestu, domyślnie `true`),
 *   wyłącznie z domyślnych katalogów `skills/<katalog>/SKILL.md` i `commands/<plik>.md`; komenda
 *   `/<plugin>:<name|katalog>` albo `/<plugin>:<plik>`.
 *
 * Filtry: `user-invocable: false` i `skillOverrides[nazwa] === "off"` (tego drugiego pluginy nie mają)
 * chowają skill; nazwa spoza kształtu nazw Raroga (`isCommandName`) i nazwa komendy wbudowanej też (przy tej drugiej
 * docs `skills.md`, „Resolve skills that share a name”, mówią, że w lokalnej sesji terminala wykona się skill, a nie
 * komenda wbudowana; Rarog chowa skill, a wbudowaną zostawia w katalogu). Ukryte nazwy wracają w `hidden` — reguła
 * „ścieżka będąca prefiksem komendy” i podpowiedź odmowy potrzebują ich, choć Rarog ich nie przepuszcza.
 *
 * Moduł tylko CZYTA i niczego nie loguje sam: notatki (`notes`) wypisuje fabryka katalogu raz na proces.
 * Z plików ustawień bierze dwa klucze, z frontmattera cztery pola (`name`, `user-invocable` do nazw
 * i filtrów, `description`, `argument-hint` do listy apki — nazw nie zmieniają); treści skilla nie czyta
 * dalej niż nagłówek.
 * Odczyt jest synchroniczny, bo woła go bramka wysyłki (`assertSendable` w managerze), a koszt to kilkaset
 * `stat` na pełny skan (`catalog.ts` ogranicza go do jednego na minutę).
 */
import { dirname, join, resolve, sep } from 'node:path';
import { COMMAND_TEXT_MAX } from '@rarog/shared';
import { DIRECT_DISK } from '../../folder-gate/disk.ts';
import type { DiskStats } from '../../folder-gate/types.ts';
import { DISK_LAYOUT } from './registry.ts';
import { isCommandSegment } from './shape.ts';

/** Ile bajtów pliku skilla albo komendy czytamy: frontmatter stoi na początku, treść nie jest potrzebna. */
const HEAD_BYTES = 64 * 1024;
/** Sufit pliku JSON (ustawienia, `installed_plugins.json`, manifest pluginu). Większy = nieczytelny. */
const JSON_MAX_BYTES = 1024 * 1024;
/** Fraza notatki skanu (linia logu katalogu komend) o pliku, którego skan nie czyta. */
export const COMMAND_CATALOG_SKIP_FILE_LOG = 'command catalog: not reading file';

export type DiscoverOrigin =
  | 'user-skill' | 'user-command' | 'project-skill' | 'project-command' | 'plugin-skill' | 'plugin-command';

/** Dlaczego nazwa znana CLI nie przechodzi przez Raroga. */
export type HiddenReason = 'user-invocable' | 'skill-overrides' | 'reserved-name';

/** Opis i podpowiedź argumentu z frontmattera (`description`, `argument-hint`) — do listy apki. */
export interface CommandText {
  readonly description?: string;
  readonly argumentHint?: string;
}

export interface DiscoveredCommand extends CommandText {
  /** Nazwa bez ukośnika, tak jak ją wpisuje człowiek (`handoff`, `pr-review-toolkit:review-pr`). */
  readonly name: string;
  readonly source: 'skill' | 'plugin';
  readonly origin: DiscoverOrigin;
}

export interface HiddenCommand {
  readonly name: string;
  readonly origin: DiscoverOrigin;
  readonly reason: HiddenReason;
}

export type SkippedPluginReason =
  | 'scope' | 'project-path' | 'disabled' | 'manifest-paths' | 'install-path' | 'name';

export interface SkippedPlugin {
  /** Klucz z `installed_plugins.json` (`<plugin>@<marketplace>`). */
  readonly plugin: string;
  readonly reason: SkippedPluginReason;
}

export interface DiscoverResult {
  readonly commands: readonly DiscoveredCommand[];
  readonly hidden: readonly HiddenCommand[];
  /** Nazwy skilli z claude.ai ze wszystkich katalogów `synced/*` — tylko do podpowiedzi i reguły prefiksu. */
  readonly synced: readonly string[];
  readonly skippedPlugins: readonly SkippedPlugin[];
  /** Linie logu (bez treści plików); fabryka katalogu wypisuje każdą raz na proces. */
  readonly notes: readonly string[];
  /**
   * Ścieżka → stempel (`mtime`, rozmiar, inode albo `missing`) KAŻDEGO czytanego pliku i katalogu oraz
   * każdej sprawdzanej ścieżki, której nie było. Zmiana któregokolwiek = nowa migawka (`catalog.ts`).
   * Stempel stoi z chwili PRZED odczytem, więc zmiana w trakcie skanu też da różnicę przy sprawdzeniu.
   */
  readonly stamps: ReadonlyMap<string, string>;
}

export interface DiscoverOptions {
  /** Katalog domowy (`~`); `~/.claude` liczy się od niego. */
  readonly home: string;
  /** Katalog panelu (herdr `cwd`). */
  readonly cwd: string;
  /** `RAROG_HERDR_ROOTS`: wyżej niż korzeń zawierający `cwd` szukanie rodziców nie wychodzi. */
  readonly roots: readonly string[];
  /**
   * Nazwy i aliasy komend i skilli WBUDOWANYCH, małymi literami. Skill z dysku o takiej nazwie jest ukryty
   * (ostrożność Raroga). Docs `skills.md`, „Resolve skills that share a name”: skill z dysku zastępuje komendę
   * wbudowaną w lokalnej sesji terminala i skill dołączony do CLI, ale żadnej z nich aliasów.
   */
  readonly reserved: ReadonlySet<string>;
}

/** Stempel ścieżki: `mtime/rozmiar/inode` albo `missing`. Wspólny dla skanu i sprawdzenia sygnatury. */
export function stampOf(path: string): string {
  try {
    const info = statOrMissing(path);
    if (info === undefined) return 'missing';
    // Nanoseconds: the port's stats are bigint, whose `mtimeMs` drops the fraction of a millisecond.
    return `${String(info.mtimeNs)}/${String(info.size)}/${String(info.ino)}`;
  } catch {
    return 'unreadable';
  }
}

/** `stat` through the port; `undefined` where `statSync` with `throwIfNoEntry: false` gives it (ENOENT, ENOTDIR). */
function statOrMissing(path: string): DiskStats | undefined {
  try {
    return DIRECT_DISK.sync('stat', { path });
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw err;
  }
}

interface SkillCandidate {
  readonly primary: string;
  readonly secondary: string | null;
  readonly origin: DiscoverOrigin;
  readonly hidden: HiddenReason | null;
  /** Ten sam opis pod obiema nazwami skilla. */
  readonly text: CommandText;
}

interface Settings {
  readonly enabledPlugins: ReadonlyMap<string, unknown>;
  readonly skillOverrides: ReadonlyMap<string, unknown>;
}

/** Stan jednego skanu: stemple, notatki i zebrani kandydaci. */
class Scan {
  readonly stamps = new Map<string, string>();
  readonly notes: string[] = [];
  readonly skills: SkillCandidate[] = [];
  readonly plugins: DiscoveredCommand[] = [];
  readonly pluginHidden: HiddenCommand[] = [];
  readonly skipped: SkippedPlugin[] = [];
  readonly synced = new Set<string>();

  stamp(path: string): string {
    const value = stampOf(path);
    this.stamps.set(path, value);
    return value;
  }

  /** Nazwy wpisów katalogu (podkatalogi albo pliki); brak katalogu = pusto, inny błąd = pusto + notatka. */
  entries(dir: string, kind: 'dir' | 'file'): string[] {
    if (this.stamp(dir) === 'missing') return [];
    let names: string[];
    try {
      names = [...DIRECT_DISK.sync('readdirNames', { path: dir })].sort();
    } catch (err) {
      this.note(`command catalog: not reading directory ${dir} (${codeOf(err)})`);
      return [];
    }
    return names.filter((name) => {
      const path = join(dir, name);
      try {
        const info = statOrMissing(path);
        return info !== undefined && (kind === 'dir' ? info.isDirectory() : info.isFile());
      } catch {
        return false;
      }
    });
  }

  /**
   * Początek pliku jako tekst albo `null` (brak pliku, plik specjalny albo błąd odczytu z notatką).
   *
   * Tylko plik zwykły (`safe-read.ts`): FIFO pod stałą nazwą (`SKILL.md`, `settings.local.json`) zamrażało
   * tu całą pętlę zdarzeń, bo odczyt jest synchroniczny. Dowiązanie wolno (`followSymlink: true`): dowiązane
   * `SKILL.md` i katalogi w `~/.claude/skills` to układ użytkownika, a FIFO za dowiązaniem i tak odpada na `fstat`.
   */
  head(path: string, max = HEAD_BYTES): string | null {
    if (this.stamp(path) === 'missing') return null;
    try {
      const read = DIRECT_DISK.sync('readHead', { path, maxBytes: max, followSymlink: true });
      if (read === null) {
        this.note(`${COMMAND_CATALOG_SKIP_FILE_LOG} ${path} (not a regular file)`);
        return null;
      }
      return read.bytes.toString('utf8');
    } catch (err) {
      this.note(`${COMMAND_CATALOG_SKIP_FILE_LOG} ${path} (${codeOf(err)})`);
      return null;
    }
  }

  /** Obiekt JSON z pliku albo `null`. Treści błędu parsera nie logujemy (potrafi zacytować plik). */
  json(path: string): Record<string, unknown> | null {
    const text = this.head(path, JSON_MAX_BYTES + 1);
    if (text === null) return null;
    if (Buffer.byteLength(text, 'utf8') > JSON_MAX_BYTES) {
      this.note(`command catalog: file ${path} larger than ${String(JSON_MAX_BYTES)} B — skipping`);
      return null;
    }
    try {
      const value: unknown = JSON.parse(text);
      return isRecord(value) ? value : null;
    } catch {
      this.note(`command catalog: unreadable JSON ${path} — skipping`);
      return null;
    }
  }

  note(line: string): void {
    this.notes.push(line);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'błąd';
}

/** Linie bloku frontmattera (`---` … `---` na początku pliku, opcjonalnie po BOM) albo `null`. */
function frontmatterLines(text: string): string[] | null {
  const block = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return block === null ? null : (block[1] ?? '').split(/\r?\n/);
}

/**
 * Pola frontmattera YAML (`---` … `---` na początku pliku): klucz najwyższego poziomu → wartość bez
 * cudzysłowów i bez komentarza. Tylko proste `klucz: wartość` — nic więcej z nagłówka nie czytamy.
 */
export function frontmatterOf(text: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const line of frontmatterLines(text) ?? []) {
    const pair = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (pair === null) continue;
    let value = (pair[2] ?? '').trim();
    // Wartość w cudzysłowie kończy się na cudzysłowie zamykającym; komentarz (` # …`) może stać po nim.
    const quoted = /^"([^"]*)"|^'([^']*)'/.exec(value);
    if (quoted !== null) {
      value = quoted[1] ?? quoted[2] ?? '';
    } else {
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    out.set(pair[1] ?? '', value);
  }
  return out;
}

/**
 * Ucieczki YAML w podwójnym cudzysłowie (YAML 1.2, „Escaped Characters”): znak po `\` → znak. Sterujące
 * (`\n`, `\t`, `\e`…) i tak zwijają się potem do spacji.
 */
const YAML_ESCAPES: Readonly<Record<string, string>> = {
  '0': '\u0000', a: '\u0007', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\u001b',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029',
};

/** Długość szesnastkowego kodu znaku po `\x`, `\u` i `\U`. */
const YAML_HEX_ESCAPES: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };

/**
 * Wartość w cudzysłowie (`"…"` z ucieczkami YAML, `'…'` z `''`) bez cudzysłowów. Bez zamknięcia albo
 * z ucieczką, której YAML nie zna — `null` (docs `skills.md`, „Frontmatter reference”: nagłówek, którego YAML się
 * nie parsuje, nie daje żadnego pola).
 */
function quotedScalar(text: string): string | null {
  const quote = text[0];
  let out = '';
  for (let i = 1; i < text.length; i += 1) {
    const char = text[i] ?? '';
    if (quote === '"' && char === '\\') {
      const next = text[i + 1] ?? '';
      const simple = YAML_ESCAPES[next];
      const digits = YAML_HEX_ESCAPES[next];
      if (simple !== undefined) {
        out += simple;
        i += 1;
      } else if (digits !== undefined) {
        const hex = text.slice(i + 2, i + 2 + digits);
        const code = /^[0-9A-Fa-f]+$/.test(hex) && hex.length === digits ? Number.parseInt(hex, 16) : NaN;
        if (!(code <= 0x10ffff)) return null;
        out += String.fromCodePoint(code);
        i += 1 + digits;
      } else {
        return null;
      }
    } else if (quote === "'" && char === "'" && text[i + 1] === "'") {
      out += "'";
      i += 1;
    } else if (char === quote) {
      return out;
    } else {
      out += char;
    }
  }
  return null;
}

/** Ucina tekst do `max` znaków UTF-16 z `…`, bez rozcinania pary zastępczej. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const char of text) {
    if (out.length + char.length > max - 1) break;
    out += char;
  }
  return `${out.trimEnd()}…`;
}

/**
 * Text of a frontmatter field shown to a human (`description`, `argument-hint`, the app's hint list).
 * Unlike {@link frontmatterOf} it also reads the multi-line values YAML allows: a `>` or `|` block and
 * a continuation indented under the key (skills often write `description: >`).
 * Whitespace collapsed to one space, control characters removed, the whole cut to
 * {@link COMMAND_TEXT_MAX}. A missing field, a list, a map, an unclosed quote or empty text = `undefined`.
 */
export function frontmatterText(text: string, key: string): string | undefined {
  const lines = frontmatterLines(text) ?? [];
  let at = -1;
  let head = '';
  lines.forEach((line, index) => {
    const pair = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    // Ostatnie wystąpienie klucza wygrywa — jak w `frontmatterOf`.
    if (pair?.[1] === key) {
      at = index;
      head = (pair[2] ?? '').trim();
    }
  });
  if (at === -1) return undefined;
  // Sam komentarz po kluczu (`description: # uwaga`) to brak wartości w tej linii, nie tekst.
  if (head.startsWith('#')) head = '';
  const rest: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && !/^[ \t]/.test(line)) break;
    rest.push(line.trim());
  }
  let value: string | null;
  if (/^[|>][0-9+-]*(?:[ \t]+#.*)?$/.test(head)) {
    // Blok `|` zachowuje znaki nowej linii, `>` je składa — w jednej linii podpowiedzi oba to spacja.
    value = rest.join(' ');
  } else if (head.startsWith('"') || head.startsWith("'")) {
    value = quotedScalar([head, ...rest].join(' '));
  } else {
    // Linie samego komentarza nie są treścią zwykłej wartości — także przed wartością pod pustym kluczem.
    const lines = [head, ...rest].filter((line) => !line.startsWith('#'));
    const first = lines.find((line) => line !== '') ?? '';
    // Pod pustym kluczem lista (`- x`) albo mapa (`a: b`) to nie tekst.
    if (head === '' && (/^-(?:\s|$)/.test(first) || /^[A-Za-z0-9_-]+:(?:\s|$)/.test(first))) return undefined;
    value = lines.map((line) => {
      const comment = line.search(/\s#/);
      return comment === -1 ? line : line.slice(0, comment);
    }).join(' ');
  }
  if (value === null) return undefined;
  // Znaki sterujące U+0000–U+001F i U+007F–U+009F (także sekwencje terminala) apka pokazałaby dosłownie — wypadają.
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean === '' ? undefined : clip(clean, COMMAND_TEXT_MAX);
}

/** Opis i podpowiedź argumentu z frontmattera — pola, których nie ma, nie ma też w wyniku. */
function commandTextOf(text: string): CommandText {
  const description = frontmatterText(text, DISK_LAYOUT.frontmatterKeys.description);
  const argumentHint = frontmatterText(text, DISK_LAYOUT.frontmatterKeys.argumentHint);
  return {
    ...(description === undefined ? {} : { description }),
    ...(argumentHint === undefined ? {} : { argumentHint }),
  };
}

/**
 * Czy skill jest ukryty przed człowiekiem. Docs `skills.md`, „Frontmatter reference”: `user-invocable: false`
 * chowa skill z menu „/”, domyślnie pole jest `true`, a pole logiczne przyjmuje `true`, `false`, `yes`, `no`,
 * `on`, `off`, `1` i `0` bez względu na wielkość liter. Rarog: bez pola — widoczny; z polem — widoczny WYŁĄCZNIE
 * przy wartości prawdziwej (`true`, `1`, `yes`, `on`), każda inna chowa. Wartości spoza zbioru i pustej docs nie
 * opisują: chowanie jej to ostrożność Raroga.
 */
function notUserInvocable(meta: ReadonlyMap<string, string>): boolean {
  const value = meta.get(DISK_LAYOUT.frontmatterKeys.userInvocable);
  return value !== undefined && !/^(?:true|1|yes|on)$/i.test(value.trim());
}

/** Ustawienia z trzech plików, klucz po kluczu: `settings.local.json` > `settings.json` projektu > konto. */
function readSettings(scan: Scan, home: string, cwd: string): Settings {
  const files = [
    join(home, DISK_LAYOUT.configDir, DISK_LAYOUT.settings),
    join(cwd, DISK_LAYOUT.configDir, DISK_LAYOUT.settings),
    join(cwd, DISK_LAYOUT.configDir, DISK_LAYOUT.localSettings),
  ];
  const enabledPlugins = new Map<string, unknown>();
  const skillOverrides = new Map<string, unknown>();
  for (const file of files) {
    const settings = scan.json(file);
    if (settings === null) continue;
    const enabled = settings[DISK_LAYOUT.settingsKeys.enabledPlugins];
    if (isRecord(enabled)) for (const [key, value] of Object.entries(enabled)) enabledPlugins.set(key, value);
    const overrides = settings[DISK_LAYOUT.settingsKeys.skillOverrides];
    if (isRecord(overrides)) {
      for (const [key, value] of Object.entries(overrides)) skillOverrides.set(key.toLowerCase(), value);
    }
  }
  return { enabledPlugins, skillOverrides };
}

/** Katalog `cwd` i rodzice do pierwszego `.git` włącznie, nie wyżej niż korzeń z `roots`. */
function projectChain(scan: Scan, cwd: string, roots: readonly string[]): { dirs: string[]; repoRoot: string | null } {
  const start = resolve(cwd);
  const bound = roots.map((root) => resolve(root))
    .filter((root) => start === root || start.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))
    .sort((a, b) => b.length - a.length)[0];
  const dirs: string[] = [];
  let dir = start;
  for (;;) {
    dirs.push(dir);
    if (scan.stamp(join(dir, DISK_LAYOUT.gitDir)) !== 'missing') return { dirs, repoRoot: dir };
    if (bound === undefined || dir === bound) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { dirs, repoRoot: null };
}

/** Skille katalogu `skills/` (użytkownika albo projektu): nazwa katalogu i ewentualnie `name`. */
function scanSkillDirs(scan: Scan, dir: string, origin: DiscoverOrigin, settings: Settings): void {
  for (const entry of scan.entries(dir, 'dir')) {
    if ((DISK_LAYOUT.synced.reservedDirs as readonly string[]).includes(entry)) continue;
    if (!isCommandSegment(entry)) continue;
    const text = scan.head(join(dir, entry, DISK_LAYOUT.skillFile));
    if (text === null) continue;
    const meta = frontmatterOf(text);
    const named = meta.get(DISK_LAYOUT.frontmatterKeys.name) ?? '';
    const secondary = isCommandSegment(named) && named.toLowerCase() !== entry.toLowerCase() ? named : null;
    scan.skills.push({
      primary: entry, secondary, origin, hidden: hiddenReason(meta, settings, entry, secondary), text: commandTextOf(text),
    });
  }
}

/** Komendy katalogu `commands/` (pierwszy poziom): nazwa pliku bez `.md`, frontmatter `name` się nie liczy. */
function scanCommandFiles(scan: Scan, dir: string, origin: DiscoverOrigin, settings: Settings): void {
  for (const entry of scan.entries(dir, 'file')) {
    if (!entry.endsWith(DISK_LAYOUT.commandExt)) continue;
    const name = entry.slice(0, -DISK_LAYOUT.commandExt.length);
    if (!isCommandSegment(name)) continue;
    const text = scan.head(join(dir, entry));
    if (text === null) continue;
    const hidden = hiddenReason(frontmatterOf(text), settings, name, null);
    scan.skills.push({ primary: name, secondary: null, origin, hidden, text: commandTextOf(text) });
  }
}

function hiddenReason(
  meta: ReadonlyMap<string, string>, settings: Settings, primary: string, secondary: string | null,
): HiddenReason | null {
  if (notUserInvocable(meta)) return 'user-invocable';
  const off = DISK_LAYOUT.settingsKeys.overrideOff;
  if (settings.skillOverrides.get(primary.toLowerCase()) === off) return 'skill-overrides';
  if (secondary !== null && settings.skillOverrides.get(secondary.toLowerCase()) === off) return 'skill-overrides';
  return null;
}

/** Nazwy skilli z claude.ai ze wszystkich katalogów `synced/<konto>/` — który czyta sesja, nie wiemy. */
function scanSynced(scan: Scan, home: string): void {
  const root = join(home, DISK_LAYOUT.configDir, DISK_LAYOUT.skillsDir, DISK_LAYOUT.synced.dir);
  for (const bucket of scan.entries(root, 'dir')) {
    for (const entry of scan.entries(join(root, bucket), 'dir')) {
      if (isCommandSegment(entry)) scan.synced.add(entry);
    }
  }
}

/** Czy `child` leży w `parent` po rozwiązaniu dowiązań (ścieżka instalacji pluginu z pliku CLI). */
function insideReal(child: string, parent: string): boolean {
  try {
    const real = DIRECT_DISK.sync('realpath', { path: child });
    const base = DIRECT_DISK.sync('realpath', { path: parent });
    return real === base || real.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
  } catch {
    return false;
  }
}

function scanPlugins(scan: Scan, home: string, settings: Settings, repoRoot: string): void {
  const layout = DISK_LAYOUT.plugins;
  const pluginsDir = join(home, DISK_LAYOUT.configDir, layout.dir);
  const installed = scan.json(join(pluginsDir, layout.installed));
  if (installed === null) return;
  if (installed['version'] !== layout.installedVersion) {
    scan.note(`command catalog: ${layout.installed} at version ${String(installed['version'])} — skipping plugins`);
    return;
  }
  const plugins = installed['plugins'];
  if (!isRecord(plugins)) return;
  for (const key of Object.keys(plugins).sort()) {
    const entries = plugins[key];
    if (!Array.isArray(entries)) continue;
    const entry = entries.filter(isRecord).find((candidate) => (
      candidate['scope'] === layout.scopeUser
      || (candidate['scope'] === layout.scopeProject && typeof candidate['projectPath'] === 'string'
        && resolve(candidate['projectPath']) === repoRoot)
    ));
    if (entry === undefined) {
      const projectOnly = entries.filter(isRecord).some((candidate) => candidate['scope'] === layout.scopeProject);
      scan.skipped.push({ plugin: key, reason: projectOnly ? 'project-path' : 'scope' });
      continue;
    }
    scanPlugin(scan, pluginsDir, settings, key, entry);
  }
}

function scanPlugin(
  scan: Scan, pluginsDir: string, settings: Settings, key: string, entry: Record<string, unknown>,
): void {
  const layout = DISK_LAYOUT.plugins;
  const keys = DISK_LAYOUT.manifestKeys;
  const installPath = entry['installPath'];
  if (typeof installPath !== 'string' || !insideReal(installPath, pluginsDir)) {
    scan.skipped.push({ plugin: key, reason: 'install-path' });
    scan.note(`command catalog: plugin ${key} outside ${pluginsDir} — skipping`);
    return;
  }
  // Jawny wpis `enabledPlugins` wygrywa; włączone jest wyłącznie `true` (ostrożność Raroga: każda inna wartość
  // liczy się jako wyłączenie). Bez wpisu decyduje `defaultEnabled` manifestu, a jego brak znaczy `true`.
  const explicit = settings.enabledPlugins.get(key);
  if (explicit !== undefined && explicit !== true) {
    scan.skipped.push({ plugin: key, reason: 'disabled' });
    return;
  }
  const manifest = scan.json(join(installPath, layout.manifestDir, layout.manifest)) ?? {};
  if (explicit === undefined && manifest[keys.defaultEnabled] === false) {
    scan.skipped.push({ plugin: key, reason: 'disabled' });
    return;
  }
  if (keys.commands in manifest || keys.skills in manifest) {
    scan.skipped.push({ plugin: key, reason: 'manifest-paths' });
    scan.note(`command catalog: plugin ${key} has its own command or skill paths in the manifest — skipping`);
    return;
  }
  const manifestName = manifest[keys.name];
  const plugin = typeof manifestName === 'string' ? manifestName : key.slice(0, Math.max(0, key.lastIndexOf('@')));
  if (!isCommandSegment(plugin)) {
    scan.skipped.push({ plugin: key, reason: 'name' });
    return;
  }
  const skillsDir = join(installPath, DISK_LAYOUT.skillsDir);
  for (const dir of scan.entries(skillsDir, 'dir')) {
    if (!isCommandSegment(dir)) continue;
    const text = scan.head(join(skillsDir, dir, DISK_LAYOUT.skillFile));
    if (text === null) continue;
    const meta = frontmatterOf(text);
    const raw = meta.get(DISK_LAYOUT.frontmatterKeys.name) ?? '';
    const own = raw.toLowerCase().startsWith(`${plugin.toLowerCase()}:`) ? raw.slice(plugin.length + 1) : raw;
    const name = `${plugin}:${isCommandSegment(own) ? own : dir}`;
    if (notUserInvocable(meta)) {
      scan.pluginHidden.push({ name, origin: 'plugin-skill', reason: 'user-invocable' });
      continue;
    }
    scan.plugins.push({ name, source: 'plugin', origin: 'plugin-skill', ...commandTextOf(text) });
  }
  const commandsDir = join(installPath, DISK_LAYOUT.commandsDir);
  for (const file of scan.entries(commandsDir, 'file')) {
    if (!file.endsWith(DISK_LAYOUT.commandExt)) continue;
    const base = file.slice(0, -DISK_LAYOUT.commandExt.length);
    if (!isCommandSegment(base)) continue;
    const text = scan.head(join(commandsDir, file));
    if (text === null) continue;
    const name = `${plugin}:${base}`;
    if (notUserInvocable(frontmatterOf(text))) {
      scan.pluginHidden.push({ name, origin: 'plugin-command', reason: 'user-invocable' });
      continue;
    }
    scan.plugins.push({ name, source: 'plugin', origin: 'plugin-command', ...commandTextOf(text) });
  }
}

/**
 * Nazwy z kandydatów: najpierw nazwy podstawowe (katalog, plik), potem drugie nazwy z frontmattera —
 * te wyłącznie bez kolizji z czymkolwiek znanym, bo przy kolizji CLI wykonałby inną komendę.
 */
function resolveNames(scan: Scan, reserved: ReadonlySet<string>): {
  commands: DiscoveredCommand[]; hidden: HiddenCommand[];
} {
  const commands: DiscoveredCommand[] = [];
  const hidden: HiddenCommand[] = [];
  const taken = new Set<string>(reserved);
  const add = (
    name: string, origin: DiscoverOrigin, reason: HiddenReason | null, source: 'skill' | 'plugin', text: CommandText,
  ): void => {
    const lower = name.toLowerCase();
    if (reserved.has(lower)) {
      hidden.push({ name, origin, reason: 'reserved-name' });
      scan.note(`command catalog: ${origin} "${name}" has a built-in command name — left out of the catalog`);
      return;
    }
    if (taken.has(lower)) return;
    taken.add(lower);
    if (reason !== null) hidden.push({ name, origin, reason });
    else commands.push({ name, source, origin, ...text });
  };
  for (const skill of scan.skills) add(skill.primary, skill.origin, skill.hidden, 'skill', skill.text);
  for (const command of scan.plugins) {
    const { name, origin, source: _source, ...text } = command;
    add(name, origin, null, 'plugin', text);
  }
  for (const command of scan.pluginHidden) add(command.name, command.origin, command.reason, 'plugin', {});
  // Drugie nazwy: kolizja z nazwą podstawową, wbudowaną albo z drugą nazwą innego skilla = żadna.
  const claims = new Map<string, number>();
  for (const skill of scan.skills) {
    if (skill.secondary === null) continue;
    const lower = skill.secondary.toLowerCase();
    claims.set(lower, (claims.get(lower) ?? 0) + 1);
  }
  for (const skill of scan.skills) {
    if (skill.secondary === null) continue;
    const lower = skill.secondary.toLowerCase();
    if (taken.has(lower) || claims.get(lower) !== 1) continue;
    taken.add(lower);
    if (skill.hidden !== null) hidden.push({ name: skill.secondary, origin: skill.origin, reason: skill.hidden });
    else commands.push({ name: skill.secondary, source: 'skill', origin: skill.origin, ...skill.text });
  }
  return { commands, hidden };
}

/** Jeden pełny skan źródeł dla katalogu panelu. Nic nie rzuca: błąd źródła = źródło puste + notatka. */
export function discoverCommands(opts: DiscoverOptions): DiscoverResult {
  const scan = new Scan();
  const settings = readSettings(scan, opts.home, opts.cwd);
  const { dirs, repoRoot } = projectChain(scan, opts.cwd, opts.roots);
  const userDir = join(opts.home, DISK_LAYOUT.configDir);
  scanSkillDirs(scan, join(userDir, DISK_LAYOUT.skillsDir), 'user-skill', settings);
  scanCommandFiles(scan, join(userDir, DISK_LAYOUT.commandsDir), 'user-command', settings);
  for (const dir of dirs) {
    const projectDir = join(dir, DISK_LAYOUT.configDir);
    // `~/.claude` jako rodzic projektu to katalog konta, już przeczytany wyżej.
    if (projectDir === userDir) continue;
    scanSkillDirs(scan, join(projectDir, DISK_LAYOUT.skillsDir), 'project-skill', settings);
    scanCommandFiles(scan, join(projectDir, DISK_LAYOUT.commandsDir), 'project-command', settings);
  }
  scanSynced(scan, opts.home);
  scanPlugins(scan, opts.home, settings, repoRoot ?? resolve(opts.cwd));
  const { commands, hidden } = resolveNames(scan, opts.reserved);
  return {
    commands,
    hidden,
    synced: [...scan.synced].sort(),
    skippedPlugins: scan.skipped,
    notes: scan.notes,
    stamps: scan.stamps,
  };
}
