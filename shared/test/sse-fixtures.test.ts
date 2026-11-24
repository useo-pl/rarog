/**
 * Złote ramki SSE, strona KLIENTA: pliki `shared/fixtures/sse/` → dekoder.
 *
 * Każdy plik to DOKŁADNIE pole `data:` jednej ramki po `JSON.parse`, a `manifest.json` mówi,
 * czego klient ma się po nim spodziewać:
 * - `ok` — ramka zgodna z kontraktem: wynik równa się wejściu (po zdjęciu ścieżek `strip`,
 *   czyli kluczy z przyszłości), `degradations` puste;
 * - `degraded` — ramka z nieznaną wartością enuma: wynik równa się wejściu po nałożeniu
 *   `result` (wartość zapasowa albo `remove`), `degradations` wskazuje dokładnie pola z `patch`;
 * - `ignored` — klient ramkę odrzuca (`null`).
 * Wpis z `base` jest POCHODNĄ: plik = `base` + `patch` (strażnik dryfu niżej).
 *
 * Ten plik celowo NIE importuje niczego z `server/` — to lustro testu, który każdy inny klient
 * (kiedyś Swift) ma przejść na tych samych plikach. Producentów pilnuje
 * `server/test/sse-fixtures-producenci.test.ts`; świeże pliki daje `RAROG_FIXTURES_WRITE=1`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { serverEventSchema } from '../src/protocol.ts';
import { DEGRADATIONS, decodeServerEvent } from '../src/decode.ts';
import type { Degradation } from '../src/decode.ts';
import { RETIRED, SENTENCES, say } from '../src/sentences/index.ts';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/sse');
const MANIFEST = 'manifest.json';

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/** Jedna operacja na dokumencie: `value` ustawia (dodaje albo podmienia), `remove` usuwa. */
const opSchema = z.strictObject({
  /** JSON Pointer (RFC 6901), np. `/sessions/0/state`. */
  path: z.string().startsWith('/'),
  value: z.unknown().optional(),
  remove: z.literal(true).optional(),
}).refine((op) => ('value' in op) !== (op.remove === true), 'operacja: albo `value`, albo `remove`');

type Op = z.infer<typeof opSchema>;

const entrySchema = z.strictObject({
  expect: z.enum(['ok', 'degraded', 'ignored']),
  /** Plik bazowy pochodnej — sam nie może być pochodną. */
  base: z.string().optional(),
  patch: z.array(opSchema).optional(),
  /** `ok`: ścieżki kluczy, których dekoder nie zna i ma odciąć (forward-compat). */
  strip: z.array(z.string().startsWith('/')).optional(),
  /** `degraded`: to, co dekoder robi z polami z `patch`. */
  result: z.array(opSchema).optional(),
  /** `degraded`: które pozycje `DEGRADATIONS` z `shared/src/decode.ts` ta ramka ćwiczy. */
  degrades: z.array(z.string()).min(1).optional(),
  /** `ignored`: plik niesie SUROWY tekst pola `data:` jako łańcuch JSON (np. uszkodzony JSON). */
  raw: z.literal(true).optional(),
});

type Entry = z.infer<typeof entrySchema>;

const manifest: Record<string, Entry> = z.record(z.string(), entrySchema)
  .parse(JSON.parse(readFileSync(path.join(DIR, MANIFEST), 'utf8')));

const read = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(DIR, name), 'utf8')) as unknown;

// ---------------------------------------------------------------------------
// JSON Pointer
// ---------------------------------------------------------------------------

