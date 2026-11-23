/**
 * Złote odpowiedzi REST, strona KLIENTA: pliki `shared/fixtures/rest/` → schematy.
 *
 * Każdy plik to DOKŁADNIE ciało jednej odpowiedzi HTTP po `JSON.parse`, a `manifest.json` mówi,
 * z jakiej trasy i z jakim statusem przyszło i którym schematem ją czytać. Pliki produkuje kod
 * serwera (`server/test/rest-fixtures-producenci.test.ts`, odświeżenie `RAROG_FIXTURES_WRITE=1`);
 * ten plik celowo NIE importuje niczego z `server/` — to lustro dla każdego innego klienta
 * (Swift: `RestFixturesTests` w `RarogContract`).
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ZodType } from 'zod';
import {
  COMMAND_TEXT_MAX, commandListSchema, decisionRefusedBodySchema, diffFileListSchema, diffFilePatchSchema,
  dirEntrySchema, dirListingSchema, interruptResponseSchema, modelListSchema, notesConflictBodySchema, notesGetResponseSchema,
  notesPutResponseSchema, resumableListSchema, sessionModelResponseSchema,
} from '../src/protocol.ts';
import {
  DEVICE_ID_RE, PAIRING_CODE_RE, ULTRACODE_REFUSED_ERROR, apnsStatusResponseSchema, companionAskSchema, companionTokenSchema,
  companionSessionsSchema, companionSpeechTokenSchema, companionTurnsSchema, deviceListSchema, deviceMeSchema, deviceRevokedBodySchema, errorBodySchema, liveActivityMacSchema, messageAcceptedSchema, okAckSchema,
  pairResponseSchema, pairingIssuedSchema, planUsageSchema, queueTakeBackResponseSchema, restartResponseSchema,
  resumeResponseSchema,
  termHistoryResponseSchema, termListResponseSchema, termOpenResponseSchema, versionResponseSchema,
} from '../src/rest.ts';
import { RETIRED, SENTENCES } from '../src/sentences/index.ts';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/rest');
const MANIFEST = 'manifest.json';

/**
 * Schematy odpowiedzi po nazwie z manifestu — nazwa jest kontraktem dla klienta w innym języku.
 *
 * Mapa zna też schematy tras bez złotej odpowiedzi
 * (`termOpenResponse`, `termListResponse`, `termHistoryResponse` — terminal apki natywnej):
 * nowy plik w manifeście dostaje wtedy gotową nazwę, a test Swift `everySchemaHasSwiftType`
 * ma już dla niej typ.
 */
const SCHEMAS: Record<string, ZodType> = {
  versionResponse: versionResponseSchema,
  resumableList: resumableListSchema,
  planUsage: planUsageSchema,
  // `GET /api/mac` — ten sam kształt co `mac` w stanie Live Activity, bo czyta ten sam próbnik.
  macLoad: liveActivityMacSchema,
  errorBody: errorBodySchema,
  okAck: okAckSchema,
  messageAccepted: messageAcceptedSchema,
  queueTakeBackResponse: queueTakeBackResponseSchema,
  restartResponse: restartResponseSchema,
  resumeResponse: resumeResponseSchema,
  interruptResponse: interruptResponseSchema,
  dirListing: dirListingSchema,
  // `POST /api/fs/mkdir`: the row of the new directory, the same shape as a listing row.
  dirEntry: dirEntrySchema,
  apnsStatusResponse: apnsStatusResponseSchema,
  termOpenResponse: termOpenResponseSchema,
  termListResponse: termListResponseSchema,
  termHistoryResponse: termHistoryResponseSchema,
  // Diff sesji per plik: lista zmian i patch jednego pliku.
  diffFileList: diffFileListSchema,
  diffFilePatch: diffFilePatchSchema,
  // Notatki projektu (apka natywna): dokument, nowa wersja po zapisie i 409 z aktualnym dokumentem.
  notesDoc: notesGetResponseSchema,
  notesSaved: notesPutResponseSchema,
  notesConflict: notesConflictBodySchema,
  // Slash-komendy sesji: lista podpowiedzi apki = migawka strażnika wysyłki.
  commandList: commandListSchema,
  // Lista modeli do wyboru (`GET /api/models`): wbudowana, z polem `ultracode` przy pozycji, którą serwer umie
  // włączyć.
  modelList: modelListSchema,
  // Klucze urządzeń i parowanie kodem: odpowiedź parowania, kod z urządzenia, lista, `me`, 401 z datą.
  pairResponse: pairResponseSchema,
  pairingIssued: pairingIssuedSchema,
  deviceList: deviceListSchema,
  deviceMe: deviceMeSchema,
  deviceRevokedBody: deviceRevokedBodySchema,
  // Zdania z kodem: 422 odmowy decyzji z powodem i 202 zmiany modelu z ostrzeżeniem.
  decisionRefusedBody: decisionRefusedBodySchema,
  sessionModelResponse: sessionModelResponseSchema,
  // Agent głosowy: odpowiedź Haiku o sesji, z promptem dla agenta albo bez.
  companionAsk: companionAskSchema,
  // Klucz krótki OpenAI agenta głosowego: wartość syntetyczna.
  companionToken: companionTokenSchema,
  // Temporary Soniox speech key of the voice agent: a synthetic value.
  companionSpeechToken: companionSpeechTokenSchema,
  companionTurns: companionTurnsSchema,
  // The voice agent's session catalog: rows of the sessions in its scope.
  companionSessions: companionSessionsSchema,
};

