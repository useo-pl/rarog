/**
 * Rejestr zdań serwera (`shared/src/sentences/`): reguły `say()`, marki pochodzenia tekstu (`ServerSentence`,
 * `ForeignText`), spójność rejestru (placeholdery = argumenty, rodzaje, wzorzec kodu, obszar = plik,
 * `RETIRED` rozłączne z `SENTENCES`, angielskie szablony), kształt `ref` na drucie i model generatora
 * `scripts/sentences-catalog.mjs`. Reguły `say()` sprawdza fabryka z rejestrem testowym, a produkcyjny `say()`
 * przypadki z pierwszych zdań kanałów.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  RETIRED,
  SENTENCES,
  SENTENCE_AREAS,
  createSay,
  foreign,
  isAnyText,
  isForeignText,
  isServerSentence,
  registryProblems,
  say,
  sentenceRefSchema,
  textOf,
  type ForeignText,
  type OwnText,
  type RetiredSentenceArea,
  type SentenceArea,
  type SentenceRef,
  type ServerSentence,
} from '@rarog/shared/sentences';
import { buildModel, formatModel } from '../../scripts/sentences-catalog.mjs';
import { polski } from './polski-tekst.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SENTENCES_DIR = path.join(REPO, 'shared/src/sentences');

const TEST_SENTENCES = {
  'uploads.too-many-images': { en: 'At most {max} images per message.', args: ['max:int'] },
  'uploads.images': { en: { one: 'One image attached.', other: '{count} images attached.' }, args: ['count:plural'] },
  'session.renamed': { en: 'Session renamed to {label}.', args: ['label:text'] },
  'state.limit-reached': { en: 'Plan limit reached; resets at {resetAt}.', args: ['resetAt:instant'] },
  'model.mode-plan': { en: 'plan mode' },
  'model.mode-changed': { en: 'Switched to {mode} after {turns} turns.', args: ['mode:code', 'turns:int'] },
  'rest.ready': { en: 'Ready.' },
  'rest.nine': {
    en: '{a}{b}{c}{d}{e}{f}{g}{h}{i}',
    args: ['a:text', 'b:text', 'c:text', 'd:text', 'e:text', 'f:text', 'g:text', 'h:text', 'i:text'],
  },
} as const satisfies SentenceArea;

const TEST_RETIRED = {
  'rest.old-ready': { en: 'Ready (old).', since: '0.1.0' },
} as const satisfies RetiredSentenceArea;

const testSay = createSay(TEST_SENTENCES, TEST_RETIRED);

/** Wywołanie z pominięciem typów: sprawdza obronę w czasie wykonania (dane spoza kompilatora). */
const sayUntyped = testSay as unknown as (code: string, args?: unknown) => ServerSentence;

