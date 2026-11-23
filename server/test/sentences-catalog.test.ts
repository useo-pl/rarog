/**
 * Generator katalogu zdań serwera (`scripts/sentences-catalog.mjs`): katalog `server.*`/`push.*`
 * RarogContract z `en` z rejestru i `pl` z katalogu albo z wsadu `--pl`, deskryptory argumentów Swift, `--write`
 * deterministyczny i `--check` z kodem 1 przy każdej niezgodności. Przypadki idą na rejestrze testowym i w korzeniu
 * tymczasowym (`main` z opcjami `root` i `registry`); na końcu `--check` na prawdziwym repo. Zgodność katalogu
 * w repo z rejestrem pilnuje też lustro `shared/test/sentences-catalog-lustro.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { registryProblems, type RetiredSentenceArea, type SentenceArea } from '@rarog/shared/sentences';
import {
  CATALOG_PATH,
  DESCRIPTORS_PATH,
  PUBLISHED_PATH,
  buildCatalog,
  buildDescriptors,
  buildModel,
  catalogKey,
  formatCatalog,
  main,
  outputProblems,
  plProblems,
  publishedProblems,
  type Catalog,
  type CatalogNode,
  type PlTemplate,
  type PublishedManifest,
  type Registry,
} from '../../scripts/sentences-catalog.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const TEST_SENTENCES = {
  'rest.bad-request': { en: 'Request rejected.' },
  'session.fallback-label': { en: 'session {n}', args: ['n:int'] },
  'model.moved': { en: 'Moved {from} to {to}.', args: ['from:text', 'to:text'] },
  'transcript.truncation-footer': {
    en: { one: '\n… ({cut} character cut off)', other: '\n… ({cut} characters cut off)' },
    args: ['cut:plural'],
  },
  'push.chime.title': { en: 'Agent finished' },
  'state.load': { en: 'Load {n}% now.', args: ['n:int'] },
  'state.full': { en: '100% done' },
} as const satisfies SentenceArea;

const TEST_RETIRED = { 'rest.old-ready': { en: 'Ready (old).', since: '0.1.0' } } as const satisfies RetiredSentenceArea;

const TEST_PL: Record<string, PlTemplate> = {
  'rest.bad-request': 'Żądanie odrzucone.',
  'session.fallback-label': 'sesja {n}',
  'model.moved': 'Do {to} przeniesiono {from}.',
  'transcript.truncation-footer': {
    one: '\n… (ucięto {cut} znak)', few: '\n… (ucięto {cut} znaki)', many: '\n… (ucięto {cut} znaków)',
    other: '\n… (ucięto {cut} znaku)',
  },
  'push.chime.title': 'Agent skończył',
  'state.load': 'Obciążenie {n}% teraz.',
  'state.full': 'Gotowe w 100%',
  'rest.old-ready': 'Gotowe (stare).',
};

const registry = { SENTENCES: TEST_SENTENCES, RETIRED: TEST_RETIRED, registryProblems };
const model = buildModel(registry);
const built = buildCatalog(model, { pl: new Map(Object.entries(TEST_PL)) });
const value = (node: CatalogNode | undefined): string | undefined => node?.stringUnit?.value;
const entryOf = (code: string) => built.catalog.strings[catalogKey(code)];

const temporary: string[] = [];
afterAll(() => {
  for (const made of temporary.splice(0)) rmSync(made, { recursive: true, force: true });
});

/** Korzeń tymczasowy z katalogami wyjść; `plFile` to wsad `--pl` w kształcie `l3/kody.json`. */
function sandbox(pl: Record<string, PlTemplate> = TEST_PL) {
  const root = mkdtempSync(path.join(tmpdir(), 'rarog-sentences-catalog-'));
  temporary.push(root);
  mkdirSync(path.dirname(path.join(root, CATALOG_PATH)), { recursive: true });
  const plFile = path.join(root, 'kody.json');
  writeFileSync(plFile, JSON.stringify({ codes: Object.entries(pl).map(([code, text]) => ({ code, stage: 'E1', pl: text })) }));
  const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');
  const run = async (argv: string[], given: typeof registry | Registry = registry) => {
    let out = '';
    let err = '';
    const status = await main(argv, {
      root, registry: given, out: { write: (text: string) => (out += text) }, err: { write: (text: string) => (err += text) },
    });
    return { status, out, err };
  };
  const catalog = (): Catalog => JSON.parse(read(CATALOG_PATH)) as Catalog;
  const putCatalog = (next: Catalog): void => { writeFileSync(path.join(root, CATALOG_PATH), formatCatalog(next)); };
  return { root, plFile, read, run, catalog, putCatalog };
}

