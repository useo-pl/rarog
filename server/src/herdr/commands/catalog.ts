/**
 * Katalog komend sesji — JEDNA migawka tego, co Rarog przepuszcza z telefonu, per `(cwd, wersja CLI)`.
 *
 * Migawka = wpisy `allowed` rejestru wbudowanych (`registry.ts`, zmierzone per wersja CLI) ∪ wbudowane
 * skille `allowed` ∪ skille i komendy z dysku w opisanym podzbiorze (`discover.ts`). Ta sama migawka idzie
 * do strażnika managera, do drugiego strażnika w driverze (przez `SendOptions`) i do listy podpowiedzi apki
 * (`GET /api/sessions/:id/commands`, {@link commandListOf}), więc „lista po »/«” i „to, co przejdzie” są
 * jedną rzeczą (`revision`).
 *
 * Obok listy dozwolonych migawka niesie WSZYSTKIE nazwy, które CLI może znać (`names`): wbudowane i ich
 * aliasy, skille ukryte filtrem, skille z claude.ai. Rarog ich nie przepuszcza, ale potrzebuje ich reguła
 * „ścieżka będąca prefiksem komendy” i zdanie odmowy („to alias /clear”, „skill z claude.ai”).
 *
 * Świeżość (fabryka {@link createCommandCatalogs}): sygnatura ze stempli KAŻDEGO czytanego pliku
 * i katalogu (`discover.ts`), sprawdzana najwyżej co 5 s; pełny skan najpóźniej co 60 s. Migawka o tej
 * samej treści zostaje TYM SAMYM obiektem z tym samym `revision`.
 */
import { createHash } from 'node:crypto';
import type { CommandChoice, CommandList } from '@rarog/shared';
import { BUILTIN_COMMANDS, BUNDLED_SKILLS, COMMANDS_CLI, DISK_LAYOUT } from './registry.ts';
import type { CommandKind } from './registry.ts';
import { discoverCommands, stampOf } from './discover.ts';
import type { CommandText, DiscoverOptions, DiscoverResult } from './discover.ts';

/** Sprawdzenie sygnatury migawki najwyżej co tyle. */
export const CATALOG_CHECK_MS = 5_000;
/** Pełny skan źródeł najpóźniej co tyle, nawet przy niezmienionej sygnaturze. */
export const CATALOG_RESCAN_MS = 60_000;

/** Jak kończy się dozwolona komenda: wynik w linii i powrót do pola (`local`) albo tura modelu (`prompt`). */
export type CatalogKind = Exclude<CommandKind, 'panel'>;

/** Skąd jest komenda w katalogu — w kształcie, który jedzie do apki (`CommandChoice.source`). */
export type CatalogSource = 'builtin' | 'skill' | 'plugin';

/**
 * Komenda dozwolona w sesji. `description` i `argumentHint` (frontmatter skilla albo komendy z dysku,
 * przycięte w `discover.ts`) jadą wyłącznie do listy apki; wbudowane ich nie mają, bo rejestr ich nie zna.
 */
export interface CatalogCommand extends CommandText {
  /** Nazwa kanoniczna bez ukośnika, w wielkości liter źródła (rejestr albo nazwa z dysku). */
  readonly name: string;
  readonly kind: CatalogKind;
  readonly source: CatalogSource;
  /**
   * Przekierowania pierwszego argumentu (rejestr, `BundledSkill.subcommands`): słowo małymi literami → komenda,
   * którą CLI wykona zamiast tej. `classifySlashText` przepuszcza przekierowanie tylko do komendy z katalogu.
   */
  readonly subcommands?: Readonly<Record<string, string>>;
}

/** Pochodzenie nazwy znanej CLI — także takiej, której Rarog nie przepuszcza. */
export type NameOrigin = 'builtin' | 'bundled-skill' | 'skill' | 'plugin' | 'hidden' | 'synced';

export interface KnownName {
  /** Nazwa kanoniczna, na którą wskazuje (dla aliasu — komenda, której jest aliasem). */
  readonly canonical: string;
  readonly origin: NameOrigin;
  readonly alias: boolean;
  /** Czy nazwa kanoniczna stoi w {@link CommandCatalog.commands}. */
  readonly allowed: boolean;
}

