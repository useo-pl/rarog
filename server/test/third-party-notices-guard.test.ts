/**
 * Strażnik not cudzych składników (opis: `native/Rarog/README.md`,
 * „Third-party asset licenses”, i nagłówek pliku `THIRD-PARTY-NOTICES`).
 *
 * Kod repo jest na MIT (`LICENSE`), ale repo i apka niosą też cudzy materiał: font z czternastoma zestawami
 * ikon, dźwięk „skończył”, port kodu SwiftTerm i sam SwiftTerm, IrohLib z crate'ami Rust, wkompilowane w apkę. Ich
 * licencje (MIT, CC BY 4.0, Apache 2.0, OFL 1.1, Unlicense, Unicode V3, a w IrohLib także MPL 2.0, BSD 2 i 3, ISC,
 * zlib i CDLA Permissive 2.0) wymagają noty albo tekstu licencji przy kopii, więc nowy cudzy plik nie może wejść po
 * cichu. Reguły:
 *
 * 1. plik binarny (bajt zerowy albo treść, która nie jest UTF-8) albo multimedialny z `repoFiles()` poza własnymi
 *    ({@link OWN}) ma wpis w notach;
 * 2. katalog z plikiem licencji albo noty (poza korzeniem, nazwa bez względu na wielkość liter) ma wpis na cały
 *    katalog; gdy sam katalog to `licenses/`, `legal/` albo podobny, wpis obejmuje katalog nad nim (składnik);
 * 3. plik ze znacznikiem `SPDX-SnippetBegin` w komentarzu ma wpis, a każdy fragment ma koniec, notę i licencję;
 * 4. wpis ma pola Name, Version, Source, License, Files i Copyright; wersja ma cyfrę, źródło adres `https://`,
 *    ścieżki z Files istnieją, a każda licencja z pola License ma pełny tekst w części „License texts”;
 * 5. tekst licencji po scaleniu białych znaków ma skrót SHA-256 zweryfikowanego wzorca ({@link KNOWN_TEXTS}):
 *    urwany akapit, inna wersja albo licencja spoza tabeli = czerwono;
 * 6. „TODO”, „TBD”, „FIXME”, „do ustalenia” albo pusty tekst licencji = czerwono.
 *
 * Do tego `LICENSE` korzenia (MIT, nota USEO), pole `license` w każdym `package.json` i plik not w paczce
 * apki: `project.pbxproj` ma referencję do `THIRD-PARTY-NOTICES` w korzeniu repo (nie do kopii) w fazie Resources
 * celu `Rarog`, więc `Rarog.app` niesie noty razem z materiałem, którego dotyczą.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO } from './private-guard.ts';
import { PBXPROJ } from './product-identity.ts';
import { repoFiles } from './source-scan.ts';

const NOTICES = 'THIRD-PARTY-NOTICES';
const SELF = 'server/test/third-party-notices-guard.test.ts';

/**
 * USEO's own files, though graphic: the Rarog icon layers in the Icon Composer document and the same icon
 * flattened into one vector for the pairing screen logo.
 */
const OWN: readonly string[] = ['native/Rarog/Rarog/AppIcon.icon/', 'native/Rarog/Rarog/Assets.xcassets/RarogLogo.imageset/'];

/** Rozszerzenia fontów, dźwięków, obrazów i dokumentów: cudze z natury, nawet gdy plik jest tekstem (SVG). */
const MEDIA = /\.(?:ttf|otf|ttc|woff2?|eot|caf|wav|mp3|aiff?|m4a|aac|ogg|oga|flac|png|jpe?g|gif|webp|heic|svg|pdf|ico|icns|mov|mp4)$/i;

/** Nazwa pliku licencji albo noty, bez względu na wielkość liter (`license.txt`, `LICENSE-MIT`, `NOTICE.md`). */
const LICENSE_FILE = /^(?:licen[cs]es?|copying|copyright|notices?|unlicense|ofl)(?:[-_.][a-z0-9.-]*)?$/i;
/** Rozszerzenia kodu i danych: `notice.ts` albo `license.json` to kod repo, nie nota. */
const CODE_EXT = /\.(?:[cm]?[jt]sx?|swift|json|jsonl|sh|py|rb|go|rs|[ch]|mm?|cpp|kt|java|css|ya?ml|toml|plist|x?cstrings|sql)$/i;
/** Katalog, który trzyma same licencje składnika: wpis musi objąć katalog nad nim. */
const LICENSE_DIR = /^(?:licen[cs]es?|legal|notices?|copying)$/i;

