/**
 * Końcowy przebieg anonimizacji fixture'ów (opis: README fixture'ów herdr, „Writing a fixture”, i `docs/publishing.md`).
 *
 * Każdy skrypt pomiaru, który wyciąga fixture z żywego CLI albo panelu (dialogi, zadania w tle, kolejka, prompt
 * zablokowany, artefakty, komendy), zapisuje fixture WYŁĄCZNIE przez ten moduł, a zrzut ręczny przechodzi przez jego
 * CLI. Wyciąg robi swoje reguły (katalog panelu, numeracja wywołań, placeholdery treści); ten przebieg dokłada reguły
 * wspólne i sprawdzian:
 *
 * - zastępniki poprzednich wersji reguł → bieżące ({@link PLACEHOLDER_MIGRATIONS}, z zachowaniem długości);
 * - korzeń checkoutu (także worktree i forma ze slugiem magazynu CLI) → `/Users/u/Projects/rarog`;
 * - katalog domowy i każdy login spoza listy syntetycznych → `/Users/u` (`-Users-u-` w slugu);
 * - nazwy z mapy pseudonimów pliku prywatnych literałów → zastępniki (`alfa`, `beta`…);
 * - katalog tymczasowy macOS i numer użytkownika w `/tmp/claude-<uid>/` → zastępniki tej samej długości;
 * - identyfikatory API (`msg_`, `req_`, `toolu_`, `srvtoolu_`) i losowe UUID → numeracja tej samej długości;
 * - baner planu konta → `Claude Plan`, licznik limitu → kreski, e-mail → `u@example.com`, tailnet → `example`.
 *
 * Fail closed: bez pliku prywatnych literałów (albo z zepsutym) przebieg odmawia ({@link FixtureRefused}), a po
 * przebiegu literał albo wzorzec strukturalny, który został w tekście, też kończy się odmową. Komunikat podaje
 * linię i numer literału (`forbidden[3]`), nigdy treść.
 *
 * CLI (`tsx scripts/anonymize-fixture.ts`):
 *   --require              sam sprawdzian pliku literałów (0: jest, 2: brak albo zepsuty)
 *   --out <plik>           stdin → plik (filtr na końcu potoku skryptu pomiaru)
 *   <plik>…                pliki w miejscu (zrzut ręczny)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/is-main.mjs';
import {
  applyPseudonyms, findPrivateHits, loadPrivateLiterals, maskPath, privateLiteralsPath, type PrivateLiterals,
} from './lib/private-literals.mjs';
import {
  ACCOUNT_PLAN, API_ID, EMAIL, HOME_PATH, HOME_SLUG, LIMIT_COUNTER, TAILNET, privateEmail, privateLogin, privateTailnet,
  structuralHits,
} from './lib/private-patterns.mjs';

/**
 * Wersja reguł przebiegu; manifest pochodzenia (`provenance.json`) zapisuje ją przy każdym pliku. Wersja 2: korzeń
 * checkoutu nosi nową nazwę produktu, a zastępniki wersji 1 przechodzą migrację ({@link PLACEHOLDER_MIGRATIONS}).
 */
export const ANONYMIZER_VERSION = 2;

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Katalog domowy w fixture'ach. */
const HOME_PLACEHOLDER = '/Users/u';
/** Korzeń checkoutu w fixture'ach (decyzja 3: nazwa wydawcy nie stoi w ścieżkach). */
export const CHECKOUT = `${HOME_PLACEHOLDER}/Projects/rarog`;
/** Korzeń checkoutu w wersji 1 reguł: stara nazwa produktu, tej samej długości co nowa. */
export const CHECKOUT_V1 = `${HOME_PLACEHOLDER}/Projects/pilot`; /* stara-nazwa */
/** Wzorce, które przebieg przepisuje; trafienie po przebiegu = odmowa. Reszta (zgłoszenie, skrót) to sprawa zapadki. */
const REWRITTEN = new Set(['e-mail', 'tailnet', 'katalog-domowy', 'katalog-tymczasowy', 'identyfikator-api',
  'plan-konta', 'licznik-limitu']);
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

export class FixtureRefused extends Error {}

export interface AnonymizeContext {
  readonly tool: string;
  readonly literals: PrivateLiterals;
  readonly home: string;
  /** Korzenie checkoutu (worktree, potem główny), najdłuższe najpierw. */
  readonly roots: readonly string[];
  /** Numeracja identyfikatorów: ten sam oryginał w jednym procesie = ten sam zastępnik. */
  readonly ids: Map<string, string>;
}