export interface CommandCatalog {
  /** Skrót treści migawki: ta sama lista = ten sam `revision`. */
  readonly revision: string;
  /** Katalog panelu, dla którego liczono dysk; `null` = migawka z samego rejestru. */
  readonly cwd: string | null;
  /** Wersja CLI, z której pomiaru pochodzi część wbudowana. */
  readonly cli: string;
  /**
   * Dozwolone komendy po nazwie małymi literami: menu „/” podświetla `usage` także na `/Usage` (pomiar
   * `commands/measured/live-2.1.310.json`, próba `p05`), a Enter wykonuje podświetloną podpowiedź (docs
   * `commands.md`, „How the command menu matches what you type”).
   */
  readonly commands: ReadonlyMap<string, CatalogCommand>;
  /** Każda nazwa i alias znane CLI, małymi literami. Pierwszy wpis wygrywa: wbudowane przed dyskiem. */
  readonly names: ReadonlyMap<string, KnownName>;
}

/** Nazwy i aliasy wbudowanych komend i skilli, małymi literami — kolizja z nimi chowa skill z dysku. */
export function reservedNames(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const entry of [...BUILTIN_COMMANDS, ...BUNDLED_SKILLS]) {
    out.add(entry.name.toLowerCase());
    for (const alias of entry.aliases) out.add(alias.toLowerCase());
  }
  return out;
}

/** Składa migawkę z rejestru i (opcjonalnie) wyniku skanu dysku. Czysta funkcja. */
export function buildCatalog(cwd: string | null, discovered: DiscoverResult | null): CommandCatalog {
  const commands = new Map<string, CatalogCommand>();
  const names = new Map<string, KnownName>();
  const allow = (
    name: string, kind: CatalogKind, source: CatalogSource,
    extra: Pick<CatalogCommand, 'subcommands' | 'description' | 'argumentHint'> = {},
  ): void => {
    const lower = name.toLowerCase();
    if (!commands.has(lower)) commands.set(lower, { name, kind, source, ...extra });
  };
  const know = (word: string, canonical: string, origin: NameOrigin, alias: boolean): void => {
    const lower = word.toLowerCase();
    if (names.has(lower)) return;
    names.set(lower, { canonical, origin, alias, allowed: commands.has(canonical.toLowerCase()) });
  };

  for (const entry of BUILTIN_COMMANDS) {
    if (entry.allowed && entry.kind !== 'panel') allow(entry.name, entry.kind, 'builtin');
  }
  for (const entry of BUNDLED_SKILLS) {
    if (!entry.allowed) continue;
    allow(entry.name, 'prompt', 'builtin', entry.subcommands === undefined ? {} : { subcommands: entry.subcommands });
  }
  for (const entry of discovered?.commands ?? []) {
    allow(entry.name, 'prompt', entry.source, {
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.argumentHint === undefined ? {} : { argumentHint: entry.argumentHint }),
    });
  }

  for (const entry of BUILTIN_COMMANDS) {
    know(entry.name, entry.name, 'builtin', false);
    for (const alias of entry.aliases) know(alias, entry.name, 'builtin', true);
  }
  for (const entry of BUNDLED_SKILLS) {
    know(entry.name, entry.name, 'bundled-skill', false);
    for (const alias of entry.aliases) know(alias, entry.name, 'bundled-skill', true);
  }
  for (const entry of discovered?.commands ?? []) know(entry.name, entry.name, entry.source, false);
  for (const entry of discovered?.hidden ?? []) know(entry.name, entry.name, 'hidden', false);
  for (const name of discovered?.synced ?? []) {
    know(name, name, 'synced', false);
    know(`${DISK_LAYOUT.synced.prefix}:${name}`, name, 'synced', false);
  }

  // Opis i podpowiedź są częścią treści: zmiana opisu skilla = nowa migawka i nowa `revision` dla apki.
  const content = JSON.stringify({
    cli: COMMANDS_CLI,
    commands: [...commands.values()]
      .map((entry) => [entry.name, entry.kind, entry.source, entry.description ?? null, entry.argumentHint ?? null])
      .sort(),
    names: [...names.entries()].map(([word, entry]) => [word, entry.canonical, entry.origin, entry.alias]).sort(),
  });
  const revision = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
  return { revision, cwd, cli: COMMANDS_CLI, commands, names };
}

/**
 * Lista dla apki (`GET /api/sessions/:id/commands`) z migawki — JEDYNA definicja tego, co z katalogu
 * jedzie do telefonu: nazwa, `kind`, źródło i (gdy są) opis z podpowiedzią argumentu. Bez aliasów (nie
 * przechodzą), bez przekierowań argumentów i bez ścieżek. `revision` migawki bez zmian, więc ta sama
 * `revision` w apce i w strażniku = ta sama lista. Kolejność: po nazwie małymi literami.
 */