function pointer(raw: string): string[] {
  return raw.slice(1).split('/').map((key) => key.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Nakłada operacje na KOPIĘ dokumentu; ścieżka bez rodzica to błąd manifestu. */
function applyOps(doc: unknown, ops: readonly Op[]): unknown {
  const out = structuredClone(doc);
  for (const op of ops) {
    const keys = pointer(op.path);
    const last = keys.pop() ?? '';
    let parent: unknown = out;
    for (const key of keys) {
      parent = (parent as Record<string, unknown>)[key];
      if (typeof parent !== 'object' || parent === null) {
        throw new Error(`ścieżka ${op.path}: brak rodzica ${key}`);
      }
    }
    const target = parent as Record<string, unknown>;
    if (op.remove === true) {
      if (Array.isArray(target)) target.splice(Number(last), 1);
      else delete target[last];
    } else {
      target[last] = structuredClone(op.value);
    }
  }
  return out;
}

const byPath = (a: Degradation, b: Degradation): number =>
  a.path.localeCompare(b.path) || a.value.localeCompare(b.value);

// ---------------------------------------------------------------------------
// Ścieżki pól: schemat i plik
// ---------------------------------------------------------------------------

interface JsonSchemaNode {
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  oneOf?: JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  [keyword: string]: unknown;
}

/** Słowa kluczowe, których zbieracz NIE rozumie — ich pojawienie się ma przewrócić test. */
const UNSUPPORTED_KEYWORDS = ['$ref', 'allOf', 'prefixItems', 'additionalItems', 'patternProperties'];

/**
 * Wyróżnik gałęzi unii: jej WYMAGANE właściwości ze stałą (`type: const 'image'`). Opcjonalny
 * literał (`detailKind: const 'diff'`) wyróżnikiem nie jest — blok bez niego to ten sam wariant.
 * `null` = gałąź bez wyróżnika (np. `anyOf` z `nullable`).
 */
function discriminator(branch: JsonSchemaNode): [string, unknown][] | null {
  const required = new Set(Array.isArray(branch.required) ? (branch.required as string[]) : []);
  const fields = Object.entries(branch.properties ?? {})
    .filter(([key, child]) => required.has(key) && 'const' in child)
    .map(([key, child]): [string, unknown] => [key, child.const]);
  return fields.length > 0 ? fields : null;
}

/** Gałęzie unii z etykietą wariantu (`[type=image]`) albo `null`, gdy unię wolno scalić. */
function variants(node: JsonSchemaNode): { label: string; branch: JsonSchemaNode;
  fields: [string, unknown][] }[] | null {
  const branches = node.oneOf ?? [];
  const keyed = branches.map((branch) => ({ branch, fields: discriminator(branch) }));
  if (keyed.length === 0 || keyed.some(({ fields }) => fields === null)) return null;
  return keyed.map(({ branch, fields }) => ({
    branch,
    fields: fields ?? [],
    label: `[${(fields ?? []).map(([key, value]) => `${key}=${String(value)}`).join(',')}]`,
  }));
}

function assertUnderstood(node: JsonSchemaNode, prefix: string): void {
  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (keyword in node) throw new Error(`${prefix}: JSON Schema z „${keyword}” — dopisz obsługę`);
  }
}

/**
 * Ścieżki pól z JSON Schema zoda: każda właściwość obiektu, tablice jako `*`. Gałąź `oneOf`
 * z wyróżnikiem dostaje WŁASNĄ ścieżkę z etykietą wariantu (`/message/blocks/*[type=image]/alt`):
 * pole bloku `image` nie może być „pokryte" przez blok `text`, który ma pole o tej samej nazwie.
 * Unie bez wyróżnika (`anyOf` z `nullable`) scalamy pod jedną ścieżką. Zod 4.4.3 wkleja schematy
 * w miejscu (bez `$ref`), więc nie ma czego rozwiązywać.
 */
function schemaPaths(node: JsonSchemaNode, prefix: string, acc: Set<string>): void {
  assertUnderstood(node, prefix);
  const keyed = variants(node);
  if (keyed !== null) {
    for (const { label, branch } of keyed) schemaPaths(branch, `${prefix}${label}`, acc);
  } else {
    for (const branch of [...(node.oneOf ?? []), ...(node.anyOf ?? [])]) {
      schemaPaths(branch, prefix, acc);
    }
  }
  if (node.items !== undefined) schemaPaths(node.items, `${prefix}/*`, acc);
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    acc.add(`${prefix}/${key}`);
    schemaPaths(child, `${prefix}/${key}`, acc);
  }
}

/**
 * Ścieżki pól obecnych w ramce — tą samą notacją, idąc RAZEM ze schematem: przy unii
 * z wyróżnikiem wartość trafia wyłącznie do gałęzi, której stałe się zgadzają. Klucze spoza
 * schematu (forward-compat, `strip`) niczego nie pokrywają.
 */
function valuePaths(node: JsonSchemaNode, value: unknown, prefix: string, acc: Set<string>): void {
  assertUnderstood(node, prefix);
  const keyed = variants(node);
  if (keyed !== null) {
    const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
    const hit = keyed.find(({ fields }) => fields.every(([key, want]) => record[key] === want));
    if (hit !== undefined) valuePaths(hit.branch, value, `${prefix}${hit.label}`, acc);
  } else {
    for (const branch of [...(node.oneOf ?? []), ...(node.anyOf ?? [])]) {
      valuePaths(branch, value, prefix, acc);
    }
  }
  if (node.items !== undefined && Array.isArray(value)) {
    for (const item of value) valuePaths(node.items, item, `${prefix}/*`, acc);
  }
  if (node.properties === undefined || typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    const field = node.properties[key];
    if (field === undefined) continue;
    acc.add(`${prefix}/${key}`);
    valuePaths(field, child, `${prefix}/${key}`, acc);
  }
}

/** Ścieżki schematu, których nie niesie żadna z podanych ramek (posortowane). */
function uncovered(schema: JsonSchemaNode, frames: readonly unknown[]): string[] {
  const required = new Set<string>();
  schemaPaths(schema, '', required);
  const present = new Set<string>();
  for (const frame of frames) valuePaths(schema, frame, '', present);
  return [...required].filter((field) => !present.has(field)).sort();
}

// ---------------------------------------------------------------------------
// Etykiety degradacji
// ---------------------------------------------------------------------------

/** Podsumowanie sesji: w liście (`sessions-snapshot`) albo pojedynczo (`session-changed`). */
const SUMMARY = String.raw`(?:/sessions/\d+|/session)`;
/** Wiadomość transkryptu: w `transcript-snapshot` albo w ramce `message`. */
const MESSAGE = String.raw`(?:/messages/\d+|/message)`;
const at = (pattern: string): RegExp => new RegExp(`^${pattern}$`);

/**
 * Gdzie w ramce stoi pole każdej pozycji `DEGRADATIONS` — PEŁNA ścieżka JSON Pointer, indeksy
 * jako `\d+`. Ostatni człon nie wystarcza: `context.kind`, `activity.kind`, `waitingFor.kind`,
 * `backgroundTasks.kind` i `fileDetails.kind` kończą się tym samym `kind`.
 */