/**
 * Schematy odmów: ciało błędu z kodem i zdaniem albo odmowa z treścią (409 notatek, 401 odpiętego urządzenia, 422
 * odmowy decyzji).
 */
const REFUSAL_SCHEMAS = new Set(['errorBody', 'notesConflict', 'deviceRevokedBody', 'decisionRefusedBody']);

/**
 * Odpowiedzi ze zdaniami serwera: identyfikator schematu z {@link SCHEMAS}, typ Swift z `RarogContract`
 * i złoty plik, który niesie pola `*Ref`. Lista NIE zależy od manifestu: pozycja bez pliku, bez wpisu manifestu albo
 * bez `*Ref` jest czerwona, a ta sama lista stoi w Swift (`sentenceResponses` w `SentenceBearingTests.swift`).
 */
const SENTENCE_RESPONSES: readonly { id: string; swiftType: string; file: string }[] = [
  { id: 'errorBody', swiftType: 'APIErrorBody', file: 'error.not-found.json' },
  { id: 'decisionRefusedBody', swiftType: 'APIErrorBody', file: 'error.decision-refused.json' },
  { id: 'notesConflict', swiftType: 'NotesConflictBody', file: 'notes.conflict.json' },
  { id: 'deviceRevokedBody', swiftType: 'DeviceRevokedBody', file: 'error.device-revoked.json' },
  { id: 'sessionModelResponse', swiftType: 'SessionModelAccepted', file: 'model-accepted.json' },
  { id: 'modelList', swiftType: 'ModelList', file: 'models.json' },
  { id: 'interruptResponse', swiftType: 'InterruptResponse', file: 'interrupt.json' },
];

const SWIFT_SENTENCE_SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../native/Rarog/Packages/RarogContract/Tests/RarogContractTests/SentenceBearingTests.swift');

/** Pozycje `sentenceResponses` z kodu Swift (każda w jednej linii `SentenceResponse(id: …, type: ….self, file: …)`). */
function swiftSentenceResponses(source: string): { id: string; swiftType: string; file: string }[] {
  const line = /SentenceResponse\(id: "([^"]+)", type: ([A-Za-z0-9_.]+)\.self, file: "([^"]+)"\)/gu;
  return [...source.matchAll(line)].map((m) => ({ id: m[1] ?? '', swiftType: m[2] ?? '', file: m[3] ?? '' }));
}

/** Ścieżki pól `*Ref` w dokumencie JSON (`/session/labelRef`, `/models/*\/labelRef`). */
function refPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => refPaths(item, `${prefix}/*`));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(key.endsWith('Ref') ? [`${prefix}/${key}`] : []),
    ...refPaths(child, `${prefix}/${key}`),
  ]);
}

/** Ścieżki pól `*Ref` schematu (JSON Schema zoda). */
function schemaRefPaths(node: unknown, prefix = ''): string[] {
  if (typeof node !== 'object' || node === null) return [];
  const n = node as { properties?: Record<string, unknown>; items?: unknown; anyOf?: unknown[]; oneOf?: unknown[] };
  return [
    ...[...(n.anyOf ?? []), ...(n.oneOf ?? [])].flatMap((branch) => schemaRefPaths(branch, prefix)),
    ...(n.items === undefined ? [] : schemaRefPaths(n.items, `${prefix}/*`)),
    ...Object.entries(n.properties ?? {}).flatMap(([key, child]) => [
      ...(key.endsWith('Ref') ? [`${prefix}/${key}`] : []),
      ...schemaRefPaths(child, `${prefix}/${key}`),
    ]),
  ];
}

/** Polska litera w tekście obok `*Ref`: zdanie z kodem jest angielskie (strażnik warunkowy do końca migracji). */
const POLISH_LETTER = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/u;

/** Pola tekstu z parą `*Ref`, które niosą polską literę (pusta lista = zgodne). */
function polishBesideRef(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => polishBesideRef(item, `${prefix}/${String(i)}`));
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  const own = Object.keys(record).filter((key) => key.endsWith('Ref')).map((key) => key.slice(0, -3))
    .filter((key) => typeof record[key] === 'string' && POLISH_LETTER.test(record[key] as string))
    .map((key) => `${prefix}/${key}`);
  return [...own, ...Object.entries(record).flatMap(([key, child]) => polishBesideRef(child, `${prefix}/${key}`))];
}

// ---------------------------------------------------------------------------
// Strażnik „pole z tekstem ma `ref`” (ta sama reguła co w `sse-fixtures.test.ts`)
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
 * Wzorce szablonów `en` rejestru (`SENTENCES` i `RETIRED`, warianty liczby mnogiej osobno). Szablon bez własnego
 * słowa (same argumenty i znaki, np. `{detail} — {label}`) pasowałby do treści obcej, więc wzorcem nie jest.
 */
