/**
 * Rejestr zdań serwera: JEDNO miejsce, w którym serwer trzyma zdania pokazywane w apce. Wpis to kod →
 * angielski szablon z `{nazwa}` (albo `{ one, other }` dla liczby mnogiej) → uporządkowane argumenty z rodzajami.
 * Serwer wysyła gotowy angielski tekst i obok niego `ref` (`{ code, args? }`); apka tłumaczy znany kod, a nieznany
 * pokazuje po angielsku. Z rejestru generator (`scripts/sentences-catalog.mjs`) buduje katalog apki i deskryptory
 * argumentów, więc rejestr jest źródłem prawdy dla obu stron.
 *
 * Reguła kontraktu: **opublikowany kod nie zmienia znaczenia, argumentów ani szablonu.** Serwery z npm zostają
 * u ludzi na starszych wersjach, a apka tłumaczy kod według swojego katalogu: zmiana treści pod starym kodem
 * pokazałaby w apce inne zdanie niż to, które serwer miał na myśli. Nowe znaczenie = nowy kod.
 *
 * `RETIRED`: kod, którego serwer już nie emituje, przechodzi z obszaru do `RETIRED` z polem `since` (wersja serwera,
 * od której nie wychodzi) i nigdy nie znika: katalog apki dalej go tłumaczy dla starszych serwerów. `SentenceCode`
 * to wyłącznie klucze `SENTENCES`, więc `say()` z kodem wycofanym nie kompiluje się, a w czasie wykonania rzuca.
 *
 * Pochodzenie tekstu wymusza typ, nie dyscyplina:
 * - `ServerSentence` (zdanie własne z kodem) tworzy wyłącznie `say()`;
 * - `ForeignText` (tekst obcy: agent, użytkownik, herdr, Node, ekran) tworzy `foreign` na granicy, gdzie treść
 *   wchodzi do serwera; taki tekst nigdy nie dostaje kodu i nie jest tłumaczony.
 * Trzeciej drogi nie ma: zdanie własne bez kodu się nie kompiluje, bo ujście zdania własnego (`OwnText`) przyjmuje
 * wyłącznie wynik `say()`.
 *
 * Marki stoją na symbolach `unique symbol`, których moduł nie eksportuje: gołego `string` ani ręcznie złożonego
 * obiektu nie da się podać tam, gdzie typ żąda zdania. Pliki obszarów (`rest.ts`, `session.ts`, …) trzymają wpisy;
 * kod ma postać `<obszar>.<nazwa>` w kebab-case, a obszar to nazwa pliku. Strażnik spójności:
 * `server/test/sentences-registry.test.ts`.
 *
 * Rodzaje argumentów (na drucie zawsze łańcuch):
 * - `int`: liczba całkowita z zakresu Int64, łańcuch dziesiętny (katalog `%lld`);
 * - `plural`: jak `int`, a szablon `{ one, other }` wybiera wariant według angielskiej reguły liczby;
 * - `text`: dane użytkownika i tekst obcy, bez zmian i nigdy nie tłumaczone (`%@`);
 * - `code`: podzdanie BEZ własnych argumentów z `SENTENCES`; w tekście jego `en`, w `ref` sam kod;
 * - `instant`: chwila w ISO 8601 (apka formatuje ją po swojemu).
 */
import { z } from 'zod';
import { COMMANDS_SENTENCES } from './commands.ts';
import { DEMO_SENTENCES } from './demo.ts';
import { DIALOGS_SENTENCES } from './dialogs.ts';
import { HERDR_SENTENCES } from './herdr.ts';
import { MODEL_SENTENCES } from './model.ts';
import { PUSH_SENTENCES } from './push.ts';
import { RESTART_SENTENCES } from './restart.ts';
import { REST_SENTENCES } from './rest.ts';
import { SESSION_SENTENCES } from './session.ts';
import { STATE_SENTENCES } from './state.ts';
import { TERM_SENTENCES } from './term.ts';
import { TRANSCRIPT_SENTENCES } from './transcript.ts';
import { UPLOADS_SENTENCES } from './uploads.ts';