describe('say(): render angielskiego szablonu i ref', () => {
  it('int: łańcuch dziesiętny w tekście i w ref.args', () => {
    const s = testSay('uploads.too-many-images', { max: 4 });
    expect(s.text).toBe('At most 4 images per message.');
    expect(s.ref).toEqual({ code: 'uploads.too-many-images', args: ['4'] });
    expect(testSay('uploads.too-many-images', { max: -0 }).ref.args).toEqual(['0']);
    expect(testSay('uploads.too-many-images', { max: 2n ** 63n - 1n }).ref.args).toEqual(['9223372036854775807']);
    expect(testSay('uploads.too-many-images', { max: -(2n ** 63n) }).ref.args).toEqual(['-9223372036854775808']);
  });

  it('int: poza Int64, ułamek, NaN, liczba niebezpieczna i łańcuch rzucają', () => {
    for (const max of [2n ** 63n, -(2n ** 63n) - 1n, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, '4', null]) {
      expect(() => sayUntyped('uploads.too-many-images', { max }), String(max)).toThrow(/must be an integer/u);
    }
  });

  it('plural: wariant one albo other według liczby, liczba w ref jak int', () => {
    expect(testSay('uploads.images', { count: 1 }).text).toBe('One image attached.');
    expect(testSay('uploads.images', { count: 1 }).ref).toEqual({ code: 'uploads.images', args: ['1'] });
    expect(testSay('uploads.images', { count: 0 }).text).toBe('0 images attached.');
    expect(testSay('uploads.images', { count: 2n }).text).toBe('2 images attached.');
    expect(() => sayUntyped('uploads.images', { count: 1.5 })).toThrow(/must be an integer/u);
  });

  it('text: łańcuch i tekst obcy bez zmian, także z klamrami; inny typ rzuca', () => {
    expect(testSay('session.renamed', { label: 'api {x}' }).text).toBe('Session renamed to api {x}.');
    const s = testSay('session.renamed', { label: foreign('zadanie') });
    expect(s.text).toBe('Session renamed to zadanie.');
    expect(s.ref.args).toEqual(['zadanie']);
    expect(() => sayUntyped('session.renamed', { label: 7 })).toThrow(/must be text/u);
    expect(() => sayUntyped('session.renamed', { label: testSay('rest.ready') })).toThrow(/must be text/u);
  });

  it('instant: Date jako ISO 8601, łańcuch ISO bez zmian; reszta rzuca', () => {
    const at = new Date(Date.UTC(2026, 10, 6, 12, 30, 0));
    expect(testSay('state.limit-reached', { resetAt: at }).ref.args).toEqual(['2026-11-06T12:30:00.000Z']);
    expect(testSay('state.limit-reached', { resetAt: '2026-11-06T13:30:00+01:00' }).text)
      .toBe('Plan limit reached; resets at 2026-11-06T13:30:00+01:00.');
    expect(testSay('state.limit-reached', { resetAt: '2024-02-29T23:59:59.5Z' }).ref.args)
      .toEqual(['2024-02-29T23:59:59.5Z']);
    // Data spoza kalendarza i godzina 24:00 też rzucają, choć `Date.parse` je przyjmuje.
    for (const resetAt of ['jutro', '2026-11-06', '2026-13-45T99:99:00Z', new Date(Number.NaN), 1_762_430_000,
      '2026-02-30T10:00:00Z', '2026-02-29T10:00:00Z', '2026-04-31T00:00Z', '2026-01-01T24:00Z',
      '2026-01-01T10:00:00+24:00']) {
      expect(() => sayUntyped('state.limit-reached', { resetAt }), String(resetAt)).toThrow(/ISO 8601/u);
    }
  });

  it('code: podkod bez argumentów; w tekście jego en, w ref sam kod; argumenty w kolejności deklaracji', () => {
    const s = testSay('model.mode-changed', { turns: 3, mode: 'model.mode-plan' });
    expect(s.text).toBe('Switched to plan mode after 3 turns.');
    expect(s.ref).toEqual({ code: 'model.mode-changed', args: ['model.mode-plan', '3'] });
  });

  it('code: podkod z argumentami, nieznany, wycofany albo nie-łańcuch rzuca', () => {
    for (const mode of ['uploads.too-many-images', 'uploads.images', 'model.nope', 'rest.old-ready', 7]) {
      expect(() => sayUntyped('model.mode-changed', { mode, turns: 1 }), String(mode))
        .toThrow(/code without arguments/u);
    }
  });

  it('zdanie bez argumentów: ref bez pola args', () => {
    const s = testSay('rest.ready');
    expect(s.text).toBe('Ready.');
    expect(s.ref).toStrictEqual({ code: 'rest.ready' });
    expect(Object.keys(s.ref)).toEqual(['code']);
    expect(testSay('rest.ready', {}).ref).toStrictEqual({ code: 'rest.ready' });
  });

  it('kod nieznany, wycofany i nie-łańcuch rzuca', () => {
    expect(() => sayUntyped('rest.nope')).toThrow(/unknown code/u);
    expect(() => sayUntyped('rest.old-ready')).toThrow(/retired since 0\.1\.0/u);
    expect(() => sayUntyped('toString')).toThrow(/unknown code/u);
    expect(() => sayUntyped(7 as unknown as string)).toThrow(/code must be a string/u);
  });

  it('brakujący, nadmiarowy i nieobiektowy argument rzuca', () => {
    expect(() => sayUntyped('uploads.too-many-images')).toThrow(/missing argument max/u);
    expect(() => sayUntyped('uploads.too-many-images', {})).toThrow(/missing argument max/u);
    expect(() => sayUntyped('uploads.too-many-images', { max: undefined })).toThrow(/missing argument max/u);
    expect(() => sayUntyped('uploads.too-many-images', { max: 1, extra: 2 })).toThrow(/unexpected argument extra/u);
    expect(() => sayUntyped('rest.ready', { x: 1 })).toThrow(/unexpected argument x/u);
    expect(() => sayUntyped('uploads.too-many-images', [4])).toThrow(/must be an object/u);
    expect(() => sayUntyped('uploads.too-many-images', 4)).toThrow(/must be an object/u);
  });

  it('ponad 8 argumentów rzuca', () => {
    const args = Object.fromEntries('abcdefghi'.split('').map((name) => [name, name]));
    expect(() => sayUntyped('rest.nine', args)).toThrow(/more than 8 arguments/u);
  });

  it('ref z say() przechodzi sentenceRefSchema', () => {
    for (const s of [testSay('rest.ready'), testSay('model.mode-changed', { mode: 'model.mode-plan', turns: 2 })]) {
      expect(sentenceRefSchema.parse(s.ref)).toEqual(s.ref);
    }
  });

  it('produkcyjny say: kod spoza rejestru jest nieznany', () => {
    expect(() => (say as unknown as (code: string) => ServerSentence)('rest.anything')).toThrow(/unknown code/u);
  });
});