/** Początek fragmentu SPDX w komentarzu (nie wzmianka w dokumencie). */
const SNIPPET_BEGIN = /^\s*(?:\/\/+|#+|\*|\/\*+|--|;+)\s*SPDX-SnippetBegin\b/;
const SNIPPET_END = /^\s*(?:\/\/+|#+|\*|\/\*+|--|;+)\s*SPDX-SnippetEnd\b/;

const REQUIRED = ['Name', 'Version', 'Source', 'License', 'Files', 'Copyright'] as const;
const OPTIONAL = ['Use', 'Changes', 'Attribution', 'Note'] as const;
const FIELDS: ReadonlySet<string> = new Set([...REQUIRED, ...OPTIONAL]);

/**
 * Zweryfikowane teksty licencji: SHA-256 tekstu po scaleniu białych znaków ({@link normalizedHash}). Źródła
 * stoją w `THIRD-PARTY-NOTICES` nad każdym blokiem; MIT to sam tekst zgody, bez noty.
 * Nowa licencja albo nowa wersja tekstu: pobierz tekst u źródła, porównaj i dopisz skrót tutaj.
 */
const KNOWN_TEXTS: Readonly<Record<string, string>> = {
  MIT: 'fe2a9817987f862eaced948f0468c7f51d2fedfc48c5c505b246a49a3870e9a5',
  'Apache-2.0': '0ffddef9e48f8a09aed5caf2d44f7ba1c1be2d9b8e0a6f693b1635b2d5566645',
  'CC-BY-4.0': '1f5a529dc95849305307f0d6861169d8cae9e99807e4abcec68ef9ad19235652',
  'OFL-1.1': 'c06ba83f5a3d76aa794dae2fe3d19a09dc29d708d6ef0acb2743672b34833278',
  'OFL-1.1-RFN': 'c06ba83f5a3d76aa794dae2fe3d19a09dc29d708d6ef0acb2743672b34833278',
  Unlicense: '76f400a4c0f7aa31d065b0ca33b3171fb9d7473805b98b47ce8a54ba1041a952',
  'Unicode-3.0': 'ff07a96ff2f6c7ab9cc0eff6ced21a63f4923f95cb7d3f40ddf01d59aa2699fc',
  // Licencje crate'ów Rust w IrohLib: tekst z SPDX license-list-data, BSD i ISC bez linii wzoru noty
  // (noty stoją we wpisie crate'ów).
  'BSD-2-Clause': '971850f7f84e5dc88bd6b52e0d0c1fbffdaec4eae2fd311b1511d42bf7855c51',
  'BSD-3-Clause': '70435d703f5e4bdca9a1fa6b9291501b0dd850d2ad5457b491ce936217b1e063',
  ISC: 'd6aa1cc25d5f5b4d1595b9c110ff695000a86600f5a200ca7d853a3c9411cbde',
  Zlib: 'c8e200c261a77d32a61c4e55388eae01260251a0c51c067f2639e62a20f510a6',
  'MPL-2.0': 'e8ba82e63ba908724aaee6043943c5a2629b9ebf1af581ea0eea19a713123685',
  'CDLA-Permissive-2.0': '5eea30f5d846a77d2bbd93072bb5c1344b2eff8ff1b01aebaa401b7378b28de4',
};

/** SHA-256 tekstu z białymi znakami scalonymi do jednej spacji (zawijanie i wcięcia nie zmieniają skrótu). */
function normalizedHash(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');
}

/** Treść binarna: bajt zerowy albo bajty, które nie są poprawnym UTF-8. */
function isBinary(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

/** Katalog składnika dla pliku licencji: jego katalog, a dla `licenses/`, `legal/` itp. katalog nad nim. */
function componentDir(file: string): string | null {
  const name = path.posix.basename(file);
  if (!LICENSE_FILE.test(name) || CODE_EXT.test(name)) return null;
  let dir = path.posix.dirname(file);
  if (LICENSE_DIR.test(path.posix.basename(dir))) dir = path.posix.dirname(dir);
  return dir === '.' ? null : `${dir}/`;
}

const MARKERS = /\bTODO\b|\bTBD\b|\bFIXME\b|do ustalenia/i;
const BEGIN_TEXT = /^-{5} BEGIN LICENSE TEXT: (.+?) -{5}$/;
const END_TEXT = /^-{5} END LICENSE TEXT: (.+?) -{5}$/;
const SEPARATOR = /^-{20,}$/;

interface Entry {
  readonly name: string;
  readonly line: number;
  readonly fields: ReadonlyMap<string, string>;
}

interface Parsed {
  readonly entries: readonly Entry[];
  /** Identyfikator SPDX → pełny tekst licencji. */
  readonly texts: ReadonlyMap<string, string>;
  readonly problems: readonly string[];
}

/** Identyfikatory licencji z wyrażenia SPDX (`MIT AND (CC-BY-4.0 OR OFL-1.1)`). */
function licenseIds(expression: string): string[] {
  return expression.replace(/[()]/g, ' ').split(/\s+/).filter((token) => token !== '' && !['AND', 'OR', 'WITH'].includes(token));
}

/** Rozbiór pliku not: wpisy (`Name:` … do separatora) poza blokami tekstów licencji i same bloki. */
function parseNotices(text: string): Parsed {
  const problems: string[] = [];
  const entries: Entry[] = [];
  const texts = new Map<string, string>();
  const lines = text.split('\n');
  let block: { ids: string[]; line: number; body: string[] } | null = null;
  let entry: { name: string; line: number; fields: Map<string, string> } | null = null;
  let field: string | null = null;
  const closeEntry = (): void => {
    if (entry !== null) entries.push(entry);
    entry = null;
    field = null;
  };
  lines.forEach((raw, index) => {
    const line = raw.replace(/\r$/, '');
    const at = `${NOTICES}:${String(index + 1)}`;
    if (MARKERS.test(line)) problems.push(`${at}: znacznik niedokończonej noty („${line.trim()}”)`);
    if (block !== null) {
      const end = END_TEXT.exec(line);
      if (end === null) {
        block.body.push(line);
        return;
      }
      if (end[1] !== block.ids.join(', ')) problems.push(`${at}: koniec bloku „${end[1] ?? ''}” nie pasuje do początku`);
      const body = block.body.join('\n').trim();
      for (const id of block.ids) {
        if (texts.has(id)) problems.push(`${at}: tekst licencji ${id} drugi raz`);
        texts.set(id, body);
      }
      block = null;
      return;
    }
    const begin = BEGIN_TEXT.exec(line);
    if (begin !== null) {
      closeEntry();
      block = { ids: (begin[1] ?? '').split(/,\s*/), line: index + 1, body: [] };
      return;
    }
    if (END_TEXT.test(line)) {
      problems.push(`${at}: koniec bloku licencji bez początku`);
      return;
    }
    if (SEPARATOR.test(line)) {
      closeEntry();
      return;
    }
    const named = /^([A-Z][A-Za-z]*): ?(.*)$/.exec(line);
    if (named !== null && named[1] === 'Name') {
      closeEntry();
      entry = { name: (named[2] ?? '').trim(), line: index + 1, fields: new Map([['Name', (named[2] ?? '').trim()]]) };
      field = 'Name';
      return;
    }
    if (entry === null) {
      if (named !== null && FIELDS.has(named[1] ?? '')) problems.push(`${at}: pole ${named[1] ?? ''} poza wpisem (brak „Name:”)`);
      return;
    }
    if (named !== null) {
      const key = named[1] ?? '';
      if (!FIELDS.has(key)) problems.push(`${at}: nieznane pole „${key}” we wpisie ${entry.name}`);
      if (entry.fields.has(key)) problems.push(`${at}: pole ${key} drugi raz we wpisie ${entry.name}`);
      entry.fields.set(key, (named[2] ?? '').trim());
      field = key;
      return;
    }
    if (line.trim() === '') {
      field = null;
      return;
    }
    if (/^\s/.test(line) && field !== null) {
      entry.fields.set(field, `${entry.fields.get(field) ?? ''}\n${line.trim()}`.trim());
      return;
    }
    problems.push(`${at}: linia poza polem we wpisie ${entry.name}`);
  });
  closeEntry();
  if (block !== null) problems.push(`${NOTICES}:${String((block as { line: number }).line)}: blok licencji bez końca`);
  return { entries, texts, problems };
}

/** Pliki, które pokrywa wpis: ścieżka dokładna albo katalog zakończony `/`. */
function covers(paths: readonly string[], file: string): boolean {
  return paths.some((entryPath) => (entryPath.endsWith('/') ? file.startsWith(entryPath) : file === entryPath));
}

const isOwn = (file: string): boolean => covers(OWN, file);

/** Wszystkie problemy not w repo pod `root` (pusta lista = zielono); `known` — zweryfikowane teksty licencji. */
function noticeProblems(root: string, known: Readonly<Record<string, string>> = KNOWN_TEXTS): string[] {
  const files = repoFiles(root).filter((file) => file !== SELF);
  const fileSet = new Set(files);
  const problems: string[] = [];
  let parsed: Parsed = { entries: [], texts: new Map(), problems: [] };
  if (fileSet.has(NOTICES)) parsed = parseNotices(readFileSync(path.join(root, NOTICES), 'utf8'));
  else problems.push(`brak pliku ${NOTICES} w korzeniu repo`);
  problems.push(...parsed.problems);

  const names = new Set<string>();
  const covered: string[] = [];
  for (const entry of parsed.entries) {
    const where = `${NOTICES}:${String(entry.line)} (${entry.name || 'bez nazwy'})`;
    if (names.has(entry.name)) problems.push(`${where}: nazwa wpisu drugi raz`);
    names.add(entry.name);
    for (const key of REQUIRED) {
      if ((entry.fields.get(key) ?? '').trim() === '') problems.push(`${where}: brak pola ${key}`);
    }
    const version = entry.fields.get('Version') ?? '';
    if (version !== '' && !/\d/.test(version)) problems.push(`${where}: Version bez wersji ani daty`);
    const source = entry.fields.get('Source') ?? '';
    if (source !== '' && !/https:\/\/\S+/.test(source)) problems.push(`${where}: Source bez adresu https://`);
    for (const id of licenseIds(entry.fields.get('License') ?? '')) {
      if (!parsed.texts.has(id)) problems.push(`${where}: licencja ${id} bez pełnego tekstu w „License texts”`);
    }
    for (const entryPath of (entry.fields.get('Files') ?? '').split('\n').map((p) => p.trim()).filter((p) => p !== '')) {
      const exists = entryPath.endsWith('/') ? files.some((file) => file.startsWith(entryPath)) : fileSet.has(entryPath);
      if (!exists) problems.push(`${where}: ścieżki ${entryPath} nie ma w repo`);
      covered.push(entryPath);
    }
  }
  for (const [id, body] of parsed.texts) {
    if (body.trim() === '') {
      problems.push(`tekst licencji ${id}: pusty`);
      continue;
    }
    const expected = known[id];
    const actual = normalizedHash(body);
    if (expected === undefined) {
      problems.push(`tekst licencji ${id}: licencja nieznana strażnikowi (skrót ${actual}; zweryfikuj tekst u źródła `
        + `i dopisz skrót do KNOWN_TEXTS w ${SELF})`);
    } else if (actual !== expected) {
      problems.push(`tekst licencji ${id}: różni się od zweryfikowanego wzorca (skrót ${actual})`);
    }
  }

  const foreignDirs = new Set<string>();
  for (const file of files) {
    const full = path.join(root, file);
    if (!lstatSync(full).isFile()) continue;
    const component = componentDir(file);
    if (component !== null) foreignDirs.add(component);
    if (isOwn(file)) continue;
    const bytes = readFileSync(full);
    const binary = isBinary(bytes);
    if ((binary || MEDIA.test(file)) && !covers(covered, file)) {
      problems.push(`${file}: plik binarny albo multimedialny bez wpisu w ${NOTICES} (albo w OWN strażnika, gdy własny)`);
    }
    const text = binary ? '' : bytes.toString('utf8');
    if (!text.includes('SPDX-Snippet')) continue;
    problems.push(...snippetProblems(file, text, parsed.texts, covered));
  }
  for (const dir of foreignDirs) {
    if (!covered.some((entryPath) => entryPath.endsWith('/') && dir.startsWith(entryPath))) {
      problems.push(`${dir}: katalog z plikiem licencji albo noty bez wpisu na cały katalog w ${NOTICES}`);
    }
  }
  return problems;
}

/** Fragmenty SPDX w jednym pliku: koniec, nota, licencja z pełnym tekstem w notach i wpis na plik. */
function snippetProblems(file: string, text: string, texts: ReadonlyMap<string, string>, covered: readonly string[]): string[] {
  const problems: string[] = [];
  let open: { line: number; copyright: boolean; licenses: string[] } | null = null;
  let any = false;
  text.split('\n').forEach((line, index) => {
    const at = `${file}:${String(index + 1)}`;
    if (SNIPPET_BEGIN.test(line)) {
      if (open !== null) problems.push(`${at}: SPDX-SnippetBegin przed końcem poprzedniego fragmentu`);
      open = { line: index + 1, copyright: false, licenses: [] };
      any = true;
      return;
    }
    if (open === null) return;
    const copyright = /SPDX-SnippetCopyrightText:\s*(\S.*)$/.exec(line);
    if (copyright !== null) open.copyright = true;
    const license = /SPDX-License-Identifier:\s*(\S.*)$/.exec(line);
    if (license !== null) open.licenses.push(...licenseIds(license[1] ?? ''));
    if (SNIPPET_END.test(line)) {
      const begun: { line: number; copyright: boolean; licenses: string[] } = open;
      const from = `${file}:${String(begun.line)}`;
      if (!begun.copyright) problems.push(`${from}: fragment bez SPDX-SnippetCopyrightText`);
      if (begun.licenses.length === 0) problems.push(`${from}: fragment bez SPDX-License-Identifier`);
      for (const id of begun.licenses) {
        if (!texts.has(id)) problems.push(`${from}: licencja fragmentu ${id} bez pełnego tekstu w ${NOTICES}`);
      }
      open = null;
    }
  });
  if (open !== null) problems.push(`${file}:${String((open as { line: number }).line)}: SPDX-SnippetBegin bez SPDX-SnippetEnd`);
  if (any && !covers(covered, file)) problems.push(`${file}: plik z cudzym fragmentem (SPDX-SnippetBegin) bez wpisu w ${NOTICES}`);
  return problems;
}

describe('noty cudzych składników: repo', () => {
  it(`każdy cudzy plik, katalog i fragment ma kompletny wpis w ${NOTICES}`, () => {
    const problems = noticeProblems(REPO);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('`LICENSE` korzenia to MIT z notą USEO, a każdy `package.json` ma `license: "MIT"`', () => {
    const license = readFileSync(path.join(REPO, 'LICENSE'), 'utf8');
    expect(license.startsWith('MIT License\n\nCopyright (c) 2026 USEO Sp. z o.o.\n\nPermission is hereby granted')).toBe(true);
    expect(normalizedHash(license.slice(license.indexOf('Permission is hereby granted')))).toBe(KNOWN_TEXTS.MIT);
    const manifests = repoFiles(REPO).filter((file) => path.posix.basename(file) === 'package.json');
    expect(manifests.length).toBeGreaterThanOrEqual(4);
    for (const manifest of manifests) {
      const pkg = JSON.parse(readFileSync(path.join(REPO, manifest), 'utf8')) as { license?: string; private?: boolean };
      expect(pkg.license, manifest).toBe('MIT');
      expect(pkg.private, manifest).toBe(true);
    }
  });
});

/** Katalog projektu apki (`native/Rarog`): od niego liczy się ścieżka grupy głównej i `SOURCE_ROOT`. */
const APP_PROJECT_DIR = path.posix.dirname(path.posix.dirname(PBXPROJ));

/**
 * Obiekty `project.pbxproj` (id → ciało): jednoliniowe (`<id> /* … *\/ = {isa = …; };`) i wieloliniowe do `\t\t};`.
 * Obiekty stoją na dwóch tabulatorach, słowniki zagnieżdżone głębiej; grupa główna nie ma komentarza po id.
 */
function pbxObjects(text: string): Map<string, string> {
  const objects = new Map<string, string>();
  const re = /^\t\t([0-9A-F]{24})(?: \/\*[^\n]*?\*\/)? = \{(?:(isa = [^\n]*?)\};|\n([\s\S]*?)^\t\t\};)$/gm;
  for (const match of text.matchAll(re)) objects.set(match[1] ?? '', match[2] ?? match[3] ?? '');
  return objects;
}

/** Wartość pola obiektu (`key = wartość;`, `key = "wartość";`, `key = <id> /* … *\/;`), bez cudzysłowu. */
function pbxField(body: string, key: string): string | undefined {
  const value = new RegExp(`(?:^|[\\s{;])${key} = ("[^"\\n]*"|[^;\\s"]+)(?: /\\*[^\\n]*?\\*/)?;`).exec(body)?.[1];
  return value?.replace(/^"(.*)"$/, '$1');
}

/** Identyfikatory z listy `key = ( … );`. */
function pbxList(body: string, key: string): string[] {
  return new RegExp(`(?:^|\\s)${key} = \\(([^)]*)\\);`).exec(body)?.[1]?.match(/[0-9A-F]{24}/g) ?? [];
}

/**
 * Problemy noty w paczce apki (pusta lista = zielono): każda referencja do pliku o nazwie `THIRD-PARTY-NOTICES`
 * po rozwiązaniu ścieżki od katalogu projektu przez grupy wskazuje istniejący plik w korzeniu repo (jedno źródło,
 * bez kopii w `native/`) i jest w fazie Resources celu `Rarog`. `exists` — czy ścieżka względem korzenia istnieje.
 */
function appNoticesProblems(text: string, exists: (file: string) => boolean): string[] {
  const objects = pbxObjects(text);
  const all = [...objects];
  const isa = (id: string): string | undefined => pbxField(objects.get(id) ?? '', 'isa');
  const mainGroup = pbxField(all.find(([id]) => isa(id) === 'PBXProject')?.[1] ?? '', 'mainGroup');
  /** Katalog (względem korzenia repo), od którego liczy się `path` obiektu; null = poza drzewem grup albo repo. */
  const baseDir = (id: string): string | null => {
    const tree = pbxField(objects.get(id) ?? '', 'sourceTree');
    if (tree === 'SOURCE_ROOT' || (tree === '<group>' && id === mainGroup)) return APP_PROJECT_DIR;
    if (tree !== '<group>') return null;
    const parent = all.find(([groupId, body]) => isa(groupId) === 'PBXGroup' && pbxList(body, 'children').includes(id));
    if (parent === undefined) return null;
    const dir = baseDir(parent[0]);
    return dir === null ? null : path.posix.join(dir, pbxField(parent[1], 'path') ?? '');
  };
  const refs = all.filter(([id, body]) => isa(id) === 'PBXFileReference'
    && path.posix.basename(pbxField(body, 'path') ?? '') === NOTICES);
  if (refs.length === 0) return [`${PBXPROJ}: brak referencji do ${NOTICES} (plik not poza paczką apki)`];
  const target = all.find(([id, body]) => isa(id) === 'PBXNativeTarget' && pbxField(body, 'name') === 'Rarog')?.[1] ?? '';
  const resources = pbxList(target, 'buildPhases').filter((id) => isa(id) === 'PBXResourcesBuildPhase')
    .flatMap((id) => pbxList(objects.get(id) ?? '', 'files'));
  const problems: string[] = [];
  for (const [id, body] of refs) {
    const base = baseDir(id);
    const resolved = base === null ? null : path.posix.normalize(path.posix.join(base, pbxField(body, 'path') ?? ''));
    if (resolved !== NOTICES) {
      const where = resolved ?? 'ścieżkę spoza drzewa grup';
      problems.push(`${PBXPROJ}: referencja ${id} wskazuje ${where}, nie ${NOTICES} w korzeniu repo`);
    } else if (!exists(resolved)) {
      problems.push(`${PBXPROJ}: referencja ${id} wskazuje ${resolved}, którego nie ma`);
    }
    if (!resources.some((file) => pbxField(objects.get(file) ?? '', 'fileRef') === id)) {
      problems.push(`${PBXPROJ}: referencja ${id} (${NOTICES}) poza fazą Resources celu Rarog`);
    }
  }
  return problems;
}

describe('noty cudzych składników: plik not w paczce apki', () => {
  const pbx = readFileSync(path.join(REPO, PBXPROJ), 'utf8');
  const exists = (file: string): boolean => existsSync(path.join(REPO, file));

  it(`${NOTICES} z korzenia repo jest zasobem celu Rarog (faza Resources)`, () => {
    const problems = appNoticesProblems(pbx, exists);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('kopia w katalogu projektu albo referencja poza fazą Resources celu Rarog: czerwono', () => {
    const ref = /^\t\t([0-9A-F]{24}) \/\* THIRD-PARTY-NOTICES \*\/ = \{isa = PBXFileReference;/m.exec(pbx)?.[1] ?? '';
    expect(ref, 'referencja do pliku not w project.pbxproj').not.toBe('');
    const kopia = pbx.replace(`path = "../../${NOTICES}";`, `path = "${NOTICES}";`);
    expect(appNoticesProblems(kopia, () => true))
      .toEqual([`${PBXPROJ}: referencja ${ref} wskazuje native/Rarog/${NOTICES}, nie ${NOTICES} w korzeniu repo`]);
    const pozaFaza = pbx.replace(/^\t{4}[0-9A-F]{24} \/\* THIRD-PARTY-NOTICES in Resources \*\/,\n/m, '');
    expect(appNoticesProblems(pozaFaza, exists))
      .toEqual([`${PBXPROJ}: referencja ${ref} (${NOTICES}) poza fazą Resources celu Rarog`]);
  });
});

/** Tekst zgody MIT (wzorzec z {@link KNOWN_TEXTS}; zawijanie inne niż w notach, skrót ten sam). */
const MIT_TEXT = [
  'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated',
  'documentation files (the "Software"), to deal in the Software without restriction, including without limitation',
  'the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and',
  'to permit persons to whom the Software is furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all copies or substantial portions of',
  'the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO',
  'THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF',
  'CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER',
  'DEALINGS IN THE SOFTWARE.',
].join('\n');

const mitBlock = (body: string): string => `----- BEGIN LICENSE TEXT: MIT -----\n${body}\n----- END LICENSE TEXT: MIT -----`;

const ENTRY = [
  'Name: Przykładowy font',
  'Version: 1.0.0',
  'Source: https://example.com/font',
  'License: MIT',
  'Files: zasoby/font/',
  'Copyright: Copyright (c) 2020 Autor',
].join('\n');

function notices(entries: string, texts = mitBlock(MIT_TEXT)): string {
  return `THIRD-PARTY NOTICES\n\n${'-'.repeat(30)}\n${entries}\n${'-'.repeat(30)}\n\n${texts}\n`;
}

describe('noty cudzych składników: mechanizm na atrapie repo w $TMPDIR', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Atrapa repo bez `.git` (spacer `repoFiles`): font z licencją w katalogu i plik not. */
  function fakeRepo(files: Readonly<Record<string, string | Uint8Array>>): string {
    const root = mkdtempSync(path.join(tmpdir(), 'pp7-noty-'));
    dirs.push(root);
    const all: Record<string, string | Uint8Array> = {
      'zasoby/font/Font.ttf': new Uint8Array([0, 1, 0, 0, 0, 7]),
      'zasoby/font/LICENSE': 'MIT License\nCopyright (c) 2020 Autor\n',
      [NOTICES]: notices(ENTRY),
      ...files,
    };
    for (const [file, content] of Object.entries(all)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), content);
    }
    return root;
  }

  it('kompletny wpis na katalog fontu: zielono', () => {
    expect(noticeProblems(fakeRepo({}))).toEqual([]);
  });

  it('brak pliku not: czerwono, z każdym niepokrytym plikiem', () => {
    const root = fakeRepo({});
    rmSync(path.join(root, NOTICES));
    expect(noticeProblems(root)).toEqual([
      `brak pliku ${NOTICES} w korzeniu repo`,
      'zasoby/font/Font.ttf: plik binarny albo multimedialny bez wpisu w THIRD-PARTY-NOTICES (albo w OWN strażnika, gdy własny)',
      'zasoby/font/: katalog z plikiem licencji albo noty bez wpisu na cały katalog w THIRD-PARTY-NOTICES',
    ]);
  });

  it('nowy dźwięk i obraz SVG bez wpisu: czerwono', () => {
    const problems = noticeProblems(fakeRepo({ 'apka/dzwiek.caf': 'caff', 'apka/logo.svg': '<svg/>' }));
    expect(problems.map((p) => p.split(':')[0])).toEqual(['apka/dzwiek.caf', 'apka/logo.svg']);
  });

  it('wpis z „TODO”, „do ustalenia” albo bez pola: czerwono', () => {
    const todo = noticeProblems(fakeRepo({ [NOTICES]: notices(ENTRY.replace('Copyright (c) 2020 Autor', 'TODO')) }));
    expect(todo.join('\n')).toContain('znacznik niedokończonej noty');
    const pl = noticeProblems(fakeRepo({ [NOTICES]: notices(ENTRY.replace('1.0.0', 'do ustalenia')) }));
    expect(pl.join('\n')).toContain('znacznik niedokończonej noty');
    expect(pl.join('\n')).toContain('Version bez wersji ani daty');
    const brak = noticeProblems(fakeRepo({ [NOTICES]: notices(ENTRY.replace(/\nCopyright: .*/, '')) }));
    expect(brak).toEqual([`${NOTICES}:4 (Przykładowy font): brak pola Copyright`]);
  });

  it('licencja bez pełnego tekstu, pusty tekst i licencja nieznana: czerwono', () => {
    const bezTekstu = noticeProblems(fakeRepo({ [NOTICES]: notices(ENTRY.replace('License: MIT', 'License: MIT AND CC-BY-4.0')) }));
    expect(bezTekstu).toEqual([`${NOTICES}:4 (Przykładowy font): licencja CC-BY-4.0 bez pełnego tekstu w „License texts”`]);
    const pusty = noticeProblems(fakeRepo({
      [NOTICES]: notices(ENTRY, '----- BEGIN LICENSE TEXT: MIT -----\n\n----- END LICENSE TEXT: MIT -----'),
    }));
    expect(pusty).toEqual(['tekst licencji MIT: pusty']);
    const nieznana = noticeProblems(fakeRepo({
      [NOTICES]: notices(ENTRY.replace('License: MIT', 'License: X-1.0'),
        `----- BEGIN LICENSE TEXT: X-1.0 -----\n${MIT_TEXT}\n----- END LICENSE TEXT: X-1.0 -----`),
    }));
    expect(nieznana.join('\n')).toContain('tekst licencji X-1.0: licencja nieznana strażnikowi');
  });

  it('tekst licencji z urwanym akapitem (warunek zachowania noty): czerwono, choć zostają początek i koniec', () => {
    const bezWarunku = MIT_TEXT.replace(/\nThe above copyright notice[^]*?the Software\.\n/, '\n');
    expect(bezWarunku).not.toContain('The above copyright notice');
    const problems = noticeProblems(fakeRepo({ [NOTICES]: notices(ENTRY, mitBlock(bezWarunku)) }));
    expect(problems).toEqual([`tekst licencji MIT: różni się od zweryfikowanego wzorca (skrót ${normalizedHash(bezWarunku)})`]);
  });

  it('plik binarny bez rozszerzenia i bez bajtu zerowego (nie-UTF-8): czerwono', () => {
    const problems = noticeProblems(fakeRepo({ 'assets/new-data': new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0xff]) }));
    expect(problems).toEqual([
      'assets/new-data: plik binarny albo multimedialny bez wpisu w THIRD-PARTY-NOTICES (albo w OWN strażnika, gdy własny)',
    ]);
  });

  it('licencja małymi literami w cudzym katalogu: czerwono; `notice.ts` i `license.json` w kodzie to nie nota', () => {
    const problems = noticeProblems(fakeRepo({
      'vendor/library/main.ts': 'export {};\n',
      'vendor/library/license.txt': 'MIT License\n',
      'src/notice.ts': 'export {};\n',
      'src/license.json': '{}\n',
    }));
    expect(problems).toEqual(['vendor/library/: katalog z plikiem licencji albo noty bez wpisu na cały katalog w THIRD-PARTY-NOTICES']);
  });

  it('licencja w podkatalogu `licenses/`: wpis musi objąć katalog składnika, nie sam katalog licencji', () => {
    const skladnik = { 'vendor/library/src/main.ts': 'export {};\n', 'vendor/library/licenses/LICENSE': 'MIT License\n' };
    const wpis = (files: string): string => notices(`${ENTRY}\n${'-'.repeat(30)}\n${ENTRY.replace('Przykładowy font', 'Biblioteka')
      .replace('Files: zasoby/font/', `Files: ${files}`)}`);
    expect(noticeProblems(fakeRepo({ ...skladnik, [NOTICES]: wpis('vendor/library/licenses/') })))
      .toEqual(['vendor/library/: katalog z plikiem licencji albo noty bez wpisu na cały katalog w THIRD-PARTY-NOTICES']);
    expect(noticeProblems(fakeRepo({ ...skladnik, [NOTICES]: wpis('vendor/library/') }))).toEqual([]);
  });

  it('ścieżka z Files, której nie ma, i wpis bez źródła https: czerwono', () => {
    const problems = noticeProblems(fakeRepo({
      [NOTICES]: notices(ENTRY.replace('https://example.com/font', 'strona autora')
        .replace('Files: zasoby/font/', 'Files: zasoby/font/\n       zasoby/nie-ma.ttf')),
    }));
    expect(problems).toEqual([
      `${NOTICES}:4 (Przykładowy font): Source bez adresu https://`,
      `${NOTICES}:4 (Przykładowy font): ścieżki zasoby/nie-ma.ttf nie ma w repo`,
    ]);
  });

  it('fragment SPDX: bez wpisu, bez końca albo bez noty — czerwono; kompletny z wpisem — zielono', () => {
    const fragment = (body: string): string => `let a = 1\n// SPDX-SnippetBegin\n${body}\nlet b = 2\n// SPDX-SnippetEnd\n`;
    const pelny = '// SPDX-SnippetCopyrightText: Copyright (c) 2020 Autor\n// SPDX-License-Identifier: MIT';
    const bezWpisu = noticeProblems(fakeRepo({ 'src/Port.swift': fragment(pelny) }));
    expect(bezWpisu).toEqual(['src/Port.swift: plik z cudzym fragmentem (SPDX-SnippetBegin) bez wpisu w THIRD-PARTY-NOTICES']);
    const zWpisem = notices(`${ENTRY}\n${'-'.repeat(30)}\n${ENTRY.replace('Przykładowy font', 'Port').replace('zasoby/font/', 'src/Port.swift')}`);
    expect(noticeProblems(fakeRepo({ 'src/Port.swift': fragment(pelny), [NOTICES]: zWpisem }))).toEqual([]);
    const bezNoty = noticeProblems(fakeRepo({ 'src/Port.swift': fragment('// SPDX-License-Identifier: MIT'), [NOTICES]: zWpisem }));
    expect(bezNoty).toEqual(['src/Port.swift:2: fragment bez SPDX-SnippetCopyrightText']);
    const bezKonca = noticeProblems(fakeRepo({ 'src/Port.swift': `// SPDX-SnippetBegin\n${pelny}\n`, [NOTICES]: zWpisem }));
    expect(bezKonca).toEqual(['src/Port.swift:1: SPDX-SnippetBegin bez SPDX-SnippetEnd']);
  });

  it('własny plik z OWN i wzmianka o SPDX w dokumencie nie potrzebują wpisu', () => {
    const root = fakeRepo({
      'native/Rarog/Rarog/AppIcon.icon/Assets/head.svg': '<svg/>',
      'docs/a.md': 'Port ma nagłówek `SPDX-SnippetBegin` przy kodzie.\n',
    });
    expect(noticeProblems(root)).toEqual([]);
  });
});