const REGISTRY_PATTERNS: readonly { code: string; pattern: RegExp }[] = Object.entries({ ...SENTENCES, ...RETIRED })
  .flatMap(([code, def]) => (typeof def.en === 'string' ? [def.en] : [def.en.one, def.en.other])
    .filter((template) => /\p{L}/u.test(template.replace(/\{[a-z][a-zA-Z0-9]*\}/gu, '')))
    .map((template) => ({ code, pattern: templatePattern(template) })));

/**
 * Rodzaj każdego pola tekstu z parą `*Ref` w schematach odpowiedzi. `own` = zdanie własne serwera, które bez `ref`
 * jest błędem; reszta to treść obca (etykieta sesji użytkownika, etykieta i opis modelu z CLI). `block`: rodzaj
 * zależy od roli wiadomości ({@link FOREIGN_ROLES}), jak w złotych ramkach SSE. Test niżej trzyma tę mapę równą
 * zbiorowi pól ze schematów {@link SCHEMAS}.
 */
const TEXT_FIELD_KINDS: Readonly<Record<string, 'own' | 'block' | 'session-label' | 'model-label' | 'model-description'>> = {
  '/message': 'own',
  '/messages/*/blocks/*/text': 'block',
  '/warning': 'own',
  '/session/label': 'session-label',
  '/session/stateDetail': 'own',
  '/models/*/label': 'model-label',
  '/models/*/description': 'model-description',
};

/** Role wiadomości, których blok `text` niesie treść obcą (agent, użytkownik, wynik narzędzia). Bez `system`. */
const FOREIGN_ROLES = new Set(['assistant', 'user', 'tool']);

/** Rola wiadomości, do której należy blok pod wskaźnikiem `/messages/<i>/blocks/<j>/text`. */
function roleOf(body: unknown, pointer: string): unknown {
  const index = /^\/messages\/(\d+)\//u.exec(pointer)?.[1];
  const messages = (body as { messages?: { role?: unknown }[] }).messages;
  return index === undefined ? undefined : messages?.[Number(index)]?.role;
}

const isRefKey = (key: string): boolean => key === 'ref' || key.endsWith('Ref');
const textKeyOf = (refKey: string): string => (refKey === 'ref' ? 'text' : refKey.slice(0, -3));

interface TextField { schemaPath: string; pointer: string; text: string; hasRef: boolean }

/** Pola tekstu z parą `ref` w schemacie, które ciało niesie; gałęzie unii scalone (odpowiedzi REST ich nie dzielą). */
function textFields(node: unknown, value: unknown, schemaPath: string, at: string, out: Map<string, TextField>): void {
  if (typeof node !== 'object' || node === null) return;
  const n = node as { properties?: Record<string, unknown>; items?: unknown; anyOf?: unknown[]; oneOf?: unknown[] };
  for (const branch of [...(n.anyOf ?? []), ...(n.oneOf ?? [])]) textFields(branch, value, schemaPath, at, out);
  if (n.items !== undefined && Array.isArray(value)) {
    value.forEach((item, i) => textFields(n.items, item, `${schemaPath}/*`, `${at}/${String(i)}`, out));
  }
  if (n.properties === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const refKey of Object.keys(n.properties).filter(isRefKey)) {
    const key = textKeyOf(refKey);
    const text = record[key];
    if (typeof text !== 'string') continue;
    out.set(`${at}/${key}`, { schemaPath: `${schemaPath}/${key}`, pointer: `${at}/${key}`, text,
      hasRef: record[refKey] !== undefined });
  }
  for (const [key, child] of Object.entries(record)) textFields(n.properties[key], child, `${schemaPath}/${key}`, `${at}/${key}`, out);
}

/** Ścieżki pól tekstu z parą `ref` w schemacie (bez wartości). */
function schemaTextPaths(node: unknown, prefix = ''): string[] {
  if (typeof node !== 'object' || node === null) return [];
  const n = node as { properties?: Record<string, unknown>; items?: unknown; anyOf?: unknown[]; oneOf?: unknown[] };
  return [
    ...[...(n.anyOf ?? []), ...(n.oneOf ?? [])].flatMap((branch) => schemaTextPaths(branch, prefix)),
    ...(n.items === undefined ? [] : schemaTextPaths(n.items, `${prefix}/*`)),
    ...Object.keys(n.properties ?? {}).filter(isRefKey).map((key) => `${prefix}/${textKeyOf(key)}`),
    ...Object.entries(n.properties ?? {}).flatMap(([key, child]) => schemaTextPaths(child, `${prefix}/${key}`)),
  ];
}

/**
 * Pola tekstu bez `ref` w ciele odpowiedzi schematu `schema`, które powinny go mieć, jako `wskaźnik: powód`:
 * tekst pasuje do szablonu kodu rejestru (każde pole) albo pole jest zdaniem własnym (`own`).
 */