describe('produkcyjny say: pierwsze zdania kanałów', () => {
  it('zdanie bez argumentów: angielski tekst, ref bez args', () => {
    const s = say('rest.bad-request');
    expect(s.text).toBe('Request rejected.');
    expect(s.ref).toStrictEqual({ code: 'rest.bad-request' });
    expect(say('push.chime.title').text).toBe('Agent finished');
  });

  it('session.fallback-label: numer jako int', () => {
    const s = say('session.fallback-label', { n: 3 });
    expect(s.text).toBe('session 3');
    expect(s.ref.args).toEqual(['3']);
  });

  it('transcript.truncation-footer: liczba mnoga według cut', () => {
    expect(say('transcript.truncation-footer', { cut: 1 }).text).toBe('\n… (1 character cut off)');
    expect(say('transcript.truncation-footer', { cut: 5 }).text).toBe('\n… (5 characters cut off)');
  });

  it('state.limit-reached: chwila resetu ISO 8601 w tekście', () => {
    expect(say('state.limit-reached', { reset: '2026-11-12T10:00:00Z' }).text)
      .toBe('Plan limit reached. Try again after 2026-11-12T10:00:00Z.');
  });
});

describe('marki pochodzenia tekstu', () => {
  it('strażniki typu rozpoznają tylko obiekty z fabryk', () => {
    const s = testSay('rest.ready');
    const f = foreign('ekran');
    expect([isServerSentence(s), isForeignText(s), isAnyText(s)]).toEqual([true, false, true]);
    expect([isServerSentence(f), isForeignText(f), isAnyText(f)]).toEqual([false, true, true]);
    for (const fake of ['Ready.', { text: 'Ready.', ref: { code: 'rest.ready' } }, { ...s, text: 'Inne.' }, { ...f }, null,
      undefined, 7]) {
      expect(isAnyText(fake), JSON.stringify(fake)).toBe(false);
    }
  });

  it('textOf zwraca tekst każdej formy; podróbka rzuca', () => {
    expect(textOf(testSay('rest.ready'))).toBe('Ready.');
    expect(textOf(foreign('ekran'))).toBe('ekran');
    expect(() => textOf({ text: 'x' } as unknown as ForeignText)).toThrow(TypeError);
  });

  it('foreign przyjmuje tylko łańcuch', () => {
    expect(() => foreign(7 as unknown as string)).toThrow(TypeError);
    expect(() => foreign(undefined as unknown as string)).toThrow(TypeError);
  });

  it('obiekty są zamrożone, a marka nie wychodzi w JSON', () => {
    const s = testSay('uploads.too-many-images', { max: 2 });
    expect(Object.isFrozen(s) && Object.isFrozen(s.ref) && Object.isFrozen(s.ref.args)).toBe(true);
    expect(Object.isFrozen(foreign('x'))).toBe(true);
    expect(JSON.parse(JSON.stringify(s))).toEqual({ text: 'At most 2 images per message.',
      ref: { code: 'uploads.too-many-images', args: ['2'] } });
    expect(JSON.stringify(foreign('x'))).toBe('{"text":"x"}');
  });

  it('typy: gołego łańcucha ani ręcznego obiektu nie da się podać jako zdania', () => {
    // @ts-expect-error goły łańcuch to nie zdanie
    const a: ServerSentence = 'Ready.';
    // @ts-expect-error ręcznie złożony obiekt nie ma marki
    const b: ServerSentence = { text: 'Ready.', ref: { code: 'rest.ready' } };
    // @ts-expect-error goły łańcuch to nie tekst własny
    const c: OwnText = 'Sesja wystartowała.';
    // @ts-expect-error tekst obcy to nie tekst własny
    const d: OwnText = foreign('ekran');
    // @ts-expect-error tekst obcy to nie zdanie z kodem
    const e: ServerSentence = foreign('ekran');
    // @ts-expect-error goły łańcuch to nie tekst obcy
    const f: ForeignText = 'ekran';
    // @ts-expect-error ręczny obiekt to nie tekst obcy
    const g: ForeignText = { text: 'x' };
    expect([a, b, c, d, e, f, g]).toHaveLength(7);
    expectTypeOf<OwnText>().toEqualTypeOf<ServerSentence>();
    expectTypeOf(testSay('rest.ready')).toExtend<OwnText>();
  });

  it('typy: say() przyjmuje tylko kod z rejestru i argumenty według deklaracji', () => {
    const calls = [
      // @ts-expect-error kod spoza rejestru
      () => testSay('rest.nope'),
      // @ts-expect-error kod wycofany
      () => testSay('rest.old-ready'),
      // @ts-expect-error brak argumentów
      () => testSay('uploads.too-many-images'),
      // @ts-expect-error int to liczba, nie łańcuch
      () => testSay('uploads.too-many-images', { max: '4' }),
      // @ts-expect-error nadmiarowy argument
      () => testSay('uploads.too-many-images', { max: 4, extra: 1 }),
      // @ts-expect-error argument code to kod bez argumentów z rejestru
      () => testSay('model.mode-changed', { mode: 'uploads.too-many-images', turns: 1 }),
      // @ts-expect-error zdanie bez argumentów nie przyjmuje argumentów
      () => testSay('rest.ready', { x: 1 }),
      // @ts-expect-error produkcyjny rejestr nie zna kodu
      () => say('rest.anything'),
    ];
    for (const call of calls) expect(call).toThrow();
  });
});