const DEGRADATION_PATHS: Record<keyof typeof DEGRADATIONS, RegExp> = {
  state: at(`(?:${SUMMARY})?/state`),
  effort: at(`${SUMMARY}/effort`),
  herdrMode: at(`${SUMMARY}/herdrMode`),
  herdrDialog: at(`${SUMMARY}/herdrDialog`),
  herdrDialogReason: at(`${SUMMARY}/herdrDialogReason`),
  cliDialog: at(`${SUMMARY}/cliDialog`),
  engine: at(`${SUMMARY}/engine`),
  'context.kind': at(`${SUMMARY}/context/kind`),
  'context.source': at(`${SUMMARY}/context/source`),
  'activity.kind': at(`(?:${SUMMARY})?/activity/kind`),
  'waitingFor.kind': at(`${SUMMARY}/waitingFor/kind`),
  'backgroundTasks.kind': at(String.raw`${SUMMARY}/backgroundTasks/\d+/kind`),
  'message.role': at(`${MESSAGE}/role`),
  'block.type': at(String.raw`${MESSAGE}/blocks/\d+/type`),
  'block.detailKind': at(String.raw`${MESSAGE}/blocks/\d+/detailKind`),
  'attachments.kind': at(String.raw`${MESSAGE}/attachments/\d+/kind`),
  risk: at(String.raw`(?:/request|/pendingPermissions/\d+)/risk`),
  channel: at(String.raw`(?:/request|/pendingQuestions/\d+)/channel`),
  'permission-resolved.decision': at('/decision'),
  subject: at(String.raw`(?:/request|/pendingPermissions/\d+)/subject`),
  'permission.inputKind': at(String.raw`(?:/request|/pendingPermissions/\d+)/inputKind`),
  // Karta kanału zgód i zdarzenie `permission-settled` (pole na wierzchu ramki).
  'permission.state': at(String.raw`(?:/request|/pendingPermissions/\d+)?/state`),
  'permission.unavailable': at(String.raw`(?:/request|/pendingPermissions/\d+)?/unavailable`),
  'permission.notes': at(String.raw`(?:/request|/pendingPermissions/\d+)/notes/\d+`),
  'waitingFor.subject': at(`${SUMMARY}/waitingFor/subject`),
  // W podsumowaniu, w `transcript-snapshot` i w ulotnej ramce `activity` (pole na wierzchu).
  'activity.delegation': at(`(?:(?:${SUMMARY})?/activity)?/delegation`),
  'block.delegation': at(String.raw`${MESSAGE}/blocks/\d+/delegation`),
  'block.inputKind': at(String.raw`${MESSAGE}/blocks/\d+/inputKind`),
  'option.role': at(String.raw`(?:/request|/pendingQuestions/\d+)/questions/\d+/options/\d+/role`),
  'notice.kind': at(`${MESSAGE}/notice/kind`),
  'notice.outcome': at(`${MESSAGE}/notice/outcome`),
  'fileDetails.kind': at(String.raw`/fileDetails/\d+/kind`),
  'pullRequests.state': at(String.raw`${SUMMARY}/pullRequests/\d+/state`),
  seenBy: at(`${SUMMARY}/seenBy`),
  // Only the list frame: a single `inbox-head` with an unknown value is ignored whole.
  'inbox.head': at(String.raw`/heads/\d+/(?:kind|state|dialog)`),
  'folder-access.block': at(String.raw`/blocked/\d+/state`),
};

const isDegradation = (key: string): key is keyof typeof DEGRADATIONS =>
  Object.prototype.hasOwnProperty.call(DEGRADATION_PATHS, key);

/**
 * Niezgodności etykiet wpisu z jego `patch`: etykieta spoza `DEGRADATIONS`, pole z `patch`,
 * którego nie opisuje żadna etykieta, albo etykieta bez pasującego pola. Pusta lista = zgodne.
 */
function labelProblems(entry: Pick<Entry, 'degrades' | 'patch'>): string[] {
  const problems: string[] = [];
  const labels = entry.degrades ?? [];
  const paths = (entry.patch ?? []).map((op) => op.path);
  for (const label of labels) {
    if (!isDegradation(label)) {
      problems.push(`etykieta ${label} spoza DEGRADATIONS`);
      continue;
    }
    if (!paths.some((field) => DEGRADATION_PATHS[label].test(field))) {
      problems.push(`etykieta ${label} bez pasującego pola w patch`);
    }
  }
  for (const field of paths) {
    const owned = labels.some((label) => isDegradation(label) && DEGRADATION_PATHS[label].test(field));
    if (!owned) problems.push(`pole ${field} nie pasuje do żadnej etykiety`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Testy
// ---------------------------------------------------------------------------

const entries = Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b));
const typeOf = (frame: unknown): string => String((frame as { type?: unknown }).type);
const EVENT_TYPES = serverEventSchema.options.map((option) => option.shape.type.value);

const POLISH_LETTER = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/u;

/** Pola tekstu z parą zdania z kodem (`…Ref` przy `…`, `ref` przy `text`), które niosą polską literę. */
function polishBesideRef(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => polishBesideRef(item, `${prefix}/${String(i)}`));
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  const own = Object.keys(record).filter((key) => key === 'ref' || key.endsWith('Ref'))
    .map((key) => (key === 'ref' ? 'text' : key.slice(0, -3)))
    .filter((key) => typeof record[key] === 'string' && POLISH_LETTER.test(record[key] as string))
    .map((key) => `${prefix}/${key}`);
  return [...own, ...Object.entries(record).flatMap(([key, child]) => polishBesideRef(child, `${prefix}/${key}`))];
}

