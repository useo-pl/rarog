/**
 * Czy tekst wysyłki jest slash-komendą i czy Rarog ją przepuszcza — JEDNA definicja.
 *
 * Z tej decyzji korzysta strażnik tekstu (`guard.ts`, w managerze i drugi raz w driverze), a jej wynik
 * (`SlashCommand`) driver dostaje w `SendOptions`: komenda jedzie bez `wait` i bez stall-guarda (typ `local`
 * nie startuje tury, pomiar żywy `commands/measured/live-2.1.310.json`; typ `prompt` jedzie tak
 * samo), a echo jej tekstu nie trafia do kolejki echa. Rozpoznanie ma skutek dla
 * BEZPIECZEŃSTWA: stall-guard potrafi wysłać tekst DRUGI RAZ, więc ścieżkę bez niego dostaje wyłącznie
 * komenda z katalogu sesji. Druga kopia reguły w innym pliku rozjechałaby te miejsca przy pierwszej
 * zmianie (strażnik: `server/test/herdr-commands-boundary.test.ts`).
 *
 * Reguła to ostrożny model Raroga z obserwacji i dokumentacji (`docs/slash-commands.md`, „Measurements” i „Live measurement”;
 * docs `commands.md`, wstęp i „How the command menu matches what you type”): komenda stoi na początku wiadomości,
 * a tekst po nazwie to jej argumenty; menu „/” podświetla komendę bez względu na wielkość liter, także po aliasie
 * (pomiar `commands/measured/live-2.1.310.json`), a Enter wykonuje podświetloną podpowiedź prefiksu; istniejąca
 * ścieżka jest promptem, o ile podpowiedź z Enterem jej nie dopełni; pierwszy argument potrafi przekierować
 * komendę do innej (`subcommands`). Gdzie zachowania CLI nie zmierzyliśmy (`/<nazwa> <argument>` przy komendzie
 * `/<nazwa>:<argument>`, nazwa spoza kształtu nazw Raroga, przekierowanie z dalszymi argumentami), Rarog odmawia
 * albo bierze cel przekierowania: to ostrożność, nie pomiar.
 */
import { statSync } from 'node:fs';
import { say } from '@rarog/shared/sentences';
import type { ServerSentence } from '@rarog/shared/sentences';
import { EXIT_WORDS, MCP_PROMPT_MARKER, MCP_PROMPT_PREFIX, REFUSAL_HINTS } from './registry.ts';
import type { CatalogCommand, CatalogKind, CommandCatalog, KnownName } from './catalog.ts';

/**
 * Kształt Raroga dla nazwy komendy: litera, cyfra albo `_`, potem także `:` i `-`. To reguła Raroga, nie
 * opis CLI: docs `skills.md` („Characters a skill name can’t hold”) podają tylko znaki, których nazwa mieć nie
 * może, więc nazwa CLI bywa szersza (kropka, ukośnik w zagnieżdżonym skillu).
 */
const COMMAND_NAME = /^[A-Za-z0-9_][A-Za-z0-9:_-]*$/;

/** Kształt Raroga dla nazwy komendy bez ukośnika (`compact`, `pr-review-toolkit:review-pr`). */
export function isCommandName(name: string): boolean {
  return COMMAND_NAME.test(name);
}

/** Jeden człon nazwy (katalog skilla, plik komendy, nazwa pluginu): kształt {@link isCommandName} bez dwukropka. */
export function isCommandSegment(name: string): boolean {
  return COMMAND_NAME.test(name) && !name.includes(':');
}

/** Komenda z katalogu sesji, którą tekst wywołuje. */
export interface SlashCommand {
  /** Nazwa kanoniczna z katalogu, bez ukośnika. */
  readonly name: string;
  readonly kind: CatalogKind;
}

export type SlashClassification =
  | { readonly type: 'prompt' }
  | { readonly type: 'command'; readonly command: SlashCommand }
  | {
    readonly type: 'refused';
    /** Pierwszy token (albo całe słowo wyjścia) — do dziennika odmów; ma kształt nazwy komendy. */
    readonly token: string;
    /** Zdanie dla człowieka (router pokazuje je dosłownie, apka tłumaczy kod). */
    readonly message: ServerSentence;
  };

export interface ClassifyDeps {
  /** `stat` ścieżki z reguły 5; produkcja: `statSync` (ten sam system plików co CLI). */
  readonly exists?: (path: string) => boolean;
}

function defaultExists(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}

/** Czy dwie klasyfikacje mówią o tej samej komendzie (strażnik drivera porównuje je z managerem). */
export function sameSlash(a: SlashCommand | null, b: SlashCommand | null): boolean {
  if (a === null || b === null) return a === b;
  return a.name === b.name && a.kind === b.kind;
}

/** Wynik klasyfikacji jako komenda dla drivera; `refused` nie ma prawa tu dojść (rzuca strażnik). */
export function slashOf(result: SlashClassification): SlashCommand | null {
  return result.type === 'command' ? result.command : null;
}

const MAX_HINTS = 3;

