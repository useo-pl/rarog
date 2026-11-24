/**
 * Złote CIAŁA ŻĄDAŃ, strona SERWERA: pliki `shared/fixtures/requests/` → schematy zod.
 *
 * Pliki produkuje kod klienta natywnego (`RequestFixturesTests` w `RarogContract`, odświeżenie
 * `RAROG_FIXTURES_WRITE=1 swift test`), a ten test czyta je TYM SAMYM schematem, którym router
 * waliduje żądanie. Ścisłość bez strat (`parse(x)` równe `x`) łapie też pole, które Swift wysyła,
 * a serwer by po cichu odciął. Rozjazd typu Swift ze schematem przewraca więc `pnpm test`,
 * a nie dopiero żądanie z iPada.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ZodType } from 'zod';
import {
  answersBodySchema, apnsRegisterBodySchema, apnsStatusBodySchema, apnsUnregisterBodySchema, companionAskBodySchema,
  companionSpeechTokenBodySchema, companionTokenBodySchema,
  liveActivityEndBodySchema, liveActivityRegisterBodySchema, messageBodySchema, pairBodySchema, restartBodySchema,
  inboxActionBodySchema, seenBodySchema, termOpenBodySchema,
} from '../src/rest.ts';
import {
  createSessionBodySchema, makeDirBodySchema, notesPutBodySchema, sessionModelBodySchema,
} from '../src/protocol.ts';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/requests');
const MANIFEST = 'manifest.json';

/** Schemat ciała po nazwie z manifestu — ten sam obiekt, który czyta router. */
const SCHEMAS: Record<string, ZodType> = {
  apnsRegisterBody: apnsRegisterBodySchema,
  apnsUnregisterBody: apnsUnregisterBodySchema,
  apnsStatusBody: apnsStatusBodySchema,
  liveActivityRegisterBody: liveActivityRegisterBodySchema,
  liveActivityEndBody: liveActivityEndBodySchema,
  termOpenBody: termOpenBodySchema,
  // Odpowiedź na kartę pytania, także z notatkami równoległymi do odpowiedzi.
  answersBody: answersBodySchema,
  // Zapis notatki projektu: pierwsza trasa PUT z ciałem od apki.
  notesPutBody: notesPutBodySchema,
  // Restart sesji: pigułka „↑” bez pól, „Uruchom ponownie i wyślij” z `resend` = cała blokada karty.
  restartBody: restartBodySchema,
  // Parowanie kodem z linku: publiczna trasa, poświadczeniem jest kod z ciała.
  pairBody: pairBodySchema,
  // Start sesji i zmiana w żywej sesji z ultracode: `true` przy starcie, `true` i `false` przy zmianie.
  createSessionBody: createSessionBodySchema,
  sessionModelBody: sessionModelBodySchema,
  // Pytanie agenta głosowego o sesję.
  companionAskBody: companionAskBodySchema,
  // Klucz krótki OpenAI agenta głosowego: puste ciało; pole w nim to 400.
  companionTokenBody: companionTokenBodySchema,
  // Soniox speech key of the voice agent: an empty body; any field is a 400.
  companionSpeechTokenBody: companionSpeechTokenBodySchema,
  // A new directory in the browser of the New Session form: the listed directory and the name.
  makeDirBody: makeDirBodySchema,
  // A message: typed in the app, and a prompt of the voice agent with its sender and the conversation it read.
  messageBody: messageBodySchema,
  // A result viewed in the app (an empty body), and the voice agent's pick-up with the `stateSince` it read.
  seenBody: seenBodySchema,
  // Remove or restore an Inbox card: the turn and the version of the card the device shows.
  inboxActionBody: inboxActionBodySchema,
};

const entrySchema = z.strictObject({
  route: z.string().regex(/^(?:POST|PUT) \/api\//),
  schema: z.enum(Object.keys(SCHEMAS) as [string, ...string[]]),
});

const manifest = z.record(z.string(), entrySchema)
  .parse(JSON.parse(readFileSync(path.join(DIR, MANIFEST), 'utf8')));
const entries = Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b));
const read = (name: string): unknown => JSON.parse(readFileSync(path.join(DIR, name), 'utf8')) as unknown;

describe('złote ciała żądań: manifest i pliki', () => {
  it('manifest ↔ katalog w obie strony', () => {
    const files = readdirSync(DIR).filter((name) => name !== MANIFEST).sort();
    expect(files).toEqual(entries.map(([name]) => name));
  });

  it('każdy schemat ciała i każda trasa apki natywnej ma co najmniej jedno ciało od klienta', () => {
    expect(new Set(entries.map(([, entry]) => entry.schema))).toEqual(new Set(Object.keys(SCHEMAS)));
    const routes = new Set(entries.map(([, entry]) => entry.route));
    for (const route of [
      'POST /api/push/apns', 'POST /api/push/apns/unregister', 'POST /api/push/apns/status',
      'POST /api/push/live-activity', 'POST /api/push/live-activity/end', 'POST /api/term',
      'POST /api/sessions/{id}/answers/{qId}', 'PUT /api/notes', 'POST /api/sessions/{id}/restart',
      'POST /api/pair', 'POST /api/sessions', 'POST /api/sessions/{id}/model',
      'POST /api/sessions/{id}/companion/ask', 'POST /api/companion/token', 'POST /api/companion/speech-token',
      'POST /api/fs/mkdir', 'POST /api/sessions/{id}/messages', 'POST /api/sessions/{id}/seen',
      'POST /api/inbox/{id}/remove',
    ]) {
      expect(routes.has(route), route).toBe(true);
    }
  });
});

describe('złote ciała żądań: plik → schemat serwera', () => {
  it.each(entries)('%s', (name, entry) => {
    const stored = read(name);
    const schema = SCHEMAS[entry.schema];
    expect(schema?.parse(stored)).toEqual(stored);
  });

  it('rejestracja APNs apki deklaruje klucze lokalizacji `locKeys: true`; inna wartość niż boolean nie przechodzi', () => {
    const registrations = entries.filter(([, entry]) => entry.schema === 'apnsRegisterBody');
    expect(registrations.map(([name]) => name)).toEqual(['apns.register.json', 'apns.register.test.json']);
    for (const [name] of registrations) {
      const stored = read(name) as Record<string, unknown>;
      expect(stored['locKeys'], name).toBe(true);
      for (const locKeys of ['yes', 1, null]) {
        expect(apnsRegisterBodySchema.safeParse({ ...stored, locKeys }).success, `${name} ${String(locKeys)}`).toBe(false);
      }
      const { locKeys: _declared, ...undeclared } = stored;
      void _declared;
      expect(apnsRegisterBodySchema.parse(undeclared)).toEqual(undeclared);
      expect(apnsRegisterBodySchema.parse({ ...stored, locKeys: false })).toEqual({ ...stored, locKeys: false });
    }
  });
});