/** Ścieżka `args` pola zdania z kodem (`…Ref/args`, `…/ref/args`) — patrz test pokrycia pól. */
const REF_ARGS = /(?:Ref|\/ref)\/args$/u;

/** Czy ramka niesie gdzieś zdanie z kodem (`ref` albo `…Ref`) z niepustą listą `args`. */
function hasRefWithArgs(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasRefWithArgs);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, inner]) => (
    (/^ref$|Ref$/u.test(key) && Array.isArray((inner as { args?: unknown } | null)?.args)
      && ((inner as { args: unknown[] }).args.length > 0)) || hasRefWithArgs(inner)
  ));
}

// ---------------------------------------------------------------------------
// Strażnik „pole z tekstem ma `ref`”
// ---------------------------------------------------------------------------

/**
 * Wzorzec całego tekstu z szablonu `en`: `{arg}` → dowolny ciąg, także pusty (`say()` przyjmuje pusty tekst),
 * reszta dosłownie.
 */
function templatePattern(template: string): RegExp {
  const literal = template.split(/\{[a-z][a-zA-Z0-9]*\}/u).map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  return new RegExp(`^${literal.join('[\\s\\S]*')}$`, 'u');
}

/**
 * Szablony `en` rejestru (`SENTENCES` i `RETIRED`, warianty liczby mnogiej osobno) jako wzorce. Szablon bez
 * WŁASNEGO słowa, czyli same argumenty i znaki (`{detail}`, `{detail} — {label}`, `⚠ {reason}`), pasuje do
 * dowolnej treści obcej z takim znakiem, więc stoi osobno w `skipped`.
 */
function registryPatterns(): { patterns: { code: string; pattern: RegExp }[]; skipped: string[] } {
  const patterns: { code: string; pattern: RegExp }[] = [];
  const skipped: string[] = [];
  for (const [code, def] of Object.entries({ ...SENTENCES, ...RETIRED })) {
    const templates = typeof def.en === 'string' ? [def.en] : [def.en.one, def.en.other];
    for (const template of templates) {
      if (!/\p{L}/u.test(template.replace(/\{[a-z][a-zA-Z0-9]*\}/gu, ''))) skipped.push(code);
      else patterns.push({ code, pattern: templatePattern(template) });
    }
  }
  return { patterns, skipped: [...new Set(skipped)].sort() };
}

const REGISTRY = registryPatterns();

/** Kod rejestru, do którego szablonu pasuje tekst, albo `undefined`. */
const registryCodeOf = (text: string): string | undefined =>
  REGISTRY.patterns.find(({ pattern }) => pattern.test(text))?.code;

/**
 * Rodzaj każdego pola tekstu z parą `ref` w schemacie ramki (ścieżka z etykietą wariantu). `own` = zdanie własne
 * serwera, które bez `ref` jest błędem; reszta to treść obca, która `ref` mieć nie musi. `block`: rodzaj zależy od
 * roli wiadomości ({@link FOREIGN_ROLES}). Test niżej trzyma tę mapę równą zbiorowi pól ze schematu.
 */
const TEXT_FIELD_KINDS: Readonly<Record<string, 'own' | 'block' | 'session-label' | 'question' | 'display-text'>> = {
  '[type=herdr-status]/detail': 'own',
  '[type=message]/message/blocks/*[type=text]/text': 'block',
  '[type=permission-pending]/request/displayText': 'display-text',
  '[type=question-pending]/request/questions/*/question': 'question',
  '[type=session-changed]/session/label': 'session-label',
  '[type=session-changed]/session/stateDetail': 'own',
  '[type=sessions-snapshot]/herdrStatus/detail': 'own',
  '[type=sessions-snapshot]/sessions/*/label': 'session-label',
  '[type=sessions-snapshot]/sessions/*/stateDetail': 'own',
  '[type=state]/detail': 'own',
  '[type=transcript-snapshot]/messages/*/blocks/*[type=text]/text': 'block',
  '[type=transcript-snapshot]/pendingPermissions/*/displayText': 'display-text',
  '[type=transcript-snapshot]/pendingQuestions/*/questions/*/question': 'question',
};

/** Role wiadomości, których blok `text` niesie treść obcą (agent, użytkownik, wynik narzędzia). Bez `system`. */
const FOREIGN_ROLES = new Set(['assistant', 'user', 'tool']);

/** Kod znacznika przycięcia wiadomości (`clampMessageBlocks` w serwerze). */
const TRIMMED_MARK = 'transcript.trimmed-mark';

const isRefKey = (key: string): boolean => key === 'ref' || key.endsWith('Ref');
const textKeyOf = (refKey: string): string => (refKey === 'ref' ? 'text' : refKey.slice(0, -3));

