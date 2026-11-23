/**
 * Złote ramki terminala apki natywnej, strona KONTRAKTU: pliki
 * `shared/fixtures/term/` → schematy `termClientFrameSchema` i `termServerFrameSchema`.
 *
 * Ramki serwera produkuje kod: gniazdo WS serwera (`server/test/term-fixtures-producenci.test.ts`).
 * Ramki klienta (`client.*.json`) i wektory cięcia (`chunk-vectors.json`) są ZAMROŻONĄ specyfikacją
 * bez producenta: zmiana chunkera to ręczna
 * zmiana pliku i testu Swift w jednym commicie. Ten plik celowo nie importuje niczego z `server/`:
 * to lustro dla klienta w innym języku (Swift: `TerminalFramesTests` w `RarogContract`, wektory
 * w `RarogTransport`).
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  TERM_MAX_INPUT_BYTES, TERM_MAX_PASTE_BYTES, termClientFrameSchema, termServerFrameSchema,
} from '../src/protocol.ts';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/term');
const MANIFEST = 'manifest.json';

const entrySchema = z.discriminatedUnion('kind', [
  /** Ramka klienta: typ i długość GOTOWEJ ramki na drucie w bajtach UTF-8 (to, co liczy budżet). */
  z.strictObject({ kind: z.literal('client'), t: z.string(), wireBytes: z.number().int().positive() }),
  z.strictObject({ kind: z.literal('server'), t: z.string() }),
  z.strictObject({ kind: z.literal('chunk-vectors') }),
]);

const manifest = z.record(z.string(), entrySchema)
  .parse(JSON.parse(readFileSync(path.join(DIR, MANIFEST), 'utf8')));
const entries = Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b));
const read = (name: string): unknown => JSON.parse(readFileSync(path.join(DIR, name), 'utf8')) as unknown;

/** Polska litera w `msg` obok `msgRef`: zdanie z kodem jest angielskie. */
const POLISH_LETTER = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/u;

/**
 * Pola tekstu z parą `…Ref` w ramkach serwera (`<t>/<pole>`). Każde to zdanie własne serwera (strażnik „pole
 * z tekstem ma `ref`”, ta sama reguła co w złotych plikach REST i SSE): bez pary jest błędem.
 */
const TEXT_FIELDS: readonly string[] = ['err/msg'];

/** Pola z {@link TEXT_FIELDS}, które ramka niesie bez `…Ref` (pusta lista = zgodne). */
function refProblems(frame: Record<string, unknown>): string[] {
  return TEXT_FIELDS.filter((field) => field.startsWith(`${String(frame.t)}/`))
    .map((field) => field.slice(field.indexOf('/') + 1))
    .filter((key) => typeof frame[key] === 'string' && frame[`${key}Ref`] === undefined)
    .map((key) => `/${key}: zdanie własne bez ${key}Ref`);
}

/** Wektory cięcia — kształt pliku, który czyta też test Swift. */
const vectorsSchema = z.strictObject({
  maxFrameBytes: z.number().int(),
  frameOverheadBytes: z.number().int(),
  cases: z.array(z.strictObject({
    name: z.string().min(1),
    max: z.number().int().positive(),
    input: z.string().optional(),
    repeat: z.strictObject({ unit: z.string().min(1), count: z.number().int().positive() }).optional(),
    inputUtf16: z.array(z.number().int()).optional(),
    utf16Only: z.literal(true).optional(),
    chunks: z.array(z.string()).optional(),
    chunkScalars: z.array(z.number().int().positive()).optional(),
    chunksUtf16: z.array(z.array(z.number().int())).optional(),
    frameBytes: z.array(z.number().int().positive()),
  })).min(1),
  maxPasteBytes: z.number().int(),
  /** Wklejka: ramki `pa` z `pasteFrames`; `refused` = ponad sufit, nic nie wychodzi. */
  paste: z.array(z.strictObject({
    name: z.string().min(1),
    max: z.number().int().positive(),
    input: z.string().optional(),
    repeat: z.strictObject({ unit: z.string().min(1), count: z.number().int().positive() }).optional(),
    refused: z.literal(true).optional(),
    chunks: z.array(z.string()).optional(),
    chunkScalars: z.array(z.number().int().positive()).optional(),
    frameBytes: z.array(z.number().int().positive()).optional(),
    ends: z.array(z.boolean()).optional(),
  })).min(1),
});