describe('spójność rejestru produkcyjnego', () => {
  // Szerokie typy: pętle działają na każdym kształcie rejestru, także na pustym obszarze.
  const areas: Readonly<Record<string, SentenceArea>> = SENTENCE_AREAS;
  const sentences: SentenceArea = SENTENCES;
  const retired: RetiredSentenceArea = RETIRED;
  const codes = Object.keys(sentences);

  it('registryProblems nie zgłasza niczego', () => {
    expect(registryProblems(sentences, retired)).toEqual([]);
  });

  it('obszar = plik: pliki obszarów to dokładnie SENTENCE_AREAS, każdy kod ma prefiks swojego obszaru', () => {
    const files = readdirSync(SENTENCES_DIR).filter((file) => file !== 'index.ts').sort();
    expect(files).toEqual(Object.keys(areas).map((area) => `${area}.ts`).sort());
    for (const [area, entries] of Object.entries(areas)) {
      for (const code of Object.keys(entries)) expect(code.startsWith(`${area}.`), code).toBe(true);
    }
    const merged = Object.values(areas).reduce((sum, entries) => sum + Object.keys(entries).length, 0);
    expect(codes).toHaveLength(merged);
  });

  it('wycofane kody: prefiks obszaru z rejestru, rozłączne z emitowanymi', () => {
    for (const code of Object.keys(retired)) {
      expect(Object.hasOwn(sentences, code), code).toBe(false);
      expect(Object.keys(areas).some((area) => code.startsWith(`${area}.`)), code).toBe(true);
    }
  });

  it('szablony en bez polskiego tekstu', () => {
    const polish = [...Object.entries(sentences), ...Object.entries(retired)].flatMap(([code, def]) =>
      (typeof def.en === 'string' ? [def.en] : [def.en.one, def.en.other])
        .filter((template) => polski(template, false)).map((template) => `${code}: ${template}`));
    expect(polish).toEqual([]);
  });
});