// ---------------------------------------------------------------------------
// Definicje
// ---------------------------------------------------------------------------

/** Rodzaje argumentów zdania; znaczenie w komentarzu nagłówkowym. */
export const SENTENCE_ARG_KINDS = ['int', 'text', 'code', 'instant', 'plural'] as const;
export type SentenceArgKind = (typeof SENTENCE_ARG_KINDS)[number];

/** Deklaracja argumentu: `nazwa:rodzaj`, nazwa w camelCase (`max:int`, `label:text`). */
export type SentenceArgSpec = `${string}:${SentenceArgKind}`;

/** Najwięcej argumentów jednego zdania; ten sam limit ma `sentenceRefSchema` na drucie. */
export const MAX_SENTENCE_ARGS = 8;

/** Szablon z liczbą mnogą: wariant według argumentu rodzaju `plural`. */
export interface PluralTemplate {
  readonly one: string;
  readonly other: string;
}

/** Wpis rejestru: angielski szablon i argumenty w kolejności, w jakiej jadą w `ref.args`. */
export interface SentenceDefinition {
  readonly en: string | PluralTemplate;
  readonly args?: readonly SentenceArgSpec[];
}

/** Wpis wycofany: ta sama definicja plus wersja serwera, od której kod nie wychodzi. */
export interface RetiredSentenceDefinition extends SentenceDefinition {
  readonly since: string;
}

/** Mapa obszaru: kod → definicja. Plik obszaru deklaruje ją `as const satisfies SentenceArea`. */
export type SentenceArea = Readonly<Record<string, SentenceDefinition>>;
export type RetiredSentenceArea = Readonly<Record<string, RetiredSentenceDefinition>>;

// ---------------------------------------------------------------------------
// Rejestr
// ---------------------------------------------------------------------------

/** Obszary rejestru: nazwa obszaru = nazwa pliku = prefiks kodu (strażnik w teście rejestru). */
export const SENTENCE_AREAS = Object.freeze({
  commands: COMMANDS_SENTENCES,
  demo: DEMO_SENTENCES,
  dialogs: DIALOGS_SENTENCES,
  herdr: HERDR_SENTENCES,
  model: MODEL_SENTENCES,
  push: PUSH_SENTENCES,
  rest: REST_SENTENCES,
  restart: RESTART_SENTENCES,
  session: SESSION_SENTENCES,
  state: STATE_SENTENCES,
  term: TERM_SENTENCES,
  transcript: TRANSCRIPT_SENTENCES,
  uploads: UPLOADS_SENTENCES,
});

/** Wszystkie zdania, które serwer emituje (scalone obszary). */
export const SENTENCES = Object.freeze({
  ...COMMANDS_SENTENCES,
  ...DEMO_SENTENCES,
  ...DIALOGS_SENTENCES,
  ...HERDR_SENTENCES,
  ...MODEL_SENTENCES,
  ...PUSH_SENTENCES,
  ...REST_SENTENCES,
  ...RESTART_SENTENCES,
  ...SESSION_SENTENCES,
  ...STATE_SENTENCES,
  ...TERM_SENTENCES,
  ...TRANSCRIPT_SENTENCES,
  ...UPLOADS_SENTENCES,
} as const satisfies SentenceArea);

/**
 * Kody wycofane. Wpis przenosi się tu z pliku obszaru bez zmiany szablonu i argumentów, z `since`; nie znika nigdy.
 */
export const RETIRED = Object.freeze({} as const satisfies RetiredSentenceArea);

/** Kod zdania, które serwer może dziś powiedzieć (bez kodów wycofanych). */
export type SentenceCode = keyof typeof SENTENCES & string;

// ---------------------------------------------------------------------------
// Drut
// ---------------------------------------------------------------------------

/** Kod i argumenty zdania na drucie, obok gotowego angielskiego tekstu. */
export interface SentenceRef {
  code: string;
  args?: string[];
}

/** Kształt `ref` na drucie; uszkodzony `ref` (`null`, pusty kod, ponad 8 argumentów, nie-łańcuch) odrzuca ramkę. */
export const sentenceRefSchema = z.object({
  code: z.string().min(1),
  args: z.array(z.string()).max(MAX_SENTENCE_ARGS).optional(),
});