/** Podkod wskazówki w odmowie nazwy znanej (`hint:code`): zamknięty zbiór. */
type RefusalHint =
  | 'commands.hint.run-in-terminal'
  | 'commands.hint.run-skill-in-terminal'
  | 'commands.hint.rarog-blocks-skill'
  | 'commands.hint.use-model-button'
  | 'commands.hint.end-session-button'
  | 'commands.hint.write-plain-message';

/**
 * Wskazówka z `REFUSAL_HINTS` wygrywa z domyślną. Przy skillu `claude-only` bez „terminalu”, bo tam CLI też
 * odmawia człowiekowi (pomiar żywy 2.1.310).
 */
function specialHint(canonical: string, fallback: RefusalHint): RefusalHint {
  const special = REFUSAL_HINTS[canonical];
  if (special === 'model-button') return 'commands.hint.use-model-button';
  if (special === 'end-session') return 'commands.hint.end-session-button';
  if (special === 'claude-only') return 'commands.hint.write-plain-message';
  return fallback;
}

function list(names: readonly string[]): string {
  return names.slice(0, MAX_HINTS).map((name) => `/${name}`).join(', ');
}

/** Zdanie o nazwie znanej CLI, której Rarog nie przepuszcza. */
function knownRefusal(token: string, known: KnownName): ServerSentence {
  const canonical = known.canonical;
  if (known.alias && known.allowed) return say('commands.alias-use-canonical', { token, canonical });
  const special = REFUSAL_HINTS[canonical];
  if (known.alias) {
    return say('commands.refused-alias', {
      token, canonical, hint: specialHint(canonical, 'commands.hint.run-in-terminal'),
    });
  }
  if (known.origin === 'synced') {
    return say('commands.refused-synced-skill', {
      token, hint: specialHint(canonical, 'commands.hint.run-skill-in-terminal'),
    });
  }
  if (known.origin === 'hidden') {
    return say('commands.refused-hidden-skill', {
      token, hint: specialHint(canonical, 'commands.hint.rarog-blocks-skill'),
    });
  }
  // Skill `claude-only` ma zawsze tę samą wskazówkę, więc stoi ona w szablonie zdania.
  if (special === 'claude-only') return say('commands.refused-claude-skill', { token });
  if (special === 'model-button') return say('commands.refused-known.use-model-button', { token });
  if (special === 'end-session') return say('commands.refused-known.end-session', { token });
  return say('commands.refused-known.run-in-terminal', { token });
}

/** Zdanie o nazwie, której Rarog nie zna: podpowiedź pełnej nazwy, komendy pluginu albo terminala. */
function unknownRefusal(
  token: string, lower: string, second: string | undefined, catalog: CommandCatalog,
): ServerSentence {
  if (lower.startsWith(MCP_PROMPT_PREFIX)) return say('commands.mcp-prompt', { token });
  if (second !== undefined) {
    const joined = catalog.commands.get(`${lower}:${second.toLowerCase()}`);
    if (joined !== undefined) return say('commands.use-joined', { token, name: joined.name });
  }
  const namespaced = [...catalog.commands.values()]
    .filter((entry) => entry.name.toLowerCase().endsWith(`:${lower}`)).map((entry) => entry.name).sort();
  if (namespaced.length > 0) return say('commands.namespaced', { token, names: list(namespaced) });
  const completions = [...catalog.commands.values()]
    .filter((entry) => entry.name.toLowerCase().startsWith(lower)).map((entry) => entry.name).sort();
  if (completions.length > 0) return say('commands.incomplete-name', { token, names: list(completions) });
  const blocked = [...new Set([...catalog.names.entries()].filter(([word]) => word.startsWith(lower))
    .map(([, entry]) => entry.canonical))].sort();
  if (blocked.length > 0) {
    // `count` wybiera liczbę mnogą zdania („which”/„none of which”), sam nie stoi w tekście.
    const args = { token, names: list(blocked), count: blocked.length };
    return blocked.every((name) => REFUSAL_HINTS[name] === 'claude-only')
      ? say('commands.completes-to-blocked.claude-only', args)
      : say('commands.completes-to-blocked', args);
  }
  return say('commands.unknown', { token });
}

/**
 * Komenda, do której CLI przekieruje `command` po pierwszym argumencie (`BundledSkill.subcommands` rejestru: docs
 * albo reguła na katalogu sondy): słowo małymi literami z `subcommands`, także przy dalszych argumentach — przy
 * wątpliwości Rarog bierze cel przekierowania (ostrożniej).
 */
function redirectOf(command: CatalogCommand, args: string): { word: string; target: string } | undefined {
  if (command.subcommands === undefined) return undefined;
  const space = args.search(/\s/);
  const word = space === -1 ? args : args.slice(0, space);
  if (word === '' || !Object.hasOwn(command.subcommands, word.toLowerCase())) return undefined;
  const target = command.subcommands[word.toLowerCase()];
  return target === undefined ? undefined : { word, target };
}