describe('registryProblems wykrywa błędy rejestru', () => {
  const problems = (sentences: Readonly<Record<string, unknown>>, retired: Readonly<Record<string, unknown>> = {}) =>
    registryProblems(sentences as SentenceArea, retired as RetiredSentenceArea);

  it('rejestr testowy poza zdaniem z 9 argumentami jest poprawny', () => {
    expect(problems(TEST_SENTENCES, TEST_RETIRED)).toEqual(['rest.nine: more than 8 arguments']);
  });

  it.each([
    ['placeholder bez deklaracji', { 'rest.a': { en: 'Hi {name}.' } }, /undeclared placeholders name/u],
    ['argument bez placeholdera', { 'rest.a': { en: 'Hi.', args: ['name:text'] } }, /missing from the template name/u],
    ['nieznany rodzaj', { 'rest.a': { en: '{n}', args: ['n:float'] } }, /bad argument declaration/u],
    ['nazwa spoza camelCase', { 'rest.a': { en: '{N}', args: ['N:int'] } }, /bad argument declaration/u],
    ['powtórzony argument', { 'rest.a': { en: '{n}', args: ['n:int', 'n:text'] } }, /duplicate argument n/u],
    ['pusta lista args', { 'rest.a': { en: 'Hi.', args: [] } }, /empty args list/u],
    ['kod bez obszaru', { ready: { en: 'Ready.' } }, /kebab-case/u],
    ['kod w camelCase', { 'push.body.detailAndLabel': { en: 'x' } }, /kebab-case/u],
    ['kod z podkreśleniem', { 'rest.not_found': { en: 'x' } }, /kebab-case/u],
    ['pusty szablon', { 'rest.a': { en: ' ' } }, /non-empty string/u],
    ['klamra poza placeholderem', { 'rest.a': { en: 'Use {} here.' } }, /stray brace/u],
    ['plural bez szablonu one/other', { 'rest.a': { en: '{n} items', args: ['n:plural'] } }, /needs a \{ one, other \}/u],
    ['szablon one/other bez plural', { 'rest.a': { en: { one: 'x', other: 'y {n}' }, args: ['n:int'] } },
      /exactly one plural argument/u],
    ['dwa plural', { 'rest.a': { en: { one: '{a}{b}', other: '{a}{b}' }, args: ['a:plural', 'b:plural'] } },
      /more than one plural/u],
    ['other bez innego argumentu', { 'rest.a': { en: { one: 'One in {p}.', other: 'Many.' },
      args: ['n:plural', 'p:text'] } }, /other: arguments missing from the template p/u],
    ['one bez innego argumentu', { 'rest.a': { en: { one: 'One.', other: '{n} in {p}.' },
      args: ['n:plural', 'p:text'] } }, /one: arguments missing from the template p/u],
  ])('%s', (_name, sentences, expected) => {
    expect(problems(sentences).join('\n')).toMatch(expected);
  });

  it('wariant może pominąć argument plural: liczba tylko w other albo sam wybór formy', () => {
    expect(problems({ 'rest.a': { en: { one: 'One in {p}.', other: '{n} in {p}.' }, args: ['n:plural', 'p:text'] } }))
      .toEqual([]);
    expect(problems({ 'rest.a': { en: { one: '{p}, which is blocked.', other: '{p}, none of which is allowed.' },
      args: ['p:text', 'n:plural'] } })).toEqual([]);
  });

  it('kod naraz emitowany i wycofany, since spoza wersji', () => {
    expect(problems({ 'rest.a': { en: 'A.' } }, { 'rest.a': { en: 'A.', since: '0.1.0' } }))
      .toEqual(['rest.a: both in SENTENCES and in RETIRED']);
    expect(problems({}, { 'rest.b': { en: 'B.', since: '2026-11-06' } }))
      .toEqual(['rest.b: since must be a server version (x.y.z)']);
  });
});