interface TextField { schemaPath: string; pointer: string; text: string; hasRef: boolean }

/** Pola tekstu z parą `ref` w schemacie, które ramka niesie (idąc razem ze schematem, jak {@link valuePaths}). */
function textFields(node: JsonSchemaNode, value: unknown, schemaPath: string, at: string,
  out: Map<string, TextField>): void {
  const keyed = variants(node);
  if (keyed !== null) {
    const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
    const hit = keyed.find(({ fields }) => fields.every(([key, want]) => record[key] === want));
    if (hit !== undefined) textFields(hit.branch, value, `${schemaPath}${hit.label}`, at, out);
  } else {
    for (const branch of [...(node.oneOf ?? []), ...(node.anyOf ?? [])]) textFields(branch, value, schemaPath, at, out);
  }
  if (node.items !== undefined && Array.isArray(value)) {
    value.forEach((item, i) => textFields(node.items as JsonSchemaNode, item, `${schemaPath}/*`, `${at}/${String(i)}`, out));
  }
  if (node.properties === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const refKey of Object.keys(node.properties).filter(isRefKey)) {
    const key = textKeyOf(refKey);
    const text = record[key];
    if (typeof text !== 'string') continue;
    out.set(`${at}/${key}`, { schemaPath: `${schemaPath}/${key}`, pointer: `${at}/${key}`, text,
      hasRef: record[refKey] !== undefined });
  }
  for (const [key, child] of Object.entries(record)) {
    const field = node.properties[key];
    if (field !== undefined) textFields(field, child, `${schemaPath}/${key}`, `${at}/${key}`, out);
  }
}

/** Wartość pod wskaźnikiem JSON (bez `~`-ucieczek: klucze ramek ich nie mają). */
function valueAt(doc: unknown, at: string): unknown {
  return at.split('/').slice(1).reduce<unknown>((node, key) =>
    (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[key] : undefined), doc);
}

/**
 * Blok `text` przycięty budżetem wiadomości: bez `ref`, a ZARAZ po nim, jako ostatni blok, znacznik przycięcia
 * z kodem. Tylko ten jeden blok traci `ref`, bo jego tekst nie jest już całym zdaniem.
 */
function isClampedBlock(doc: unknown, at: string): boolean {
  const match = /^(.*\/blocks)\/(\d+)\/text$/u.exec(at);
  if (match === null) return false;
  const blocks = valueAt(doc, match[1] ?? '');
  const index = Number(match[2]);
  if (!Array.isArray(blocks) || index !== blocks.length - 2) return false;
  const mark = blocks[index + 1] as { type?: unknown; ref?: { code?: unknown } } | undefined;
  return mark?.type === 'text' && mark.ref?.code === TRIMMED_MARK;
}

/** Rola wiadomości, do której należy blok pod wskaźnikiem `…/blocks/<n>/text`. */
function roleOf(doc: unknown, at: string): unknown {
  const message = at.replace(/\/blocks\/\d+\/text$/u, '');
  return (valueAt(doc, message) as { role?: unknown } | undefined)?.role;
}

const EVENT_JSON_SCHEMA = z.toJSONSchema(serverEventSchema) as JsonSchemaNode;

/**
 * Pola tekstu bez `ref` w ramce, które powinny go mieć (pusta lista = zgodne), jako `wskaźnik: powód`:
 * 1. tekst pasuje do szablonu kodu rejestru — czerwony w KAŻDYM polu, także w polu treści obcej;
 * 2. pole spoza listy treści obcej (zdanie własne, blok roli `system`) — czerwony;
 * wyjątek: blok przycięty budżetem ze znacznikiem przycięcia ({@link isClampedBlock}).
 */
function refProblems(doc: unknown): string[] {
  const fields = new Map<string, TextField>();
  textFields(EVENT_JSON_SCHEMA, doc, '', '', fields);
  const problems: string[] = [];
  for (const field of fields.values()) {
    if (field.hasRef || isClampedBlock(doc, field.pointer)) continue;
    const code = registryCodeOf(field.text);
    const kind = TEXT_FIELD_KINDS[field.schemaPath];
    if (code !== undefined) {
      problems.push(`${field.pointer}: zdanie rejestru ${code} bez ref`);
    } else if (kind === undefined) {
      problems.push(`${field.pointer}: pole ${field.schemaPath} bez rodzaju w TEXT_FIELD_KINDS`);
    } else if (kind === 'block' ? !FOREIGN_ROLES.has(String(roleOf(doc, field.pointer))) : kind === 'own') {
      problems.push(`${field.pointer}: tekst bez ref poza treścią obcą (${kind})`);
    }
  }
  return problems;
}

/** Ramki pod strażnikiem `ref`: bez plików demo (`*.demo.json`) i bez przypadków `ignored` (także `raw`). */
const underRefGuard = (name: string, entry: Entry): boolean =>
  !name.endsWith('.demo.json') && entry.expect !== 'ignored' && entry.raw !== true;