/** Korzenie: repo tego skryptu i, gdy to worktree (`<główny>/.claude/worktrees/<nazwa>`), checkout główny. */
export function checkoutRoots(repo: string = REPO): string[] {
  const main = /^(.+)\/\.claude\/worktrees\/[^/]+$/.exec(repo)?.[1];
  return main === undefined ? [repo] : [repo, main];
}

/** Kontekst przebiegu albo odmowa: bez pliku prywatnych literałów fixture'u nie zapisujemy. */
export function fixtureContext(tool: string, env: NodeJS.ProcessEnv = process.env): AnonymizeContext {
  let literals: PrivateLiterals | null;
  try {
    literals = loadPrivateLiterals({ env });
  } catch (error) {
    throw new FixtureRefused(`${tool}: private literals file unusable (${(error as Error).message}); `
      + 'fixture not written');
  }
  if (literals === null) {
    throw new FixtureRefused(`${tool}: no private literals file (${privateLiteralsPath(env)}); fixture not `
      + 'written (fail closed, docs/publishing.md)');
  }
  return { tool, literals, home: env['HOME'] ?? homedir(), roots: checkoutRoots(), ids: new Map() };
}

const slug = (path: string): string => path.replace(/[^A-Za-z0-9]/g, '-');
/** Forma z tyldą ścieżki pod katalogiem domowym fixture'ów (`~/Projects/…`). */
const tilde = (path: string): string => `~${path.slice(HOME_PLACEHOLDER.length)}`;

/**
 * Migracja zastępników: wersja reguł → pary dosłowne (zastępnik tej wersji → zastępnik następnej). Fixture zapisany
 * starszą wersją przechodzi przez bieżący przebieg do tego samego tekstu, co świeży zapis, a drugi przebieg niczego
 * nie zmienia. Każda zamiana zachowuje długość, więc kolumny zrzutów ekranu i przesunięcia w nagraniach zostają.
 */
export const PLACEHOLDER_MIGRATIONS: Readonly<Record<number, readonly (readonly [string, string])[]>> = {
  1: [[CHECKOUT_V1, CHECKOUT], [slug(CHECKOUT_V1), slug(CHECKOUT)], [tilde(CHECKOUT_V1), tilde(CHECKOUT)]],
};

/** Zastępniki wersji `from` i każdej późniejszej → bieżące, po kolei wersjami. */
export function migratePlaceholders(text: string, from = 1): string {
  let out = text;
  for (let version = from; version < ANONYMIZER_VERSION; version += 1) {
    for (const [old, next] of PLACEHOLDER_MIGRATIONS[version] ?? []) out = out.split(old).join(next);
  }
  return out;
}

/** Pary dosłowne (ścieżki tej maszyny) → zastępniki, najdłuższe najpierw. */
function literalPairs(ctx: AnonymizeContext): [string, string][] {
  const pairs: [string, string][] = [];
  for (const root of ctx.roots) {
    const forms = [root];
    if (root.startsWith(`${ctx.home}/`)) forms.push(`/Users/u${root.slice(ctx.home.length)}`);
    for (const form of forms) pairs.push([form, CHECKOUT], [slug(form), slug(CHECKOUT)]);
    if (root.startsWith(`${ctx.home}/`)) pairs.push([`~${root.slice(ctx.home.length)}`, tilde(CHECKOUT)]);
  }
  if (ctx.home !== '' && ctx.home !== '/') {
    pairs.push([ctx.home, HOME_PLACEHOLDER], [slug(ctx.home), slug(HOME_PLACEHOLDER)]);
  }
  return pairs.filter(([from, to]) => from !== to).sort((a, b) => b[0].length - a[0].length);
}

/** Zastępnik tej samej długości z licznikiem (`toolu_00…01`): nie pasuje do wzorca identyfikatora API. */
function numbered(ctx: AnonymizeContext, kind: string, original: string, make: (n: number) => string): string {
  const key = `${kind}\u0000${original}`;
  const known = ctx.ids.get(key);
  if (known !== undefined) return known;
  const count = [...ctx.ids.keys()].filter((item) => item.startsWith(`${kind}\u0000`)).length + 1;
  const value = make(count);
  ctx.ids.set(key, value);
  return value;
}