export function commandListOf(catalog: CommandCatalog): CommandList {
  const commands: CommandChoice[] = [...catalog.commands.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, entry]) => ({
      name: entry.name,
      kind: entry.kind,
      source: entry.source,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.argumentHint === undefined ? {} : { argumentHint: entry.argumentHint }),
    }));
  return { revision: catalog.revision, commands };
}

let registryOnly: CommandCatalog | null = null;

/**
 * Migawka z SAMEGO rejestru (bez dysku): zapas dla wołającego bez fabryki katalogu (testy, demo). Dalej
 * allow-lista — skille z dysku dostają w niej odmowę, nigdy przepuszczenie.
 */
export function registryCatalog(): CommandCatalog {
  registryOnly ??= buildCatalog(null, null);
  return registryOnly;
}

export interface CommandCatalogs {
  /**
   * Migawka dla katalogu panelu i wersji CLI jego procesu (`null` = nie wiadomo). Wersja inna niż
   * zmierzona dostaje zestaw najnowszej zmierzonej i jedną linię logu na wersję.
   */
  get(cwd: string, cliVersion: string | null): CommandCatalog;
}

export interface CommandCatalogsOptions {
  readonly home: string;
  /** `RAROG_HERDR_ROOTS` — granica szukania `.claude/` w rodzicach `cwd`. */
  readonly roots: readonly string[];
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly checkMs?: number;
  readonly rescanMs?: number;
  /** Skan dysku (testy podstawiają licznik wywołań); domyślnie {@link discoverCommands}. */
  readonly discover?: (opts: DiscoverOptions) => DiscoverResult;
}

interface CacheEntry {
  catalog: CommandCatalog;
  stamps: ReadonlyMap<string, string>;
  checkedAt: number;
  scannedAt: number;
}

/** Czy któryś stempel skanu się zmienił. */
function stampsChanged(stamps: ReadonlyMap<string, string>): boolean {
  for (const [path, stamp] of stamps) if (stampOf(path) !== stamp) return true;
  return false;
}

/** Fabryka migawek z pamięcią per `cwd`. Jedna na proces serwera (`server/src/index.ts`). */
export function createCommandCatalogs(opts: CommandCatalogsOptions): CommandCatalogs {
  const now = opts.now ?? ((): number => Date.now());
  const checkMs = opts.checkMs ?? CATALOG_CHECK_MS;
  const rescanMs = opts.rescanMs ?? CATALOG_RESCAN_MS;
  const discover = opts.discover ?? discoverCommands;
  const reserved = reservedNames();
  const cache = new Map<string, CacheEntry>();
  const logged = new Set<string>();
  const logOnce = (line: string): void => {
    if (logged.has(line)) return;
    logged.add(line);
    opts.log?.(line);
  };

  return {
    get(cwd: string, cliVersion: string | null): CommandCatalog {
      if (cliVersion !== COMMANDS_CLI) {
        logOnce(`command catalog: CLI ${cliVersion ?? 'of unknown version'} not measured — built-in set `
          + `from the ${COMMANDS_CLI} measurement`);
      }
      // Jedna wersja zmierzona = jeden zestaw wbudowanych, więc klucz pamięci to sam katalog.
      const at = now();
      const entry = cache.get(cwd);
      if (entry !== undefined) {
        if (at - entry.checkedAt < checkMs) return entry.catalog;
        entry.checkedAt = at;
        if (at - entry.scannedAt < rescanMs && !stampsChanged(entry.stamps)) return entry.catalog;
      }
      let discovered: DiscoverResult;
      try {
        discovered = discover({ home: opts.home, cwd, roots: opts.roots, reserved });
      } catch (error: unknown) {
        // Skan nie rzuca z założenia; gdyby jednak — wysyłka nie dostaje 500, tylko allow-listę z samego
        // rejestru (skille z dysku dostają odmowę), a następne pytanie skanuje od nowa.
        logOnce(`command catalog: disk scan for ${cwd} failed (${error instanceof Error ? error.name : 'error'}) `
          + '— snapshot from the registry alone');
        cache.delete(cwd);
        return registryCatalog();
      }
      for (const note of discovered.notes) logOnce(note);
      const fresh = buildCatalog(cwd, discovered);
      const catalog = entry !== undefined && entry.catalog.revision === fresh.revision ? entry.catalog : fresh;
      cache.set(cwd, { catalog, stamps: discovered.stamps, checkedAt: at, scannedAt: at });
      return catalog;
    },
  };
}