describe('złote ramki SSE: manifest i pliki', () => {
  it('manifest ↔ katalog w obie strony (każdy plik ma oczekiwanie, każde oczekiwanie plik)', () => {
    const files = readdirSync(DIR).filter((name) => name !== MANIFEST).sort();
    expect(files).toEqual(entries.map(([name]) => name));
  });

  it('nazwa pliku `ok`/`degraded` zaczyna się od `type` ramki (`<type>.<przypadek>.json`)', () => {
    for (const [name, entry] of entries) {
      expect(name, 'nazwa pliku').toMatch(/^[a-z0-9-]+\.[a-z0-9-]+\.json$/);
      if (entry.expect === 'ignored') continue;
      expect(name.split('.')[0], name).toBe(typeOf(read(name)));
    }
  });

  it('pola wpisu pasują do oczekiwania (`strip` tylko przy ok, `result`/`degrades` przy degraded)', () => {
    for (const [name, entry] of entries) {
      if (entry.strip !== undefined) expect(entry.expect, `${name}: strip`).toBe('ok');
      if (entry.raw !== undefined) expect(entry.expect, `${name}: raw`).toBe('ignored');
      const degraded = entry.expect === 'degraded';
      expect(entry.result !== undefined, `${name}: result`).toBe(degraded);
      expect(entry.degrades !== undefined, `${name}: degrades`).toBe(degraded);
      if (degraded) expect(entry.base, `${name}: degraded to zawsze pochodna`).toBeDefined();
      if (entry.base !== undefined) {
        expect(manifest[entry.base], `${name}: nieznana baza ${entry.base}`).toBeDefined();
        expect(manifest[entry.base]?.base, `${name}: baza nie może być pochodną`).toBeUndefined();
        expect(entry.patch?.length ?? 0, `${name}: pochodna bez patch`).toBeGreaterThan(0);
      }
    }
  });

  it('każdy typ zdarzenia z kontraktu ma ramkę `<type>.max.json` oczekiwaną jako ok', () => {
    expect(EVENT_TYPES).toHaveLength(21);
    for (const type of EVENT_TYPES) {
      expect(manifest[`${type}.max.json`]?.expect, `brak ${type}.max.json`).toBe('ok');
    }
  });

  it('mapa ścieżek degradacji ma dokładnie klucze DEGRADATIONS', () => {
    expect(Object.keys(DEGRADATION_PATHS).sort()).toEqual(Object.keys(DEGRADATIONS).sort());
  });

  it('etykieta `degrades` opisuje PEŁNĄ ścieżkę pola z `patch` (wzorzec w DEGRADATION_PATHS)', () => {
    for (const [name, entry] of entries) {
      if (entry.degrades === undefined) continue;
      expect(labelProblems(entry), name).toEqual([]);
    }
  });

  it('każda pozycja DEGRADATIONS ma ramkę degraded z polem, które do niej pasuje', () => {
    const covered = new Set<string>();
    for (const [, entry] of entries) {
      for (const label of entry.degrades ?? []) {
        if (!isDegradation(label)) continue;
        const pattern = DEGRADATION_PATHS[label];
        if ((entry.patch ?? []).some((op) => pattern.test(op.path))) covered.add(label);
      }
    }
    expect([...covered].sort()).toEqual(Object.keys(DEGRADATIONS).sort());
  });

  it('tekst obok zdania z kodem nie jest po polsku w żadnej ramce (zdanie serwera jest angielskie)', () => {
    for (const [name] of entries) {
      if (manifest[name]?.raw === true) continue;
      expect(polishBesideRef(read(name)), name).toEqual([]);
    }
  });

  it('pokrycie pól: każda ścieżka schematu ramki występuje w jakiejś ramce ok tego typu', () => {
    const schema = z.toJSONSchema(serverEventSchema) as JsonSchemaNode;
    const branches = schema.oneOf ?? [];
    expect(branches).toHaveLength(EVENT_TYPES.length);
    const missing: string[] = [];
    // Zdanie z kodem ma jeden schemat (`sentenceRefSchema`), więc `args` pokrywa ramka ok z argumentami w dowolnym
    // typie: kod bez argumentów (`herdr.pane-cap`) nie dostaje ich tylko po to, żeby ścieżka była pokryta.
    const refArgsSeen = entries
      .filter(([, entry]) => entry.expect === 'ok')
      .some(([name]) => hasRefWithArgs(read(name)));
    expect(refArgsSeen, 'żadna ramka ok nie niesie zdania z argumentami').toBe(true);
    for (const branch of branches) {
      const type = String((branch.properties?.type as { const?: unknown } | undefined)?.const);
      const frames = entries
        .filter(([, entry]) => entry.expect === 'ok')
        .map(([name]) => read(name))
        .filter((frame) => typeOf(frame) === type);
      for (const field of uncovered(branch, frames)) {
        if (REF_ARGS.test(field) && refArgsSeen) continue;
        missing.push(`${type}: ${field}`);
      }
    }
    // Nowe pole w kontrakcie = nowa złota ramka (RAROG_FIXTURES_WRITE=1 po zmianie producenta).
    expect(missing).toEqual([]);
  });
});

