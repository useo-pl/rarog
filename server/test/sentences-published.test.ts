/**
 * Strażnik manifestu opublikowanych kodów `shared/fixtures/sentences/published.json` (pisze go
 * `node scripts/sentences-catalog.mjs --publish`). Opublikowany kod nie zmienia argumentów ani szablonu, bo apka
 * starszej wersji tłumaczy go według swojego katalogu: każdy wpis manifestu ma stać w `SENTENCES` albo `RETIRED`
 * z tymi samymi argumentami (nazwa, rodzaj, kolejność) i tym samym `en`. Katalog i deskryptory tego nie łapią,
 * bo `--write` regeneruje je z rejestru razem ze zmianą. Mutacje idą na kopiach rejestru w pamięci, nigdy na plikach.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RETIRED,
  SENTENCES,
  registryProblems,
  type RetiredSentenceArea,
  type SentenceArea,
  type SentenceArgSpec,
} from '@rarog/shared/sentences';
import {
  CATALOG_PATH,
  PUBLISHED_PATH,
  buildCatalog,
  buildDescriptors,
  buildModel,
  outputProblems,
  publishedProblems,
  type Catalog,
  type PublishedManifest,
} from '../../scripts/sentences-catalog.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILE = path.join(REPO, PUBLISHED_PATH);
const read = (): PublishedManifest => JSON.parse(readFileSync(FILE, 'utf8')) as PublishedManifest;
const sentences: SentenceArea = SENTENCES;
const retired: RetiredSentenceArea = RETIRED;

/** Kopia rejestru bez kodu `code`. */
const without = (code: string): SentenceArea =>
  Object.fromEntries(Object.entries(sentences).filter(([key]) => key !== code));

/** Pierwszy opublikowany kod z argumentem `int`. */
function publishedWithInt(manifest: PublishedManifest) {
  const entry = manifest.sentences.find((one) => one.retired === null && one.args.some((arg) => arg.kind === 'int'));
  if (entry === undefined) throw new Error('published.json has no emitted code with an int argument');
  return entry;
}

describe('published.json: zgodność z rejestrem', () => {
  it('plik istnieje, ma format 1 i każdy wpis zgadza się z SENTENCES albo RETIRED', () => {
    expect(existsSync(FILE), `${PUBLISHED_PATH}: missing (run --publish)`).toBe(true);
    const manifest = read();
    expect(manifest.format).toBe(1);
    expect(manifest.sentences.length).toBeGreaterThan(0);
    expect(publishedProblems(buildModel({ SENTENCES, RETIRED }), manifest)).toEqual([]);
  });

  it('kod usunięty z rejestru bez RETIRED: czerwony z kodem', () => {
    const manifest = read();
    const code = manifest.sentences[0]?.code ?? '';
    const model = buildModel({ SENTENCES: without(code), RETIRED: retired });
    expect(publishedProblems(model, manifest)).toEqual([`${code}: published, but neither in SENTENCES nor in RETIRED`]);
  });

  it('kod przeniesiony do RETIRED z tym samym szablonem i argumentami: zielony', () => {
    const manifest = read();
    const { code } = publishedWithInt(manifest);
    const def = sentences[code];
    if (def === undefined) throw new Error(`${code}: not in SENTENCES`);
    const moved = { ...retired, [code]: { ...def, since: '0.2.0' } };
    expect(registryProblems(without(code), moved)).toEqual([]);
    expect(publishedProblems(buildModel({ SENTENCES: without(code), RETIRED: moved }), manifest)).toEqual([]);
  });

  it('mutacja 14: en wpisu RETIRED zmienione i katalog zregenerowany — --check zielony, strażnik czerwony', () => {
    const manifest = read();
    const { code } = publishedWithInt(manifest);
    const def = sentences[code];
    if (def === undefined) throw new Error(`${code}: not in SENTENCES`);
    const published = buildModel({ SENTENCES: without(code), RETIRED: { ...retired, [code]: { ...def, since: '0.2.0' } } });
    const changedEn = typeof def.en === 'string' ? `${def.en} (changed)` : { ...def.en, other: `${def.en.other} (changed)` };
    const mutated = { SENTENCES: without(code), RETIRED: { ...retired, [code]: { ...def, en: changedEn, since: '0.2.0' } } };
    expect(registryProblems(mutated.SENTENCES, mutated.RETIRED)).toEqual([]);
    const model = buildModel(mutated);
    // Katalog po `--write` (pl z katalogu repo) i deskryptory z rejestru po mutacji: `--check` nie widzi zmiany.
    const previous = JSON.parse(readFileSync(path.join(REPO, CATALOG_PATH), 'utf8')) as Catalog;
    const catalog = buildCatalog(model, { previous }).catalog;
    expect(outputProblems(model, { catalog, descriptors: buildDescriptors(model) })).toEqual([]);
    expect(publishedProblems(model, { format: 1, sentences: published.sentences }))
      .toEqual([`${code}: en differs from the registry`]);
  });

  it('rodzaj argumentu int → text przy zielonej walidacji rejestru: czerwony', () => {
    const manifest = read();
    const entry = publishedWithInt(manifest);
    const def = sentences[entry.code];
    if (def === undefined) throw new Error(`${entry.code}: not in SENTENCES`);
    const args = (def.args ?? []).map((spec) => spec.replace(/:int$/u, ':text') as SentenceArgSpec);
    const mutated: SentenceArea = { ...sentences, [entry.code]: { ...def, args } };
    expect(registryProblems(mutated, retired)).toEqual([]);
    const problems = publishedProblems(buildModel({ SENTENCES: mutated, RETIRED: retired }), manifest);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(new RegExp(`^${entry.code.replaceAll('.', '\\.')}: arguments differ from the registry`, 'u'));
  });

  it('wpisy w porządku kodów, bez powtórzeń i z kształtem modelu', () => {
    const manifest = read();
    const model = buildModel({ SENTENCES, RETIRED });
    const reversed = { format: 1, sentences: [...manifest.sentences].reverse() } as PublishedManifest;
    expect(publishedProblems(model, reversed)).toContain('sentences are not sorted by code or repeat a code');
    const broken = { format: 1, sentences: [{ code: 'rest.x', args: 'n:int', en: 'X', retired: null }] };
    expect(publishedProblems(model, broken as unknown as PublishedManifest))
      .toEqual(['sentences[0] (rest.x): not a model entry {code, args: [{name, kind}], en, retired}']);
  });
});