// ---------------------------------------------------------------------------
// Marki: zdanie własne i tekst obcy
// ---------------------------------------------------------------------------

const SENTENCE_BRAND: unique symbol = Symbol('rarog.server-sentence');
const FOREIGN_BRAND: unique symbol = Symbol('rarog.foreign-text');

/** Zdanie własne serwera z kodem; tworzy je wyłącznie `say()`. */
export interface ServerSentence {
  readonly text: string;
  readonly ref: SentenceRef;
  readonly [SENTENCE_BRAND]: true;
}

/** Tekst obcy (agent, użytkownik, herdr, Node, ekran); tworzy go `foreign`, nigdy nie ma kodu. */
export interface ForeignText {
  readonly text: string;
  readonly [FOREIGN_BRAND]: true;
}

/** Tekst własny serwera: zawsze zdanie z kodem. Nazwa zostaje w sygnaturach ujść, które nie przyjmują tekstu obcego. */
export type OwnText = ServerSentence;

/** Każda z dwóch form tekstu, które serwer przenosi do apki. */
export type AnyText = ServerSentence | ForeignText;

/**
 * Marka jako własność NIEPRZELICZALNA i zamrożenie: kopia przez rozproszenie (`{ ...zdanie, text: 'inne' }`) marki
 * nie niesie, a `JSON.stringify` jej nie widzi, więc na drut wychodzą tylko `text` i `ref`.
 */
function stamp<T extends object>(value: T, brand: symbol): T {
  Object.defineProperty(value, brand, { value: true, enumerable: false });
  return Object.freeze(value);
}

/** Tekst obcy z granicy, przez którą wchodzi do serwera. */
export function foreign(text: string): ForeignText {
  if (typeof text !== 'string') throw new TypeError('foreign: text must be a string');
  return stamp({ text }, FOREIGN_BRAND) as ForeignText;
}

const branded = (value: unknown, brand: symbol): boolean =>
  typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[brand] === true;

export const isServerSentence = (value: unknown): value is ServerSentence => branded(value, SENTENCE_BRAND);
export const isForeignText = (value: unknown): value is ForeignText => branded(value, FOREIGN_BRAND);
export const isAnyText = (value: unknown): value is AnyText => isServerSentence(value) || isForeignText(value);

/** Gotowy tekst z każdej formy (angielski render zdania z `say`, tekst obcy z `foreign` bez zmian). */
export function textOf(value: AnyText): string {
  if (!isAnyText(value)) throw new TypeError('textOf(): expected text from say or foreign');
  return value.text;
}

// ---------------------------------------------------------------------------
// say()
// ---------------------------------------------------------------------------

type ArgName<P> = P extends `${infer N}:${SentenceArgKind}` ? N : never;
type ArgKindOf<P> = P extends `${string}:${infer K extends SentenceArgKind}` ? K : never;
type HasArgs<D> = D extends { readonly args: readonly [unknown, ...unknown[]] } ? true : false;

/** Kody rejestru `S`, które nie mają własnych argumentów (tylko takie wolno podać jako argument `code`). */
export type ArglessCode<S extends SentenceArea> = {
  [C in keyof S & string]: HasArgs<S[C]> extends true ? never : C;
}[keyof S & string];

/** Wartość argumentu danego rodzaju, zanim `say()` zamieni ją na łańcuch. */
export type SentenceArgValue<K extends SentenceArgKind, Code extends string> =
  K extends 'int' | 'plural' ? number | bigint
    : K extends 'text' ? string | ForeignText
      : K extends 'instant' ? Date | string
        : Code;

/** Argumenty zdania `C` z rejestru `S` jako obiekt nazwa → wartość. */
export type SentenceArgs<S extends SentenceArea, C extends keyof S> =
  S[C] extends { readonly args: infer A extends readonly SentenceArgSpec[] }
    ? { readonly [P in A[number] as ArgName<P>]: SentenceArgValue<ArgKindOf<P>, ArglessCode<S>> }
    : Readonly<Record<string, never>>;