describe('złote ramki terminala: manifest i pliki', () => {
  it('manifest ↔ katalog w obie strony', () => {
    const files = readdirSync(DIR).filter((name) => name !== MANIFEST).sort();
    expect(files).toEqual(entries.map(([name]) => name));
  });

  it('każdy typ ramki z kontraktu ma złoty plik', () => {
    const covered = (kind: 'client' | 'server'): string[] => entries
      .flatMap(([, entry]) => (entry.kind === kind ? [entry.t] : [])).sort();
    const variants = (schema: typeof termClientFrameSchema | typeof termServerFrameSchema): string[] =>
      schema.options.map((option) => option.shape.t.value).sort();
    expect([...new Set(covered('client'))]).toEqual(variants(termClientFrameSchema));
    expect([...new Set(covered('server'))]).toEqual(variants(termServerFrameSchema));
  });

  it('ramka `err` ze zdaniem z kodem (`msgRef`) ma złoty plik', () => {
    const withRef = entries.filter(([name, entry]) => entry.kind === 'server' && entry.t === 'err'
      && (read(name) as { msgRef?: unknown }).msgRef !== undefined);
    expect(withRef.length).toBeGreaterThan(0);
  });

  it('tekst obok zdania z kodem nie jest po polsku (zdanie serwera jest angielskie)', () => {
    for (const [name, entry] of entries) {
      if (entry.kind !== 'server') continue;
      const frame = read(name) as { msg?: unknown; msgRef?: unknown };
      if (frame.msgRef === undefined) continue;
      expect(typeof frame.msg === 'string' && POLISH_LETTER.test(frame.msg), name).toBe(false);
    }
  });
});

describe('złote ramki terminala: pole z tekstem ma `ref`', () => {
  it('lista pól = pola z parą `…Ref` w schemacie ramek serwera', () => {
    const fromSchema = termServerFrameSchema.options.flatMap((option) => Object.keys(option.shape)
      .filter((key) => key.endsWith('Ref')).map((key) => `${option.shape.t.value}/${key.slice(0, -3)}`));
    expect(fromSchema.sort()).toEqual([...TEXT_FIELDS].sort());
  });

  it('każda ramka serwera: zdanie własne niesie `…Ref`', () => {
    const problems = entries.filter(([, entry]) => entry.kind === 'server')
      .flatMap(([name]) => refProblems(read(name) as Record<string, unknown>).map((problem) => `${name} ${problem}`));
    expect(problems).toEqual([]);
  });

  it('kopia ramki `err` bez `msgRef` → czerwony', () => {
    const frame = structuredClone(read('server.err.json')) as Record<string, unknown>;
    expect(refProblems(frame)).toEqual([]);
    delete frame.msgRef;
    expect(refProblems(frame)).toEqual(['/msg: zdanie własne bez msgRef']);
  });
});

describe('złote ramki terminala: plik → schemat', () => {
  it.each(entries.filter(([, entry]) => entry.kind === 'client'))('%s', (name, entry) => {
    const frame = read(name);
    // Ścisły schemat bez strat: ramka z polem spoza kontraktu przewraca test.
    expect(termClientFrameSchema.parse(frame)).toEqual(frame);
    expect((frame as { t: string }).t).toBe(entry.kind === 'client' ? entry.t : '');
    const wire = Buffer.byteLength(JSON.stringify(frame), 'utf8');
    expect(wire).toBe(entry.kind === 'client' ? entry.wireBytes : 0);
    expect(wire).toBeLessThanOrEqual(TERM_MAX_INPUT_BYTES);
  });

  it.each(entries.filter(([, entry]) => entry.kind === 'server'))('%s', (name, entry) => {
    const frame = read(name);
    expect(termServerFrameSchema.parse(frame)).toEqual(frame);
    expect((frame as { t: string }).t).toBe(entry.kind === 'server' ? entry.t : '');
  });
});