describe('sentences-catalog: katalog z rejestru', () => {
  it('rest.bad-request: klucz server.<kod>, en z rejestru, deskryptor bez argumentów, komentarz i manual', () => {
    expect(built.problems).toEqual([]);
    const entry = entryOf('rest.bad-request');
    expect(value(entry?.localizations?.en)).toBe('Request rejected.');
    expect(value(entry?.localizations?.pl)).toBe('Żądanie odrzucone.');
    expect(entry?.extractionState).toBe('manual');
    expect(entry?.comment).toBe('Server sentence, area rest, code rest.bad-request. No arguments.');
    expect(buildDescriptors(model)).toContain('    "rest.bad-request": SentenceDescriptor(args: [], retired: false),\n');
    expect(built.catalog.sourceLanguage).toBe('en');
  });

  it('session.fallback-label n:int: en „session %1$lld”, pl „sesja %1$lld”, deskryptor [.int]', () => {
    const entry = entryOf('session.fallback-label');
    expect(value(entry?.localizations?.en)).toBe('session %1$lld');
    expect(value(entry?.localizations?.pl)).toBe('sesja %1$lld');
    expect(entry?.comment).toBe('Server sentence, area session, code session.fallback-label. Arguments: 1. n (int).');
    expect(buildDescriptors(model)).toContain('"session.fallback-label": SentenceDescriptor(args: [.int], retired: false),');
  });

  it('dwa argumenty text, pl w odwrotnej kolejności: en %1$@ … %2$@, pl %2$@ … %1$@', () => {
    const entry = entryOf('model.moved');
    expect(value(entry?.localizations?.en)).toBe('Moved %1$@ to %2$@.');
    expect(value(entry?.localizations?.pl)).toBe('Do %2$@ przeniesiono %1$@.');
    expect(buildDescriptors(model)).toContain('"model.moved": SentenceDescriptor(args: [.text, .text], retired: false),');
  });

  it('cut:plural: podstawienie %1$#@cut@ z argNum 1 i lld, warianty en one/other i pl one/few/many/other z %arg', () => {
    const entry = entryOf('transcript.truncation-footer');
    const en = entry?.localizations?.en;
    expect(value(en)).toBe('%1$#@cut@');
    expect(en?.substitutions?.cut).toEqual({
      argNum: 1, formatSpecifier: 'lld', variations: { plural: {
        one: { stringUnit: { state: 'translated', value: '\n… (%arg character cut off)' } },
        other: { stringUnit: { state: 'translated', value: '\n… (%arg characters cut off)' } },
      } },
    });
    const pl = entry?.localizations?.pl;
    expect(value(pl)).toBe('%1$#@cut@');
    const variants = pl?.substitutions?.cut?.variations.plural ?? {};
    expect(Object.keys(variants).sort()).toEqual(['few', 'many', 'one', 'other']);
    expect(value(variants.many)).toBe('\n… (ucięto %arg znaków)');
    expect(buildDescriptors(model)).toContain('"transcript.truncation-footer": SentenceDescriptor(args: [.plural], retired: false),');
  });

  it('push.chime.title: klucz bez prefiksu server.; % w zdaniu z argumentem to %%, bez argumentu %', () => {
    expect(catalogKey('push.chime.title')).toBe('push.chime.title');
    expect(catalogKey('dialogs.refuse.multi-select')).toBe('server.dialogs.refuse.multi-select');
    expect(value(entryOf('push.chime.title')?.localizations?.en)).toBe('Agent finished');
    expect(value(entryOf('state.load')?.localizations?.en)).toBe('Load %1$lld%% now.');
    expect(value(entryOf('state.load')?.localizations?.pl)).toBe('Obciążenie %1$lld%% teraz.');
    expect(value(entryOf('state.full')?.localizations?.en)).toBe('100% done');
    expect(value(entryOf('state.full')?.localizations?.pl)).toBe('Gotowe w 100%');
  });

  it('wpis RETIRED: klucz w katalogu z komentarzem o wycofaniu, deskryptor retired: true', () => {
    const entry = entryOf('rest.old-ready');
    expect(value(entry?.localizations?.en)).toBe('Ready (old).');
    expect(entry?.comment).toContain('Retired since 0.1.0.');
    expect(buildDescriptors(model)).toContain('"rest.old-ready": SentenceDescriptor(args: [], retired: true),');
  });

  it('deskryptory: nagłówek, typy z kontraktu i wiersze posortowane po kodzie', () => {
    const text = buildDescriptors(model);
    expect(text.startsWith('// Generated by scripts/sentences-catalog.mjs --write. Do not edit by hand.\n')).toBe(true);
    expect(text).toContain('public enum SentenceArgKind: String, Sendable, CaseIterable { case int, text, code, instant, plural }');
    expect(text).toContain('public struct SentenceDescriptor: Sendable, Equatable {\n  public let args: [SentenceArgKind]\n'
      + '  public let retired: Bool\n}');
    const codes = [...text.matchAll(/^ {4}"([^"]+)": SentenceDescriptor/gmu)].map((m) => m[1]);
    expect(codes).toEqual(model.sentences.map((one) => one.code));
    expect(codes).toEqual([...codes].sort());
  });

  it('format katalogu w stylu Xcode: klucze posortowane, „ : ”, wcięcie 2, końcowa nowa linia', () => {
    const text = formatCatalog(built.catalog);
    expect(text.startsWith('{\n  "sourceLanguage" : "en",\n  "strings" : {\n    "push.chime.title" : {\n')).toBe(true);
    expect(text.endsWith('\n  "version" : "1.0"\n}\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(built.catalog);
  });
});

describe('sentences-catalog: --write i --check w korzeniu tymczasowym', () => {
  it('--write --pl uzupełnia pl, drugie --write bez różnicy, --check kod 0; przeformatowanie przez Xcode nie czerwieni', async () => {
    const box = sandbox();
    const first = await box.run(['--write', '--pl', box.plFile]);
    expect(first.status, first.err).toBe(0);
    const catalogText = box.read(CATALOG_PATH);
    const descriptorsText = box.read(DESCRIPTORS_PATH);
    expect(descriptorsText).toBe(buildDescriptors(model));
    const second = await box.run(['--write']);
    expect(second.status, second.err).toBe(0);
    expect(box.read(CATALOG_PATH)).toBe(catalogText);
    expect(box.read(DESCRIPTORS_PATH)).toBe(descriptorsText);
    const check = await box.run(['--check']);
    expect(check.status, check.err).toBe(0);
    expect(check.out).toBe('sentences-catalog: registry ok (7 sentences, 1 retired); catalog and descriptors match\n');
    // Inna kolejność kluczy i wcięcie 4: ta sama treść po parsowaniu.
    const reordered = JSON.parse(catalogText) as Catalog;
    const strings = Object.fromEntries(Object.entries(reordered.strings).reverse());
    writeFileSync(path.join(box.root, CATALOG_PATH), JSON.stringify({ version: '1.0', strings, sourceLanguage: 'en' }, null, 4));
    expect((await box.run(['--check'])).status).toBe(0);
  });

  it('pl poprawione ręcznie w katalogu przeżywa --write, także z --pl; istniejące pl nie jest nadpisywane wsadem', async () => {
    const box = sandbox();
    expect((await box.run(['--write', '--pl', box.plFile])).status).toBe(0);
    const catalog = box.catalog();
    const key = catalogKey('rest.bad-request');
    const pl = catalog.strings[key]?.localizations?.pl;
    if (pl?.stringUnit) pl.stringUnit.value = 'Serwer odrzucił żądanie.';
    box.putCatalog(catalog);
    expect((await box.run(['--write'])).status).toBe(0);
    expect(value(box.catalog().strings[key]?.localizations?.pl)).toBe('Serwer odrzucił żądanie.');
    expect((await box.run(['--write', '--pl', box.plFile])).status).toBe(0);
    expect(value(box.catalog().strings[key]?.localizations?.pl)).toBe('Serwer odrzucił żądanie.');
    expect((await box.run(['--check'])).status).toBe(0);
  });

  it('--write bez pl dla klucza: pisze, ale kod 1 i komunikat o brakującym pl; --check kod 1', async () => {
    const { 'state.full': _skipped, ...partial } = TEST_PL;
    const box = sandbox(partial);
    const res = await box.run(['--write', '--pl', box.plFile]);
    expect(res.status).toBe(1);
    expect(res.err).toContain('server.state.full [pl]: no value');
    expect(box.catalog().strings['server.state.full']?.localizations?.pl).toBeUndefined();
    expect((await box.run(['--check'])).status).toBe(1);
  });

  it('--pl z nieznanym {nazwa}: nic nie zapisane, kod 1', async () => {
    const box = sandbox({ ...TEST_PL, 'session.fallback-label': 'sesja {numer}' });
    const res = await box.run(['--write', '--pl', box.plFile]);
    expect(res.status).toBe(1);
    expect(res.err).toContain('session.fallback-label [pl from --pl]: unknown placeholder {numer}');
    expect(() => box.read(CATALOG_PATH)).toThrow();
  });

  describe('--check kod 1', () => {
    const fresh = async () => {
      const box = sandbox();
      expect((await box.run(['--write', '--pl', box.plFile])).status).toBe(0);
      return box;
    };
    const expectRed = async (box: Awaited<ReturnType<typeof fresh>>, message: string) => {
      const res = await box.run(['--check']);
      expect(res.status).toBe(1);
      expect(res.err).toContain(message);
    };

    it('klucz usunięty z katalogu (mutacja 7)', async () => {
      const box = await fresh();
      const catalog = box.catalog();
      delete catalog.strings['server.rest.bad-request'];
      box.putCatalog(catalog);
      await expectRed(box, 'server.rest.bad-request: missing from the catalog');
    });

    it('en katalogu zmienione o słowo (mutacja 8)', async () => {
      const box = await fresh();
      const catalog = box.catalog();
      const en = catalog.strings['server.model.moved']?.localizations?.en;
      if (en?.stringUnit) en.stringUnit.value = 'Copied %1$@ to %2$@.';
      box.putCatalog(catalog);
      await expectRed(box, 'server.model.moved [en]: differs from the registry');
    });

    it('deskryptor niezgodny z rejestrem (mutacja 9)', async () => {
      const box = await fresh();
      const file = path.join(box.root, DESCRIPTORS_PATH);
      writeFileSync(file, box.read(DESCRIPTORS_PATH).replace('args: [.int], retired: false', 'args: [.text], retired: false'));
      await expectRed(box, `${DESCRIPTORS_PATH}: differs from the registry`);
    });

    it('brak pl, pl z nieznanym {nazwa}, klucz-sierota server.x.y, zły specyfikator pl', async () => {
      const box = await fresh();
      const catalog = box.catalog();
      const strings = catalog.strings;
      delete strings['server.rest.bad-request']?.localizations?.pl;
      const label = strings['server.session.fallback-label']?.localizations?.pl;
      if (label?.stringUnit) label.stringUnit.value = 'sesja {numer}';
      const moved = strings['server.model.moved']?.localizations?.pl;
      if (moved?.stringUnit) moved.stringUnit.value = 'Do %2$lld przeniesiono %1$@.';
      strings['server.x.y'] = { comment: 'x', extractionState: 'manual', localizations: {
        en: { stringUnit: { state: 'translated', value: 'X' } }, pl: { stringUnit: { state: 'translated', value: 'X' } },
      } };
      box.putCatalog(catalog);
      const res = await box.run(['--check']);
      expect(res.status).toBe(1);
      expect(res.err).toContain('server.rest.bad-request [pl]: no value');
      expect(res.err).toContain('server.session.fallback-label [pl]: placeholder {numer} left in');
      expect(res.err).toContain('server.session.fallback-label [pl]: argument 1 (n) is not used');
      expect(res.err).toContain('server.model.moved [pl]: %2$lld for to (text) — expected %2$@');
      expect(res.err).toContain('server.x.y: key without a code in the registry');
    });

    it('liczba mnoga pl bez kategorii few i % bez ucieczki w zdaniu z argumentem', async () => {
      const box = await fresh();
      const catalog = box.catalog();
      delete catalog.strings['server.transcript.truncation-footer']?.localizations?.pl?.substitutions?.cut?.variations.plural.few;
      const load = catalog.strings['server.state.load']?.localizations?.pl;
      if (load?.stringUnit) load.stringUnit.value = 'Obciążenie %1$lld% teraz.';
      box.putCatalog(catalog);
      const res = await box.run(['--check']);
      expect(res.status).toBe(1);
      expect(res.err).toContain('server.transcript.truncation-footer [pl]: plural is missing variants few');
      expect(res.err).toContain('server.state.load [pl]: bare "%" in a sentence with arguments');
    });

    it('brak katalogu i deskryptorów', async () => {
      const box = sandbox();
      const res = await box.run(['--check']);
      expect(res.status).toBe(1);
      expect(res.err).toContain(`${CATALOG_PATH}: missing (run --write)`);
      expect(res.err).toContain(`${DESCRIPTORS_PATH}: missing (run --write)`);
    });
  });

  it('outputProblems na świeżym wyjściu generatora: pusto', () => {
    expect(outputProblems(model, { catalog: built.catalog, descriptors: buildDescriptors(model) })).toEqual([]);
  });

  it('argumenty: --pl tylko z --write i z plikiem, jedna flaga', async () => {
    const box = sandbox();
    expect((await box.run(['--check', '--pl', box.plFile])).status).toBe(2);
    expect((await box.run(['--write', '--pl'])).status).toBe(2);
    expect((await box.run(['--write', '--check'])).status).toBe(2);
    expect((await box.run(['--publish', '--check'])).status).toBe(2);
    expect((await box.run(['--publish', '--pl', box.plFile])).status).toBe(2);
  });
});

describe('sentences-catalog: --publish (manifest opublikowanych kodów)', () => {
  const published = (box: ReturnType<typeof sandbox>): PublishedManifest =>
    JSON.parse(box.read(PUBLISHED_PATH)) as PublishedManifest;
  const withRegistry = (sentences: SentenceArea, retired: RetiredSentenceArea = TEST_RETIRED) =>
    ({ SENTENCES: sentences, RETIRED: retired, registryProblems });
  /** Rejestr testowy bez jednego kodu (`Object.fromEntries`, bo wpisy są tylko do odczytu). */
  const without = (code: string): SentenceArea =>
    Object.fromEntries(Object.entries(TEST_SENTENCES).filter(([key]) => key !== code));

  it('pierwszy --publish: format 1, wpisy modelu w porządku kodów, wycofany z retired; drugi daje te same bajty', async () => {
    const box = sandbox();
    const first = await box.run(['--publish']);
    expect(first.status, first.err).toBe(0);
    expect(first.out).toBe(`sentences-catalog: published 8 codes to ${PUBLISHED_PATH} (8 new, 0 changed)\n`);
    const bytes = box.read(PUBLISHED_PATH);
    expect(JSON.parse(bytes)).toEqual({ format: 1, sentences: model.sentences });
    expect(bytes).toBe(`${JSON.stringify({ format: 1, sentences: model.sentences }, null, 2)}\n`);
    expect(published(box).sentences.find((one) => one.code === 'rest.old-ready')?.retired).toBe('0.1.0');
    const second = await box.run(['--publish']);
    expect(second.status, second.err).toBe(0);
    expect(second.out).toBe(`sentences-catalog: published 8 codes to ${PUBLISHED_PATH} (0 new, 0 changed)\n`);
    expect(box.read(PUBLISHED_PATH)).toBe(bytes);
  });

  it('kod z manifestu usunięty z rejestru bez RETIRED: kod 1 z kodem w komunikacie, plik bez zmian, strażnik czerwony', async () => {
    const box = sandbox();
    expect((await box.run(['--publish'])).status).toBe(0);
    const before = box.read(PUBLISHED_PATH);
    const gone = withRegistry(without('model.moved'));
    const res = await box.run(['--publish'], gone);
    expect(res.status).toBe(1);
    expect(res.err).toContain('model.moved: published, but neither in SENTENCES nor in RETIRED');
    expect(res.out).toBe('');
    expect(box.read(PUBLISHED_PATH)).toBe(before);
    expect(publishedProblems(buildModel(gone), published(box)))
      .toEqual(['model.moved: published, but neither in SENTENCES nor in RETIRED']);
  });

  it('kod przeniesiony do RETIRED z tym samym szablonem: wpis zostaje z retired, strażnik zielony', async () => {
    const box = sandbox();
    expect((await box.run(['--publish'])).status).toBe(0);
    const moved = withRegistry(without('model.moved'), {
      ...TEST_RETIRED, 'model.moved': { ...TEST_SENTENCES['model.moved'], since: '0.2.0' },
    });
    expect(registryProblems(moved.SENTENCES, moved.RETIRED)).toEqual([]);
    expect(publishedProblems(buildModel(moved), published(box))).toEqual([]);
    const res = await box.run(['--publish'], moved);
    expect(res.status, res.err).toBe(0);
    expect(res.out).toBe(`sentences-catalog: published 8 codes to ${PUBLISHED_PATH} (0 new, 1 changed)\n  changed: model.moved\n`);
    const entry = published(box).sentences.find((one) => one.code === 'model.moved');
    expect(entry).toEqual({ code: 'model.moved', args: [{ name: 'from', kind: 'text' }, { name: 'to', kind: 'text' }],
      en: 'Moved {from} to {to}.', retired: '0.2.0' });
    expect(publishedProblems(buildModel(moved), published(box))).toEqual([]);
  });

  it('nowy kod dochodzi, a zmieniona definicja kodu przepisuje wpis (rejestr wygrywa)', async () => {
    const box = sandbox();
    expect((await box.run(['--publish'])).status).toBe(0);
    const next = withRegistry({ ...TEST_SENTENCES, 'rest.bad-request': { en: 'Request refused.' }, 'rest.new': { en: 'New.' } });
    const res = await box.run(['--publish'], next);
    expect(res.status, res.err).toBe(0);
    expect(res.out).toBe(
      `sentences-catalog: published 9 codes to ${PUBLISHED_PATH} (1 new, 1 changed)\n  changed: rest.bad-request\n`);
    expect(published(box)).toEqual({ format: 1, sentences: buildModel(next).sentences });
  });

  it('manifest, który nie jest JSON albo ma inny format: kod 1, nic nie zapisane', async () => {
    const box = sandbox();
    mkdirSync(path.dirname(path.join(box.root, PUBLISHED_PATH)), { recursive: true });
    writeFileSync(path.join(box.root, PUBLISHED_PATH), '{ nie json');
    const broken = await box.run(['--publish']);
    expect(broken.status).toBe(1);
    expect(broken.err).toContain(`nothing written, ${PUBLISHED_PATH} is not JSON`);
    expect(box.read(PUBLISHED_PATH)).toBe('{ nie json');
    writeFileSync(path.join(box.root, PUBLISHED_PATH), '{"format": 2, "sentences": []}\n');
    const other = await box.run(['--publish']);
    expect(other.status).toBe(1);
    expect(other.err).toContain('format must be 1');
    expect(box.read(PUBLISHED_PATH)).toBe('{"format": 2, "sentences": []}\n');
  });

  it('nieudany zapis (katalog bez prawa zapisu): kod 1, poprzedni manifest bez zmian, bez pliku tymczasowego', async () => {
    const box = sandbox();
    expect((await box.run(['--publish'])).status).toBe(0);
    const before = box.read(PUBLISHED_PATH);
    const dir = path.dirname(path.join(box.root, PUBLISHED_PATH));
    const next = withRegistry({ ...TEST_SENTENCES, 'rest.new': { en: 'New.' } });
    chmodSync(dir, 0o555);
    try {
      const res = await box.run(['--publish'], next);
      expect(res.status).toBe(1);
      expect(res.err).toContain(`nothing written, ${PUBLISHED_PATH} could not be replaced`);
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(box.read(PUBLISHED_PATH)).toBe(before);
    expect(readdirSync(dir)).toEqual([path.basename(PUBLISHED_PATH)]);
  });

  it('--publish nie zmienia wyjścia --check', async () => {
    const box = sandbox();
    expect((await box.run(['--write', '--pl', box.plFile])).status).toBe(0);
    const before = await box.run(['--check']);
    expect((await box.run(['--publish'])).status).toBe(0);
    expect(await box.run(['--check'])).toEqual(before);
  });
});

describe('sentences-catalog: argument poza liczbą mnogą w wariantach pl', () => {
  const sentence = {
    code: 'uploads.too-many', retired: null, en: { one: '{who}: {n} file', other: '{who}: {n} files' },
    args: [{ name: 'who', kind: 'text' }, { name: 'n', kind: 'plural' }],
  } as const;
  const unit = (value: string): CatalogNode => ({ stringUnit: { state: 'translated', value } });
  const pl = (head: string, variants: Record<string, string>): CatalogNode => ({
    ...unit(head),
    substitutions: { n: { argNum: 2, formatSpecifier: 'lld', variations: {
      plural: Object.fromEntries(Object.entries(variants).map(([category, value]) => [category, unit(value)])),
    } } },
  });

  it('argument w części wspólnej wzorca albo w każdym wariancie: bez problemu', () => {
    expect(plProblems(sentence, pl('%1$@: %2$#@n@',
      { one: '%arg plik', few: '%arg pliki', many: '%arg plików', other: '%arg pliku' }))).toEqual([]);
    expect(plProblems(sentence, pl('%2$#@n@', {
      one: '%arg plik od %1$@', few: '%arg pliki od %1$@', many: '%arg plików od %1$@', other: '%arg pliku od %1$@',
    }))).toEqual([]);
  });

  it('argument tylko w części wariantów: problem z brakującymi kategoriami', () => {
    expect(plProblems(sentence, pl('%2$#@n@',
      { one: '%arg plik od %1$@', few: '%arg pliki', many: '%arg plików', other: '%arg pliku' })))
      .toEqual(['server.uploads.too-many [pl]: argument 1 (who) is missing from plural variants few, many, other']);
  });
});

describe('sentences-catalog: prawdziwe repo', () => {
  it('--check na repo: kod 0, katalog i deskryptory zgodne z rejestrem', () => {
    const res = spawnSync(process.execPath, [path.join(REPO, 'scripts/sentences-catalog.mjs'), '--check'],
      { cwd: REPO, encoding: 'utf8', timeout: 60_000 });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/^sentences-catalog: registry ok \(\d+ sentences, \d+ retired\); catalog and descriptors match\n$/u);
  }, 60_000);
});