type SayRest<S extends SentenceArea, C extends keyof S> =
  HasArgs<S[C]> extends true ? [args: SentenceArgs<S, C>] : [args?: Readonly<Record<string, never>>];

/** `say()` nad rejestrem `S`: kod z rejestru i argumenty według jego deklaracji. */
export type Say<S extends SentenceArea> = <C extends keyof S & string>(code: C, ...rest: SayRest<S, C>) => ServerSentence;

const ARG_SPEC = /^([a-z][a-zA-Z0-9]*):([a-z]+)$/u;
const PLACEHOLDER = /\{([a-z][a-zA-Z0-9]*)\}/gu;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/u;

/**
 * Łańcuch ISO 8601 z istniejącą datą kalendarzową, godziną 00–23, minutą i sekundą 00–59 i takim przesunięciem.
 * Sam `Date.parse` przyjmuje 30 lutego i `24:00`, a apka takiej chwili nie odczyta.
 */
function isIsoInstant(value: string): boolean {
  const m = ISO_INSTANT.exec(value);
  if (m === null) return false;
  const n = (i: number): number => Number(m[i] ?? '0');
  const [year, month, day] = [n(1), n(2), n(3)];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && n(4) <= 23 && n(5) <= 59 && n(6) <= 59 && n(7) <= 23 && n(8) <= 59;
}
const EN_PLURAL = new Intl.PluralRules('en');

interface ParsedArg {
  readonly name: string;
  readonly kind: SentenceArgKind;
}

const fail = (code: string, why: string): never => {
  throw new Error(`say(${JSON.stringify(code)}): ${why}`);
};

/** Deklaracje argumentów w kolejności z rejestru i problemy deklaracji (limit, składnia, rodzaj, powtórzenie). */
function parseArgs(def: SentenceDefinition): { parsed: ParsedArg[]; problems: string[] } {
  const specs: readonly unknown[] = Array.isArray(def.args) ? def.args : [];
  const problems: string[] = [];
  if (specs.length > MAX_SENTENCE_ARGS) problems.push(`more than ${String(MAX_SENTENCE_ARGS)} arguments`);
  const parsed: ParsedArg[] = [];
  for (const spec of specs) {
    const m = typeof spec === 'string' ? ARG_SPEC.exec(spec) : null;
    const name = m?.[1];
    const kind = m?.[2];
    if (name === undefined || kind === undefined || !(SENTENCE_ARG_KINDS as readonly string[]).includes(kind)) {
      problems.push(`bad argument declaration ${JSON.stringify(spec)}`);
    } else if (parsed.some((arg) => arg.name === name)) problems.push(`duplicate argument ${name}`);
    else parsed.push({ name, kind: kind as SentenceArgKind });
  }
  return { parsed, problems };
}

/** Liczba całkowita z zakresu Int64 jako `bigint`, inaczej `undefined`. */
function int64(value: unknown): bigint | undefined {
  let n: bigint;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
  else return undefined;
  return n >= INT64_MIN && n <= INT64_MAX ? n : undefined;
}

/**
 * Fabryka `say()` nad podanym rejestrem. Produkcyjny {@link say} to fabryka na `SENTENCES` i `RETIRED`; testy
 * podają własny rejestr. Zwraca `{ text, ref }` z marką; `ref.args` to łańcuchy w kolejności deklaracji (bez
 * argumentów pole wypada). Rzuca przy kodzie nieznanym albo wycofanym, przy brakującym, nadmiarowym albo złym
 * argumencie i przy ponad {@link MAX_SENTENCE_ARGS} argumentach.
 */