function refProblems(schema: ZodType, body: unknown): string[] {
  const fields = new Map<string, TextField>();
  textFields(z.toJSONSchema(schema), body, '', '', fields);
  const problems: string[] = [];
  for (const field of fields.values()) {
    if (field.hasRef) continue;
    const code = REGISTRY_PATTERNS.find(({ pattern }) => pattern.test(field.text))?.code;
    const kind = TEXT_FIELD_KINDS[field.schemaPath];
    if (code !== undefined) problems.push(`${field.pointer}: zdanie rejestru ${code} bez ref`);
    else if (kind === undefined) problems.push(`${field.pointer}: pole ${field.schemaPath} bez rodzaju w TEXT_FIELD_KINDS`);
    else if (kind === 'block' ? !FOREIGN_ROLES.has(String(roleOf(body, field.pointer))) : kind === 'own') {
      problems.push(`${field.pointer}: tekst bez ref poza treścią obcą (${kind})`);
    }
  }
  return problems;
}

const entrySchema = z.strictObject({
  /** Metoda i ścieżka trasy (`:id` zamiast identyfikatora) — dla człowieka i klienta. */
  route: z.string().regex(/^(?:GET|POST|PUT) \/api\//),
  status: z.number().int().min(200).max(599),
  schema: z.enum(Object.keys(SCHEMAS) as [string, ...string[]]),
});

const manifest = z.record(z.string(), entrySchema)
  .parse(JSON.parse(readFileSync(path.join(DIR, MANIFEST), 'utf8')));
const entries = Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b));
const read = (name: string): unknown => JSON.parse(readFileSync(path.join(DIR, name), 'utf8')) as unknown;

describe('złote odpowiedzi REST: manifest i pliki', () => {
  it('manifest ↔ katalog w obie strony', () => {
    const files = readdirSync(DIR).filter((name) => name !== MANIFEST).sort();
    expect(files).toEqual(entries.map(([name]) => name));
  });

  it('status zgadza się z rodzajem schematu: błąd tylko przy 4xx/5xx, sukces tylko przy 2xx', () => {
    for (const [name, entry] of entries) {
      // Ciało 409 notatek i 401 odpiętego urządzenia to odmowy z treścią: schemat odmowy, status błędu.
      expect(REFUSAL_SCHEMAS.has(entry.schema), name).toBe(entry.status >= 400);
    }
  });

  it('każda trasa z listy kontraktu ma co najmniej jedną złotą odpowiedź', () => {
    const routes = new Set(entries.map(([, entry]) => entry.route));
    for (const route of [
      'GET /api/version', 'GET /api/resumable?cwd=', 'GET /api/usage',
      'POST /api/sessions/:id/messages', 'POST /api/sessions/:id/seen', 'POST /api/sessions/:id/unseen',
      'POST /api/sessions/:id/restart', 'POST /api/sessions/:id/interrupt', 'POST /api/sessions/:id/focus',
      'POST /api/sessions/:id/queue/take-back',
      'GET /api/fs', 'GET /api/fs?path=', 'GET /api/resumable/recent?cwd=', 'POST /api/sessions/:id/resume',
      // Creating a directory in the browser of the New Session form.
      'POST /api/fs/mkdir',
      // Kontrakt APNs apki natywnej: status tokenu idzie POST-em, żeby token nie stał w query.
      'POST /api/push/apns/status',
      // REST terminala dla apki natywnej.
      'POST /api/term', 'GET /api/term', 'GET /api/term/:id/history?lines=',
      // Obciążenie Maca w stopce listy apki.
      'GET /api/mac',
      // Diff sesji per plik: lista zmian i patch jednego pliku.
      'GET /api/sessions/:id/diff/files', 'GET /api/sessions/:id/diff/file?path=',
      // Notatki projektu: odczyt i zapis z wersją.
      'GET /api/notes?cwd=', 'PUT /api/notes',
      // Slash-komendy sesji.
      'GET /api/sessions/:id/commands',
      // Lista modeli formularza i dymka „Model i effort”.
      'GET /api/models',
      // Szczegóły limitów z odczytu Claude Code dla arkusza „Limity”.
      'GET /api/usage/details',
      // Klucze urządzeń i parowanie.
      'POST /api/pair', 'POST /api/pairings', 'GET /api/devices', 'GET /api/devices/me',
      // Agent głosowy.
      'POST /api/sessions/:id/companion/ask', 'POST /api/companion/token', 'POST /api/companion/speech-token',
      'GET /api/sessions/:id/companion/turns?count=', 'GET /api/companion/sessions',
    ]) {
      expect(routes.has(route), route).toBe(true);
    }
    // Warianty limitów z paska statusu: świeży, stary zrzut (`stale`) i Mac bez e-maila konta.
    type Usage = { stale?: boolean; source?: string; account?: string; weeklyModel?: { model?: string } };
    const usageOf = (route: string): Usage[] => entries.filter(([, entry]) => entry.route === route)
      .map(([name]) => read(name) as Usage);
    const usage = usageOf('GET /api/usage');
    expect(usage.every((body) => body.source === 'cli')).toBe(true);
    expect(usage.some((body) => body.stale === undefined)).toBe(true);
    expect(usage.some((body) => body.stale === true)).toBe(true);
    expect(usage.some((body) => body.account === undefined)).toBe(true);
    // Szczegóły: odczyt Claude Code z oknem per model, bez `source`, i brak odczytu jako `{}`.
    const details = usageOf('GET /api/usage/details');
    expect(details.every((body) => body.source === undefined)).toBe(true);
    expect(details.some((body) => body.weeklyModel?.model === 'Fable' && body.stale === true)).toBe(true);
    expect(details.some((body) => Object.keys(body).length === 0)).toBe(true);
  });
});