describe('strażniki złotych ramek na danych syntetycznych', () => {
  const blocks = z.toJSONSchema(z.object({
    since: z.string().nullable(),
    blocks: z.array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({ type: z.literal('image'), dataUrl: z.string(), text: z.string().optional() }),
    ])),
  })) as JsonSchemaNode;

  it('pole jednego wariantu unii NIE jest pokryte wartością z innego wariantu', () => {
    const frame = { since: null, blocks: [{ type: 'text', text: 'a' }, { type: 'image', dataUrl: 'x' }] };
    expect(uncovered(blocks, [frame])).toEqual(['/blocks/*[type=image]/text']);
  });

  it('ten sam wariant z polem pokrywa ścieżkę; `nullable` scala gałęzie pod jedną ścieżką', () => {
    const frame = {
      since: '2026-10-03T08:00:00.000Z',
      blocks: [{ type: 'text', text: 'a' }, { type: 'image', dataUrl: 'x', text: 'podpis' }],
    };
    expect(uncovered(blocks, [frame])).toEqual([]);
  });

  it('klucz spoza schematu (forward-compat) niczego nie pokrywa', () => {
    const frame = { since: null, blocks: [{ type: 'image', dataUrl: 'x', przyszlePole: 1 }] };
    expect(uncovered(blocks, [frame])).toEqual(['/blocks/*[type=text]/text', '/blocks/*[type=text]/type',
      '/blocks/*[type=image]/text'].sort());
  });

  it('etykieta `context.kind` przy polu `activity/kind` jest odrzucona (ten sam ostatni człon)', () => {
    expect(labelProblems({
      degrades: ['context.kind'], patch: [{ path: '/sessions/7/activity/kind', value: 'zzz' }],
    })).toEqual([
      'etykieta context.kind bez pasującego pola w patch',
      'pole /sessions/7/activity/kind nie pasuje do żadnej etykiety',
    ]);
  });

  it('zgodna etykieta przechodzi, nieznana jest odrzucona', () => {
    expect(labelProblems({
      degrades: ['activity.kind'], patch: [{ path: '/sessions/7/activity/kind', value: 'zzz' }],
    })).toEqual([]);
    expect(labelProblems({ degrades: ['nowe.pole'], patch: [{ path: '/x', value: 'zzz' }] }))
      .toEqual(['etykieta nowe.pole spoza DEGRADATIONS', 'pole /x nie pasuje do żadnej etykiety']);
  });
});

describe('złote ramki SSE: pole z tekstem ma `ref`', () => {
  it('mapa rodzajów pól = pola tekstu z parą `ref` w schemacie ramki', () => {
    const all = new Set<string>();
    schemaPaths(EVENT_JSON_SCHEMA, '', all);
    const fromSchema = [...all].filter((field) => /(?:\/ref|Ref)$/u.test(field))
      .map((field) => (field.endsWith('/ref') ? `${field.slice(0, -4)}/text` : field.slice(0, -3))).sort();
    expect(Object.keys(TEXT_FIELD_KINDS).sort()).toEqual(fromSchema);
  });

  it('szablon bez własnego słowa nie jest wzorcem (pasowałby do treści obcej)', () => {
    expect(REGISTRY.skipped).toEqual(['push.body.detail', 'push.body.detail-and-label', 'push.body.label',
      'restart.exit-note']);
    expect(REGISTRY.patterns.length).toBeGreaterThan(400);
  });

  it('każda ramka poza demo i `ignored`: zdanie własne i zdanie rejestru niosą `ref`', () => {
    const problems = entries.filter(([name, entry]) => underRefGuard(name, entry))
      .flatMap(([name]) => refProblems(read(name)).map((problem) => `${name} ${problem}`));
    expect(problems).toEqual([]);
  });

  it('pliki demo i przypadki `ignored`/`raw` stoją poza strażnikiem, reszta pod nim', () => {
    expect(underRefGuard('sessions-snapshot.demo.json', manifest['sessions-snapshot.demo.json'] as Entry)).toBe(false);
    expect(underRefGuard('transcript-snapshot.demo.json', manifest['transcript-snapshot.demo.json'] as Entry)).toBe(false);
    for (const [name, entry] of entries) {
      if (entry.expect === 'ignored') expect(underRefGuard(name, entry), name).toBe(false);
    }
    expect(underRefGuard('message.refs.json', manifest['message.refs.json'] as Entry)).toBe(true);
  });
});