export function createSay<const S extends SentenceArea>(sentences: S, retired: RetiredSentenceArea = {}): Say<S> {
  const definition = (code: string): SentenceDefinition | undefined =>
    Object.hasOwn(sentences, code) ? sentences[code] : undefined;

  const render = (code: string, args?: unknown): ServerSentence => {
    if (typeof code !== 'string') return fail(String(code), 'code must be a string');
    if (Object.hasOwn(retired, code)) fail(code, `code retired since ${retired[code]?.since ?? '?'}`);
    const def = definition(code) ?? fail(code, 'unknown code');
    const { parsed, problems } = parseArgs(def);
    if (problems[0] !== undefined) fail(code, problems[0]);
    const given = args ?? {};
    if (typeof given !== 'object' || given === null || Array.isArray(given)) fail(code, 'arguments must be an object');
    const values = given as Readonly<Record<string, unknown>>;
    for (const key of Object.keys(values)) {
      if (!parsed.some((arg) => arg.name === key)) fail(code, `unexpected argument ${key}`);
    }

    const wire: string[] = [];
    const shown = new Map<string, string>();
    let count: bigint | undefined;
    for (const { name, kind } of parsed) {
      if (!Object.hasOwn(values, name) || values[name] === undefined) fail(code, `missing argument ${name}`);
      const value = values[name];
      let onWire: string;
      let inText: string | undefined;
      switch (kind) {
        case 'int':
        case 'plural': {
          const n = int64(value) ?? fail(code, `argument ${name} must be an integer within Int64`);
          if (kind === 'plural') count = n;
          onWire = n.toString(10);
          break;
        }
        case 'text':
          if (typeof value === 'string') onWire = value;
          else if (isForeignText(value)) onWire = value.text;
          else return fail(code, `argument ${name} must be text`);
          break;
        case 'instant':
          if (value instanceof Date && !Number.isNaN(value.getTime())) onWire = value.toISOString();
          else if (typeof value === 'string' && isIsoInstant(value)) onWire = value;
          else return fail(code, `argument ${name} must be an ISO 8601 instant`);
          break;
        case 'code': {
          const sub = typeof value === 'string' && !Object.hasOwn(retired, value) ? definition(value) : undefined;
          if (sub === undefined || typeof sub.en !== 'string' || (sub.args ?? []).length > 0) {
            return fail(code, `argument ${name} must be a code without arguments`);
          }
          onWire = value as string;
          inText = sub.en;
          break;
        }
      }
      wire.push(onWire);
      shown.set(name, inText ?? onWire);
    }

    let template: string;
    if (typeof def.en === 'string') template = def.en;
    else {
      if (count === undefined) return fail(code, 'plural template without a plural argument');
      template = EN_PLURAL.select(Number(count)) === 'one' ? def.en.one : def.en.other;
    }
    const text = template.replace(PLACEHOLDER, (_match, name: string) =>
      shown.get(name) ?? fail(code, `template placeholder {${name}} is not declared`));
    const ref: SentenceRef = wire.length > 0 ? { code, args: Object.freeze(wire) as string[] } : { code };
    return stamp({ text, ref: Object.freeze(ref) }, SENTENCE_BRAND) as ServerSentence;
  };

  return render as Say<S>;
}

/** `say()` serwera: zdanie z rejestru jako gotowy angielski tekst i `ref` dla apki. */
export const say: Say<typeof SENTENCES> = createSay(SENTENCES, RETIRED);

/** Kod zdania serwera bez własnych argumentów: tylko taki wolno podać jako argument rodzaju `code`. */
export type ArglessSentenceCode = ArglessCode<typeof SENTENCES>;

/**
 * Kod zdania jako podkod argumentu `code`: zdanie z `say()` bez argumentów, z kodem emitowanym (`SENTENCES`)
 * i szablonem bez liczby mnogiej. Zdanie z argumentami albo spoza rejestru serwera daje `undefined`.
 */
export function arglessCodeOf(sentence: ServerSentence): ArglessSentenceCode | undefined {
  return arglessRefCode(sentence.ref);
}

function arglessRefCode({ code, args }: SentenceRef): ArglessSentenceCode | undefined {
  if ((args ?? []).length > 0 || !Object.hasOwn(SENTENCES, code)) return undefined;
  const def: SentenceDefinition = (SENTENCES as SentenceArea)[code] as SentenceDefinition;
  return typeof def.en === 'string' && (def.args ?? []).length === 0 ? (code as ArglessSentenceCode) : undefined;
}