/** Reguły przebiegu (bez sprawdzianu); tekst dowolnego formatu: zrzut ekranu, JSON, JSONL. */
export function anonymizeText(text: string, ctx: AnonymizeContext): string {
  let out = migratePlaceholders(text);
  for (const [from, to] of literalPairs(ctx)) out = out.split(from).join(to);
  out = out.replace(HOME_PATH, (all, login: string) => (privateLogin([all, login]) ? '/Users/u' : all));
  out = out.replace(HOME_SLUG, (all, login: string) => (privateLogin([all, login]) ? '-Users-u-' : all));
  out = applyPseudonyms(out, ctx.literals.pseudonyms);
  // Segmenty katalogu tymczasowego macOS to litery, cyfry i `_`: węższa klasa nie przechodzi przez granicę wartości
  // JSON (cudzysłów, przecinek) i łapie też ścieżkę bez końcowego ukośnika.
  out = out.replace(/\/var\/folders\/(\w+)\/(\w+)(?!\w)/g,
    (_all, a: string, b: string) => `/tmp/folders/${'x'.repeat(a.length)}/${'x'.repeat(b.length)}`);
  out = out.replace(/\/var\/folders\//g, '/tmp/folders/');
  out = out.replace(/(\/tmp\/claude-)\d+(?=\/)/g, '$1uid');
  out = out.replace(API_ID, (id, prefix: string) => numbered(ctx, prefix, id,
    (n) => `${prefix}_${String(n).padStart(id.length - prefix.length - 1, '0')}`));
  out = out.replace(UUID, (id, version: string) => (version === '5' || id.startsWith('00000000-0000-') ? id
    : numbered(ctx, 'uuid', id, (n) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`)));
  out = out.replace(ACCOUNT_PLAN, 'Claude Plan');
  out = out.replace(LIMIT_COUNTER, (all) => all.replace(/(?<=:\s?)\d+/, (digits) => '-'.repeat(digits.length)));
  out = out.replace(EMAIL, (all, domain: string) => (privateEmail([all, domain]) ? 'u@example.com' : all));
  out = out.replace(TAILNET, (all, tailnet: string) => (privateTailnet([all, tailnet]) ? 'mac.example.ts.net' : all));
  return out;
}

/** Co zostało po przebiegu: `linia N: forbidden[i] (kategoria)` albo `linia N: [wzorzec]`, bez treści. */
export function leftovers(text: string, literals: PrivateLiterals, file = ''): string[] {
  return [
    ...findPrivateHits(text, literals, file).map((hit) => `line ${String(hit.line)}: ${hit.ref} (${hit.label})`),
    ...structuralHits(text, file).filter((hit) => REWRITTEN.has(hit.name))
      .map((hit) => `line ${String(hit.line)}: [${hit.name}]`),
  ];
}

const repoPath = (file: string): string => {
  const rel = relative(REPO, resolve(file));
  return rel.startsWith('..') ? '' : rel;
};

/** Przebieg i sprawdzian; odmowa, gdy cokolwiek prywatnego zostało. `file` to cel (do `allow` i komunikatu). */
export function finalizeFixture(text: string, ctx: AnonymizeContext, file = ''): string {
  const out = anonymizeText(text, ctx);
  const left = leftovers(out, ctx.literals, file === '' ? '' : repoPath(file));
  if (left.length > 0) {
    const where = file === '' ? 'output' : maskPath(repoPath(file) || file, ctx.literals);
    throw new FixtureRefused(`${ctx.tool}: ${where} carries private data after anonymization (${left.slice(0, 8).join('; ')}`
      + `${left.length > 8 ? `; … ${String(left.length)} in total` : ''}); not written. Add a pseudonym to the literals `
      + 'file or a rule to the extract.');
  }
  return out;
}

/** Zapis fixture'u: przebieg, sprawdzian, dopiero potem plik. */
export function writeFixture(file: string, text: string, ctx: AnonymizeContext): void {
  writeFileSync(file, finalizeFixture(text, ctx, file));
}

export function main(argv: readonly string[], stdin: () => string, env: NodeJS.ProcessEnv = process.env): number {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stderr.write('usage: anonymize-fixture.ts --require | --out <file> (stdin) | <file>…\n');
    return 2;
  }
  const ctx = fixtureContext('anonymize-fixture', env);
  if (argv[0] === '--require') return 0;
  if (argv[0] === '--out') {
    const out = argv[1];
    if (out === undefined || argv.length !== 2) throw new FixtureRefused('anonymize-fixture: --out takes exactly one file');
    writeFixture(out, stdin(), ctx);
    return 0;
  }
  // W miejscu: najpierw sprawdzian wszystkich, potem zapis — odmowa jednego nie zostawia połowy zbioru.
  const done = argv.map((file) => [file, finalizeFixture(readFileSync(file, 'utf8'), ctx, file)] as const);
  for (const [file, text] of done) writeFileSync(file, text);
  return 0;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2), () => readFileSync(0, 'utf8'));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