describe('strażnik `ref` na kopiach złotych ramek', () => {
  /** Kopia ramki do mutacji w teście (pola zagnieżdżone bez zawężania typów). */
  type Doc = Record<string, any>;
  const copy = (name: string): Doc => structuredClone(read(name)) as Doc;
  const trimmed = SENTENCES[TRIMMED_MARK].en;

  it('znacznik `[image]` w bloku `assistant` bez `ref` → czerwony', () => {
    const frame = copy('message.refs.json');
    expect(refProblems(frame)).toEqual([]);
    delete frame.message.blocks[0].ref;
    expect(refProblems(frame)).toEqual(['/message/blocks/0/text: zdanie rejestru transcript.image-placeholder bez ref']);
  });

  it('zdanie rejestru z pustym argumentem tekstu w bloku `assistant` bez `ref` → czerwony', () => {
    const frame = copy('message.refs.json');
    frame.message.blocks[0].text = say('herdr.response-timeout', { method: '' }).text;
    delete frame.message.blocks[0].ref;
    expect(refProblems(frame)).toEqual(['/message/blocks/0/text: zdanie rejestru herdr.response-timeout bez ref']);
  });

  it('zgoda zdegradowana bez `displayTextRef` i pytanie zastępcze bez `questionRef` → czerwone', () => {
    const frame = copy('transcript-snapshot.refs.json');
    expect(refProblems(frame)).toEqual([]);
    delete frame.pendingPermissions[1].displayTextRef;
    delete frame.pendingQuestions[0].questions[0].questionRef;
    expect(refProblems(frame)).toEqual([
      '/pendingPermissions/1/displayText: zdanie rejestru dialogs.degraded-display bez ref',
      '/pendingQuestions/0/questions/0/question: zdanie rejestru dialogs.fallback-question.question bez ref',
    ]);
  });

  it('blok roli `system` bez `ref` → czerwony, ten sam tekst w roli `assistant` → zielony', () => {
    const frame = copy('message.refs.json');
    frame.message.blocks = [{ type: 'text', text: 'Pane switched to another session.' }];
    expect(refProblems(frame)).toEqual([]);
    frame.message.role = 'system';
    expect(refProblems(frame)).toEqual(['/message/blocks/0/text: tekst bez ref poza treścią obcą (block)']);
  });

  it('etykieta sesji z promptu bez `labelRef` → zielony; `stateDetail` bez `stateDetailRef` → czerwony', () => {
    const frame = copy('session-changed.max.json');
    frame.session.label = 'fix the login form';
    delete frame.session.labelRef;
    frame.session.stateDetail = 'herdr is not responding';
    delete frame.session.stateDetailRef;
    expect(refProblems(frame)).toEqual(['/session/stateDetail: tekst bez ref poza treścią obcą (own)']);
  });

  it('blok przycięty budżetem bez `ref` ze znacznikiem przycięcia → zielony, bez znacznika → czerwony', () => {
    const frame = copy('message.refs.json');
    frame.message.role = 'system';
    frame.message.blocks = [
      { type: 'text', text: 'Pane switched to another sess' },
      { type: 'text', text: trimmed, ref: { code: TRIMMED_MARK } },
    ];
    expect(refProblems(frame)).toEqual([]);
    frame.message.blocks = [frame.message.blocks[0]];
    expect(refProblems(frame)).toEqual(['/message/blocks/0/text: tekst bez ref poza treścią obcą (block)']);
    // Znacznik bez kodu nie zwalnia bloku przed nim, a sam jest zdaniem rejestru bez `ref`.
    frame.message.blocks = [{ type: 'text', text: 'Pane switched to another sess' }, { type: 'text', text: trimmed }];
    expect(refProblems(frame)).toEqual([
      '/message/blocks/0/text: tekst bez ref poza treścią obcą (block)',
      `/message/blocks/1/text: zdanie rejestru ${TRIMMED_MARK} bez ref`,
    ]);
  });

  it('szablon z argumentem pasuje do dowolnego ciągu w jego miejscu, także pustego; liczba mnoga w obu wariantach', () => {
    expect(registryCodeOf('herdr is not responding (agent.list).')).toBe(undefined);
    expect(registryCodeOf('Timed out waiting for a herdr response (agent.list).')).toBe('herdr.response-timeout');
    expect(registryCodeOf('Timed out waiting for a herdr response ().')).toBe('herdr.response-timeout');
    expect(registryCodeOf('\n… (1 character cut off)')).toBe('transcript.truncation-footer');
    expect(registryCodeOf('\n… (5 characters cut off)')).toBe('transcript.truncation-footer');
    expect(registryCodeOf(trimmed)).toBe(TRIMMED_MARK);
    expect(registryCodeOf('[image]')).toBe('transcript.image-placeholder');
    expect(registryCodeOf('[image] ')).toBe(undefined);
  });
});

describe('złote ramki SSE: plik → dekoder', () => {
  it.each(entries)('%s', (name, entry) => {
    const stored = read(name);
    if (entry.base !== undefined) {
      // Strażnik dryfu: pochodna musi być DOKŁADNIE bazą z nałożonym `patch`.
      expect(stored, `${name} rozjechał się z ${entry.base} + patch`)
        .toEqual(applyOps(read(entry.base), entry.patch ?? []));
    }
    let input: unknown = stored;
    if (entry.raw === true) {
      expect(typeof stored, `${name}: raw = łańcuch z tekstem pola data:`).toBe('string');
      expect(() => JSON.parse(stored as string), `${name}: surowy tekst ma być zepsutym JSON-em`)
        .toThrow();
      input = stored;
    }
    const decoded = decodeServerEvent(input);

    if (entry.expect === 'ignored') {
      expect(decoded).toBeNull();
      return;
    }
    expect(decoded, `${name}: dekoder odrzucił ramkę`).not.toBeNull();
    if (decoded === null) return;

    if (entry.expect === 'ok') {
      expect(decoded.degradations).toEqual([]);
      const strip = (entry.strip ?? []).map((field) => ({ path: field, remove: true as const }));
      expect(decoded.event).toEqual(applyOps(input, strip));
      return;
    }

    const expected = (entry.patch ?? []).map((op) => {
      expect(typeof op.value, `${name}: degradacja niesie nieznany ŁAŃCUCH`).toBe('string');
      return { path: op.path, value: op.value as string };
    });
    expect([...decoded.degradations].sort(byPath)).toEqual(expected.sort(byPath));
    expect(decoded.event).toEqual(applyOps(input, entry.result ?? []));
  });
});