/**
 * Klasyfikacja tekstu wysyłki wobec katalogu sesji:
 *
 * 0. Cały tekst (po `trim`, bez względu na wielkość liter — ostrożność Raroga) równy słowu wyjścia
 *    (`EXIT_WORDS`: `quit`, `:q`…) → `refused`: CLI zakończyłby proces (pomiar żywy każdego słowa, 2.1.310).
 * 1. Pierwszy token (do pierwszego białego znaku; reguła Raroga: docs `skills.md` dopuszczają w nazwie
 *    skilla jedną spację między słowami, a takiej nazwy nie mierzyliśmy) nie zaczyna się od `/` → `prompt`;
 *    sam ukośnik → `refused`; `/<nazwa> (MCP)` (prompt serwera MCP) → `refused`.
 * 2. Nazwa małymi literami równa nazwie z katalogu → `command`; pierwszy argument przekierowujący
 *    (`/code-review ultra` → `/ultrareview`) daje komendę docelową, gdy jest w katalogu, inaczej `refused`.
 * 3. Równa aliasowi → `refused` z nazwą kanoniczną (aliasy nie przechodzą, więc tekst wysłany = zapisany).
 * 4. Nazwa poza kształtem nazw Raroga ({@link isCommandName}): komendy z kropką albo ukośnikiem w nazwie mogą istnieć
 *    (docs `skills.md` nie zabraniają kropki w „Characters a skill name can’t hold”, a „How a skill gets its command
 *    name” daje zagnieżdżony `apps/web:deploy`), a jak CLI traktuje taką nazwę, niezmierzone: ostrożność Raroga. Z
 *    ukośnikiem i bez dwukropka → `prompt` (ścieżka: każda nazwa z ukośnikiem w tej tabeli docs ma dwukropek); reszta →
 *    `refused`.
 * 5. `/<nazwa>` istnieje na dysku i NIE jest prefiksem żadnej znanej nazwy ani aliasu → `prompt`;
 *    jest prefiksem → `refused` z podpowiedzią „dopisz ukośnik” (z drugim ukośnikiem CLI bierze ją za tekst).
 * 6. Reszta → `refused` z podpowiedzią.
 */
export function classifySlashText(
  text: string, catalog: CommandCatalog, deps: ClassifyDeps = {},
): SlashClassification {
  const whole = text.trim();
  const exitWord = (EXIT_WORDS.words as readonly string[]).find((word) => word === whole.toLowerCase());
  if (exitWord !== undefined) {
    return {
      type: 'refused',
      token: exitWord,
      message: say('commands.exit-word', { command: whole }),
    };
  }
  const space = whole.search(/\s/);
  const token = space === -1 ? whole : whole.slice(0, space);
  const args = space === -1 ? '' : whole.slice(space + 1).trim();
  if (!token.startsWith('/')) return { type: 'prompt' };
  // Sam ukośnik: CLI otwiera listę podpowiedzi, a Enter wykonałby pierwszą z nich (prefiks).
  if (token === '/') {
    return {
      type: 'refused', token, message: say('commands.bare-slash'),
    };
  }
  const name = token.slice(1);
  const lower = name.toLowerCase();
  // `/<nazwa> (MCP)` CLI wykonuje jako prompt serwera MCP o tej nazwie, nie komendę `<nazwa>`.
  const marker = args === MCP_PROMPT_MARKER
    || (args.startsWith(MCP_PROMPT_MARKER) && /\s/.test(args.charAt(MCP_PROMPT_MARKER.length)));
  if (marker) {
    return {
      type: 'refused', token,
      // `MCP_PROMPT_MARKER` to stała „(MCP)”, w szablonie zdania stoi dosłownie.
      message: say('commands.mcp-prompt.marked', { token }),
    };
  }

  const command = catalog.commands.get(lower);
  if (command !== undefined) {
    const redirect = redirectOf(command, args);
    if (redirect === undefined) return { type: 'command', command: { name: command.name, kind: command.kind } };
    const target = catalog.commands.get(redirect.target.toLowerCase());
    if (target !== undefined) return { type: 'command', command: { name: target.name, kind: target.kind } };
    return {
      type: 'refused',
      token,
      message: say('commands.redirect-blocked', { token, word: redirect.word, target: redirect.target }),
    };
  }

  const known = catalog.names.get(lower);
  if (known !== undefined && known.alias) return { type: 'refused', token, message: knownRefusal(token, known) };

  if (!isCommandName(name)) {
    if (name.includes('/') && !name.includes(':')) return { type: 'prompt' };
    return {
      type: 'refused',
      token,
      message: say('commands.not-in-catalog', { token }),
    };
  }

  const exists = deps.exists ?? defaultExists;
  if (exists(`/${name}`)) {
    const prefixOf = [...catalog.names.keys()].some((word) => word.startsWith(lower));
    if (!prefixOf) return { type: 'prompt' };
    return {
      type: 'refused',
      token,
      message: say('commands.path-completes', { token }),
    };
  }

  if (known !== undefined) return { type: 'refused', token, message: knownRefusal(token, known) };
  return { type: 'refused', token, message: unknownRefusal(token, lower, args.split(/\s+/)[0] || undefined, catalog) };
}