describe('wektory cięcia wejścia', () => {
  const vectors = vectorsSchema.parse(read('chunk-vectors.json'));

  it('sufit ramki to `TERM_MAX_INPUT_BYTES`, narzut to pusta ramka `in`', () => {
    expect(vectors.maxFrameBytes).toBe(TERM_MAX_INPUT_BYTES);
    expect(vectors.frameOverheadBytes).toBe(Buffer.byteLength(JSON.stringify({ t: 'in', d: '' }), 'utf8'));
  });

  it('wklejka: sufit `TERM_MAX_PASTE_BYTES`, ramki ≤ 8 KiB, `e: true` tylko na ostatniej, odmowa ponad sufit', () => {
    expect(vectors.maxPasteBytes).toBe(TERM_MAX_PASTE_BYTES);
    for (const entry of vectors.paste) {
      const input = entry.input ?? (entry.repeat === undefined ? '' : entry.repeat.unit.repeat(entry.repeat.count));
      const bytes = Buffer.byteLength(input, 'utf8');
      if (entry.refused === true) {
        expect(bytes, entry.name).toBeGreaterThan(TERM_MAX_PASTE_BYTES);
        expect(entry.frameBytes, entry.name).toBeUndefined();
        continue;
      }
      expect(bytes, entry.name).toBeLessThanOrEqual(TERM_MAX_PASTE_BYTES);
      const frames = entry.frameBytes ?? [];
      expect(entry.ends, entry.name).toEqual(frames.map((_, index) => index === frames.length - 1));
      for (const size of frames) expect(size, entry.name).toBeLessThanOrEqual(TERM_MAX_INPUT_BYTES);
      if (entry.chunks !== undefined) {
        expect(entry.chunks.join(''), entry.name).toBe(input);
        expect(entry.chunks.map((chunk, index) => Buffer.byteLength(
          JSON.stringify({ t: 'pa', d: chunk, e: index === frames.length - 1 }), 'utf8',
        )), entry.name).toEqual(frames);
      } else {
        expect(entry.chunkScalars?.reduce((sum, n) => sum + n, 0), entry.name).toBe([...input].length);
      }
    }
  });

  it.each(vectors.cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    // Dokładnie jedna postać wejścia i jedna postać wyniku, zgodne ze sobą.
    const forms = [entry.input, entry.repeat, entry.inputUtf16].filter((form) => form !== undefined);
    expect(forms).toHaveLength(1);
    if (entry.repeat !== undefined) {
      expect(entry.chunkScalars?.reduce((sum, n) => sum + n, 0))
        .toBe([...entry.repeat.unit].length * entry.repeat.count);
      expect(entry.chunkScalars).toHaveLength(entry.frameBytes.length);
    } else if (entry.inputUtf16 !== undefined) {
      expect(entry.utf16Only).toBe(true);
      expect(entry.chunksUtf16?.flat()).toEqual(entry.inputUtf16);
      expect(entry.chunksUtf16).toHaveLength(entry.frameBytes.length);
    } else {
      expect(entry.chunks?.join('')).toBe(entry.input);
      expect(entry.chunks?.map((chunk) => Buffer.byteLength(JSON.stringify({ t: 'in', d: chunk }), 'utf8')))
        .toEqual(entry.frameBytes);
    }
    // Sufit przekracza wyłącznie ramka z JEDNYM znakiem (podłoga: lepiej znak na ramkę niż pętla).
    const sizes = entry.chunkScalars ?? entry.chunksUtf16?.map((units) => units.length)
      ?? entry.chunks?.map((chunk) => [...chunk].length) ?? [];
    entry.frameBytes.forEach((bytes, index) => {
      if ((sizes[index] ?? 0) > 1) expect(bytes).toBeLessThanOrEqual(entry.max);
    });
  });
});