describe('sentenceRefSchema (ref na drucie)', () => {
  it('przyjmuje kod z argumentami i bez', () => {
    expect(sentenceRefSchema.parse({ code: 'rest.ready' })).toEqual({ code: 'rest.ready' });
    const eight = Array.from({ length: 8 }, (_, i) => String(i));
    expect(sentenceRefSchema.parse({ code: 'rest.x', args: eight })).toEqual({ code: 'rest.x', args: eight });
  });

  it.each([
    ['null', null],
    ['pusty kod', { code: '' }],
    ['brak kodu', { args: ['1'] }],
    ['9 argumentów', { code: 'rest.x', args: Array.from({ length: 9 }, (_, i) => String(i)) }],
    ['argument liczbą', { code: 'rest.x', args: [1] }],
    ['argument null', { code: 'rest.x', args: [null] }],
    ['args null', { code: 'rest.x', args: null }],
    ['kod liczbą', { code: 7 }],
  ])('odrzuca: %s', (_name, value) => {
    expect(sentenceRefSchema.safeParse(value).success).toBe(false);
  });

  it('typ ze schematu zgadza się z SentenceRef', () => {
    expectTypeOf<z.infer<typeof sentenceRefSchema>>().toEqualTypeOf<SentenceRef>();
  });
});

describe('scripts/sentences-catalog.mjs: model z rejestru', () => {
  it('model: kody emitowane i wycofane posortowane po kodzie, argumenty z rodzajami, stała kolejność kluczy', () => {
    const model = buildModel({ SENTENCES: TEST_SENTENCES, RETIRED: TEST_RETIRED });
    expect(model.sentences.map((one) => one.code)).toEqual([
      'model.mode-changed', 'model.mode-plan', 'rest.nine', 'rest.old-ready', 'rest.ready', 'session.renamed',
      'state.limit-reached', 'uploads.images', 'uploads.too-many-images',
    ]);
    expect(model.sentences.find((one) => one.code === 'model.mode-changed')).toEqual({
      code: 'model.mode-changed', args: [{ name: 'mode', kind: 'code' }, { name: 'turns', kind: 'int' }],
      en: 'Switched to {mode} after {turns} turns.', retired: null,
    });
    expect(model.sentences.find((one) => one.code === 'rest.old-ready')?.retired).toBe('0.1.0');
    expect(Object.keys(model.sentences[0] ?? {})).toEqual(['code', 'args', 'en', 'retired']);
    // Ta sama treść w innej kolejności wpisów daje identyczny tekst modelu.
    const reversed = Object.fromEntries(Object.entries(TEST_SENTENCES).reverse()) as SentenceArea;
    expect(formatModel(buildModel({ SENTENCES: reversed, RETIRED: TEST_RETIRED })))
      .toBe(formatModel(model));
  });

  const run = (args: string[]) => spawnSync(process.execPath, [path.join(REPO, 'scripts/sentences-catalog.mjs'), ...args],
    { cwd: REPO, encoding: 'utf8', timeout: 60_000 });

  // `--write` i `--publish` zmieniają pliki repo, więc ich przypadki idą w korzeniu tymczasowym (`sentences-catalog.test.ts`).
  it('komenda: bez flagi model rejestru produkcyjnego, --check kod 0, zła flaga kod 2', () => {
    const plain = run([]);
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.stdout).toBe(formatModel(buildModel({ SENTENCES, RETIRED })));
    const check = run(['--check']);
    expect(check.status, check.stderr).toBe(0);
    expect(check.stdout).toMatch(/^sentences-catalog: registry ok/u);
    expect(run(['--bogus']).status).toBe(2);
    expect(run(['--check', '--write']).status).toBe(2);
  }, 60_000);
});