/**
 * Zdanie Raroga odtworzone z samego `ref` bez argumentów (pytanie zapasowe w `questionRef`); `ref` z argumentami
 * albo spoza rejestru serwera daje `undefined`.
 */
export function sentenceOfArglessRef(ref: SentenceRef): ServerSentence | undefined {
  const code = arglessRefCode(ref);
  return code === undefined ? undefined : say(code);
}

// ---------------------------------------------------------------------------
// Spójność rejestru (strażnik w teście i `scripts/sentences-catalog.mjs --check`)
// ---------------------------------------------------------------------------

/** Kod: `<obszar>.<nazwa>`, każdy człon w kebab-case, dalsze człony po kropce (`push.title.permission`). */
export const SENTENCE_CODE = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/u;

/** Wersja serwera w `since` wpisu wycofanego. */
export const RETIRED_SINCE = /^\d+\.\d+\.\d+$/u;

const placeholders = (template: string): string[] => [...template.matchAll(PLACEHOLDER)].map((m) => m[1] ?? '');

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  new Set(a).size === new Set(b).size && a.every((x) => b.includes(x));

/** Problemy jednej definicji (pusta lista = definicja poprawna). */
function definitionProblems(code: string, def: SentenceDefinition): string[] {
  const problems: string[] = [];
  const at = (why: string): void => { problems.push(`${code}: ${why}`); };
  if (!SENTENCE_CODE.test(code)) at('code does not match <area>.<name> in kebab-case');
  const { parsed, problems: argProblems } = parseArgs(def);
  for (const problem of argProblems) at(problem);
  if (def.args !== undefined && def.args.length === 0) at('empty args list (omit the field)');
  const names = parsed.map((arg) => arg.name);
  const plurals = parsed.filter((arg) => arg.kind === 'plural');
  if (plurals.length > 1) at('more than one plural argument');
  const variants: Array<[string, unknown]> = typeof def.en === 'string' || typeof def.en !== 'object' || def.en === null
    ? [['en', def.en]]
    : [['one', def.en.one], ['other', def.en.other]];
  if (typeof def.en === 'object' && def.en !== null) {
    if (plurals.length !== 1) at('plural template needs exactly one plural argument');
    if (!sameSet(Object.keys(def.en), ['one', 'other'])) at('plural template has keys other than one and other');
  } else if (plurals.length > 0) at('plural argument needs a { one, other } template');
  for (const [variant, template] of variants) {
    if (typeof template !== 'string' || template.trim() === '') {
      at(`${variant}: template must be a non-empty string`);
      continue;
    }
    if (/[{}]/u.test(template.replace(PLACEHOLDER, ''))) at(`${variant}: stray brace outside a {placeholder}`);
    const used = placeholders(template);
    const unknown = used.filter((name) => !names.includes(name));
    if (unknown.length > 0) at(`${variant}: undeclared placeholders ${unknown.join(', ')}`);
    // Każdy wariant może pominąć argument `plural`: „One image” albo sam wybór formy („której”/„których”).
    // Każdy inny argument musi stać w każdym wariancie.
    const required = names.filter((name) => !plurals.some((p) => p.name === name));
    const unused = required.filter((name) => !used.includes(name));
    if (unused.length > 0) at(`${variant}: arguments missing from the template ${unused.join(', ')}`);
  }
  return problems;
}

/** Problemy całego rejestru: definicje, `since` wpisów wycofanych, kod jednocześnie emitowany i wycofany. */
export function registryProblems(sentences: SentenceArea, retired: RetiredSentenceArea): string[] {
  const problems: string[] = [];
  for (const [code, def] of Object.entries(sentences)) problems.push(...definitionProblems(code, def));
  for (const [code, def] of Object.entries(retired)) {
    problems.push(...definitionProblems(code, def));
    if (typeof def.since !== 'string' || !RETIRED_SINCE.test(def.since)) {
      problems.push(`${code}: since must be a server version (x.y.z)`);
    }
    if (Object.hasOwn(sentences, code)) problems.push(`${code}: both in SENTENCES and in RETIRED`);
  }
  return problems;
}