describe('złote odpowiedzi REST: zdania z kodem', () => {
  it('`SENTENCE_RESPONSES` = lista `sentenceResponses` w Swift (identyfikator, typ, plik)', () => {
    expect(swiftSentenceResponses(readFileSync(SWIFT_SENTENCE_SOURCE, 'utf8'))).toEqual(SENTENCE_RESPONSES);
  });

  it.each(SENTENCE_RESPONSES.map((entry) => [entry.id, entry] as const))('%s: schemat, wpis manifestu, plik z `*Ref`', (id, entry) => {
    expect(Object.keys(SCHEMAS), id).toContain(id);
    expect(manifest[entry.file]?.schema, `${entry.file}: brak w manifeście albo inny schemat`).toBe(id);
    const body = read(entry.file);
    expect(refPaths(body).length, `${entry.file}: bez pola *Ref`).toBeGreaterThan(0);
  });

  it('pokrycie pól: każde pole `*Ref` schematu z `SENTENCE_RESPONSES` stoi w złotym pliku tego schematu', () => {
    const missing: string[] = [];
    for (const { id } of SENTENCE_RESPONSES) {
      const schema = SCHEMAS[id];
      if (schema === undefined) continue;
      const files = entries.filter(([, entry]) => entry.schema === id).map(([name]) => read(name));
      const present = new Set(files.flatMap((body) => refPaths(body)));
      // Pola karty sesji (`/session/…`) pokrywają złote ramki SSE: każda odpowiedź `interrupt` niesie inną sesję.
      for (const field of schemaRefPaths(z.toJSONSchema(schema))) {
        if (!field.startsWith('/session/') && !present.has(field)) missing.push(`${id}: ${field}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('przypadki: 404 sesji, 422 `multi-select`, 401 odpiętego urządzenia, 409 notatek, lista i zmiana modelu', () => {
    expect(read('error.not-found.json')).toEqual({
      error: 'not-found', message: "That session doesn't exist.", messageRef: { code: 'rest.session-not-found' },
    });
    expect(read('error.decision-refused.json')).toMatchObject({
      error: 'refused', reason: 'multi-select', messageRef: { code: 'dialogs.refuse.multi-select' },
    });
    expect(manifest['error.decision-refused.json']?.status).toBe(422);
    expect(read('error.device-revoked.json')).toMatchObject({ messageRef: { code: 'rest.device-revoked' } });
    expect(read('notes.conflict.json')).toMatchObject({ messageRef: { code: 'rest.notes-conflict' } });
    expect(read('error.notes-cwd-not-allowed.json')).toMatchObject({ messageRef: { code: 'rest.cwd-not-in-projects' } });
    const [first, ...rest] = modelListSchema.parse(read('models.json')).models;
    expect(first).toMatchObject({ labelRef: { code: 'model.default-label' }, descriptionRef: { code: 'model.default-description' } });
    expect(rest.every((choice) => choice.labelRef === undefined && choice.descriptionRef === undefined)).toBe(true);
    expect(read('model-accepted.json')).toMatchObject({ ok: true, warningRef: { code: 'model.change-warning' } });
    expect(manifest['model-accepted.json']).toMatchObject({ route: 'POST /api/sessions/:id/model', status: 202 });
  });

  it('strażnik warunkowy: tekst obok `*Ref` nie ma polskiej litery (każdy złoty plik)', () => {
    for (const [name] of entries) expect(polishBesideRef(read(name)), name).toEqual([]);
  });

  it('uszkodzony `ref` odrzuca ciało: `null`, pusty kod, 9 argumentów, argument liczbą', () => {
    const bad: readonly unknown[] = [
      null, { code: '' }, { code: 'a.b', args: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] }, { code: 'a.b', args: [1] },
    ];
    for (const ref of bad) {
      const label = JSON.stringify(ref);
      expect(errorBodySchema.safeParse({ ...(read('error.not-found.json') as object), messageRef: ref }).success, label)
        .toBe(false);
      expect(decisionRefusedBodySchema.safeParse({ ...(read('error.decision-refused.json') as object), messageRef: ref })
        .success, label).toBe(false);
      expect(notesConflictBodySchema.safeParse({ ...(read('notes.conflict.json') as object), messageRef: ref }).success, label)
        .toBe(false);
      expect(deviceRevokedBodySchema.safeParse({ ...(read('error.device-revoked.json') as object), messageRef: ref })
        .success, label).toBe(false);
      expect(sessionModelResponseSchema.safeParse({ ...(read('model-accepted.json') as object), warningRef: ref }).success,
        label).toBe(false);
      const models = read('models.json') as { models: object[] };
      expect(modelListSchema.safeParse({ models: [{ ...models.models[0], labelRef: ref }] }).success, label).toBe(false);
      const interrupt = read('interrupt.json') as { session: object };
      expect(interruptResponseSchema.safeParse({ ...interrupt, session: { ...interrupt.session, labelRef: ref } }).success,
        label).toBe(false);
    }
  });
});

describe('złote odpowiedzi REST: pole z tekstem ma `ref`', () => {
  it('mapa rodzajów pól = pola tekstu z parą `ref` w schematach odpowiedzi', () => {
    const fromSchemas = new Set(Object.values(SCHEMAS).flatMap((schema) => schemaTextPaths(z.toJSONSchema(schema))));
    expect(Object.keys(TEXT_FIELD_KINDS).sort()).toEqual([...fromSchemas].sort());
  });

  it('każda odpowiedź poza demo: zdanie własne i zdanie rejestru niosą `ref`', () => {
    const problems = entries.filter(([name]) => !name.endsWith('.demo.json')).flatMap(([name, entry]) => {
      const schema = SCHEMAS[entry.schema];
      return schema === undefined ? [] : refProblems(schema, read(name)).map((problem) => `${name} ${problem}`);
    });
    expect(problems).toEqual([]);
  });

  it('przypadki na kopiach: ciało błędu bez `messageRef` czerwone, etykiety modeli z CLI zielone', () => {
    const required = structuredClone(read('error.device-required.json')) as Record<string, unknown>;
    expect(refProblems(errorBodySchema, required)).toEqual([]);
    delete required.messageRef;
    expect(refProblems(errorBodySchema, required)).toEqual(['/message: zdanie rejestru rest.device-required bez ref']);
    expect(refProblems(errorBodySchema, { error: 'x', message: 'Something odd happened.' }))
      .toEqual(['/message: tekst bez ref poza treścią obcą (own)']);
    const models = structuredClone(read('models.json')) as { models: Record<string, unknown>[] };
    expect(refProblems(modelListSchema, models)).toEqual([]);
    delete models.models[0]?.labelRef;
    expect(refProblems(modelListSchema, models)).toEqual(['/models/0/label: zdanie rejestru model.default-label bez ref']);
    // Session turns: a human or agent block is foreign text, a `system` block is the server's own.
    const turns = structuredClone(read('companion.turns.json')) as { messages: { role: string; blocks: object[] }[] };
    expect(refProblems(companionTurnsSchema, turns)).toEqual([]);
    const note = turns.messages.findIndex((m) => m.role === 'system');
    const human = turns.messages.findIndex((m) => m.role === 'user');
    for (const at of [note, human]) turns.messages[at] = { ...turns.messages[at]!, blocks: [{ type: 'text', text: 'Odd text.' }] };
    expect(refProblems(companionTurnsSchema, turns))
      .toEqual([`/messages/${String(note)}/blocks/0/text: tekst bez ref poza treścią obcą (block)`]);
  });
});

describe('złote odpowiedzi REST: plik → schemat', () => {
  it.each(entries)('%s', (name, entry) => {
    const stored = read(name);
    const schema = SCHEMAS[entry.schema];
    // Ścisły schemat bez strat: każde pole odpowiedzi jest w kontrakcie (`z.object` odcina obce).
    expect(schema?.parse(stored)).toEqual(stored);
  });

  it('nieznany klucz w odpowiedzi to forward-compat: odcięty, nie błąd', () => {
    const version = read('version.json') as Record<string, unknown>;
    expect(versionResponseSchema.parse({ ...version, przyszlePole: 1 })).toEqual(version);
  });

  it('wersja: producent podaje STAŁY system maszyny (`macos`), niezależny od maszyny testu', () => {
    for (const name of ['version.json', 'version.iroh.json']) {
      expect(versionResponseSchema.parse(read(name)).system, name).toBe('macos');
    }
  });

  it('terminal: pierwszy tab to slot 1 powłoki, popup stoi poza slotami, odmowy to 409 z kodem', () => {
    const opened = termOpenResponseSchema.parse(read('term.open.json'));
    expect(opened).toMatchObject({ slot: 1, role: 'shell' });
    const { terminals } = termListResponseSchema.parse(read('term.list.json'));
    expect(terminals.some((entry) => entry.id === opened.id && entry.slot === 1)).toBe(true);
    // Rola popupowa (`lazygit`, `popup`) ma zawsze slot 0 — nie zabiera pigułki w pasku projektu.
    expect(terminals.filter((entry) => entry.role !== 'shell').every((entry) => entry.slot === 0)).toBe(true);
    expect(terminals.filter((entry) => entry.role === 'shell').map((entry) => entry.slot)).toEqual([1, 2]);
    expect(termHistoryResponseSchema.parse(read('term.history.json')).truncated).toBe(true);
    for (const [name, code] of [
      ['error.term-limit.json', 'term-limit'],
      ['error.term-herdr-launch-off.json', 'herdr-launch-off'],
      ['error.term-herdr-send-off.json', 'herdr-send-off'],
    ] as const) {
      expect(manifest[name]?.status, name).toBe(409);
      expect(errorBodySchema.parse(read(name)).error, name).toBe(code);
    }
  });

  it('diff per plik: liczniki opcjonalne, plik binarny, ucięcia i cztery kody odmów', () => {
    const demo = diffFileListSchema.parse(read('diff.files.json'));
    expect(demo.truncated).toBe(false);
    expect(demo.files.map((file) => file.status)).toEqual(['M', 'A', 'D']);
    const cut = diffFileListSchema.parse(read('diff.files.truncated.json'));
    expect(cut.truncated).toBe(true);
    // Trzy postacie wpisu: z licznikami, binarny bez liczników, nieśledzony bez niczego.
    expect(cut.files.some((file) => file.linesAdded !== undefined && file.binary === undefined)).toBe(true);
    expect(cut.files.some((file) => file.binary === true && file.linesAdded === undefined)).toBe(true);
    expect(cut.files.some((file) => file.binary === undefined && file.linesAdded === undefined)).toBe(true);

    const file = diffFilePatchSchema.parse(read('diff.file.json'));
    expect(demo.files.map((entry) => entry.path)).toContain(file.path);
    expect(file.patch.startsWith(`diff --git a/${file.path} b/${file.path}\n`)).toBe(true);
    expect(file.truncated).toBe(false);
    expect(diffFilePatchSchema.parse(read('diff.file.binary.json')).patch).toContain('Binary files ');
    const clipped = diffFilePatchSchema.parse(read('diff.file.truncated.json'));
    expect(clipped.truncated).toBe(true);
    expect(clipped.patch.endsWith('\n')).toBe(true);

    for (const [name, status, code] of [
      ['error.diff-bad-path.json', 400, 'bad-path'],
      ['error.diff-file-not-found.json', 404, 'diff-file-not-found'],
      ['error.diff-session-not-found.json', 404, 'session-not-found'],
      ['error.diff-git-failed.json', 503, 'git-failed'],
    ] as const) {
      expect(manifest[name]?.status, name).toBe(status);
      const body = errorBodySchema.parse(read(name));
      expect(body.error, name).toBe(code);
      expect(body.message, name).not.toBe('');
    }
  });

  it('notatki: dokument z treścią i pusty, nowa wersja po zapisie, 409 z aktualnym dokumentem, 400 katalogu', () => {
    const doc = notesGetResponseSchema.parse(read('notes.json'));
    expect(doc.text).not.toBe('');
    expect(notesGetResponseSchema.parse(read('notes.empty.json'))).toEqual({ text: '', updatedAt: 0 });
    const saved = notesPutResponseSchema.parse(read('notes.saved.json'));
    expect(saved.updatedAt).toBeGreaterThan(doc.updatedAt);
    const conflict = notesConflictBodySchema.parse(read('notes.conflict.json'));
    expect(manifest['notes.conflict.json']?.status).toBe(409);
    expect(conflict.current.updatedAt).toBe(saved.updatedAt);
    expect(manifest['error.notes-cwd-not-allowed.json']?.status).toBe(400);
    expect(errorBodySchema.parse(read('error.notes-cwd-not-allowed.json')).error).toBe('cwd-not-allowed');
  });

  it('komendy: demo = sam rejestr bez opisów; dysk = skille i pluginy z opisem; obcy `kind` odrzuca', () => {
    const demo = commandListSchema.parse(read('commands.json'));
    expect(demo.revision).not.toBe('');
    expect(demo.commands.every((entry) => entry.source === 'builtin' && entry.description === undefined)).toBe(true);
    expect(demo.commands.find((entry) => entry.name === 'compact')?.kind).toBe('local');
    expect(demo.commands.find((entry) => entry.name === 'code-review')?.kind).toBe('prompt');
    const names = demo.commands.map((entry) => entry.name);
    expect(names).toEqual([...names].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)));
    // Aliasy nie przechodzą przez strażnika, więc nie stoją na liście.
    expect(names).not.toContain('new');
    // Skille, które CLI przyjmuje tylko od modelu, stoją poza allow-listą.
    expect(names).not.toContain('artifact-design');
    expect(names).not.toContain('keybindings-help');

    const disk = commandListSchema.parse(read('commands.disk.json'));
    expect(disk.revision).not.toBe(demo.revision);
    expect(new Set(disk.commands.map((entry) => entry.source))).toEqual(new Set(['builtin', 'skill', 'plugin']));
    expect(disk.commands.some((entry) => entry.description !== undefined && entry.argumentHint !== undefined)).toBe(true);
    expect(disk.commands.some((entry) => entry.source === 'skill' && entry.description === undefined)).toBe(true);
    expect(disk.commands.some((entry) => entry.description?.endsWith('…') === true
      && entry.description.length <= COMMAND_TEXT_MAX)).toBe(true);
    for (const bad of [
      { revision: 'r', commands: [{ name: 'x', kind: 'panel', source: 'builtin' }] },
      { revision: 'r', commands: [{ name: 'x', kind: 'local', source: 'mcp' }] },
      { revision: 'r', commands: [{ name: 'x', kind: 'local', source: 'builtin', description: '' }] },
      { revision: 'r', commands: [{ name: 'x', kind: 'local', source: 'builtin', argumentHint: 'a'.repeat(201) }] },
      { revision: '', commands: [] },
      { commands: [] },
    ]) {
      expect(commandListSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('start z ultracode: odmowa bramki to 400 z własnym kodem, nie `bad-request`', () => {
    expect(manifest['error.ultracode-refused.json']).toMatchObject({ route: 'POST /api/sessions', status: 400 });
    const body = errorBodySchema.parse(read('error.ultracode-refused.json'));
    expect(body.error).toBe(ULTRACODE_REFUSED_ERROR);
    expect(body.message).toMatch(/ultracode/u);
  });

  it('obciążenie Maca: pusty obiekt = brak odczytu, część pól, zero jako wartość; null i zły typ odrzucone', () => {
    expect(liveActivityMacSchema.parse(read('mac.empty.json'))).toEqual({});
    const partial = liveActivityMacSchema.parse(read('mac.partial.json'));
    expect(partial).toEqual({ cpu: 0, disk: 45 });
    expect(liveActivityMacSchema.parse(read('mac.json'))).toEqual({ cpu: 35, ram: 60, disk: 45 });
    for (const bad of [{ cpu: null }, { ram: '60' }, { disk: 101 }, { cpu: 12.5 }, { cpu: -5 }]) {
      expect(liveActivityMacSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('parowanie: odpowiedź raz z sekretem i kluczem push, kod z urządzenia, lista bez sekretów, 401 z datą', () => {
    const pair = pairResponseSchema.parse(read('pair.json'));
    expect(pair.server.capabilities).toEqual(expect.arrayContaining(['device-auth', 'pair', 'pair-from-device']));
    // Serwer bez nasłuchu iroh: pole obecne, `null`.
    expect(pair.server.iroh).toBeNull();
    expect(pair.secret).not.toBe(pair.pushKey);
    const issued = pairingIssuedSchema.parse(read('pairings.json'));
    expect(issued.code).toMatch(PAIRING_CODE_RE);
    expect(Number.isNaN(Date.parse(issued.expiresAt))).toBe(false);
    const { devices } = deviceListSchema.parse(read('devices.json'));
    // Dwa urządzenia: pierwsze z kodu z Maca, drugie z kodu wydanego na pierwszym, jeszcze bez żądania.
    expect(devices.map((d) => d.creator)).toEqual(['admin', pair.deviceId]);
    expect(devices.filter((d) => d.current)).toHaveLength(1);
    expect(devices[1]?.lastSeenAt).toBeNull();
    for (const name of ['devices.json', 'devices.me.json']) {
      const text = JSON.stringify(read(name));
      for (const banned of ['secret', 'secretHash', 'pushKey', 'kid']) expect(text, `${name}: ${banned}`).not.toContain(`"${banned}"`);
    }
    const me = deviceMeSchema.parse(read('devices.me.json'));
    expect(me.device.current && me.serverId === pair.server.id).toBe(true);
    expect(me.device.id).toMatch(DEVICE_ID_RE);
    const revoked = deviceRevokedBodySchema.parse(read('error.device-revoked.json'));
    expect(manifest['error.device-revoked.json']?.status).toBe(401);
    expect(revoked.revokedBy).toBe('admin');
    for (const [name, status, code] of [
      ['error.pair-unknown.json', 404, 'pair-unknown'],
      ['error.device-unknown.json', 401, 'device-unknown'],
      ['error.device-required.json', 403, 'device-required'],
    ] as const) {
      expect(manifest[name]?.status, name).toBe(status);
      expect(errorBodySchema.parse(read(name)).error, name).toBe(code);
    }
    // `revokedBy`: trzy słowa albo identyfikator urządzenia — inna wartość odrzuca ciało.
    expect(deviceRevokedBodySchema.safeParse({ ...revoked, revokedBy: 'ktos' }).success).toBe(false);
    expect(deviceRevokedBodySchema.safeParse({ ...revoked, revokedBy: pair.deviceId }).success).toBe(true);
  });

  it('serwer z nasłuchem iroh: wersja i parowanie niosą parę EndpointId + relay w postaci kanonicznej', () => {
    const version = versionResponseSchema.parse(read('version.iroh.json'));
    const pair = pairResponseSchema.parse(read('pair.iroh.json'));
    expect(version.iroh).not.toBeNull();
    expect(pair.server.iroh).toEqual(version.iroh);
    expect(version.iroh?.endpointId).toMatch(/^[0-9a-f]{64}$/);
    expect(version.iroh?.relay).toMatch(/^https:\/\/[^/]+\/$/);
  });

  it('serwer bez nadajnika APNs: wersja i status mówią „kanału nie ma"', () => {
    const version = versionResponseSchema.parse(read('version.json'));
    expect(version.apnsEnabled).toBe(false);
    // Serwer nie pisze pola filtra Web Push po klasie urządzenia.
    expect(read('version.json')).not.toHaveProperty('webPushMutedClasses');
    expect(apnsStatusResponseSchema.parse(read('push.apns.status.json'))).toEqual({
      enabled: false, registered: false, alerts: false, degradedSince: null,
    });
  });
});
