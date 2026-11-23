/**
 * Strażnik atrap klienta rejestru relaya iroh w apce natywnej: atrapa bramki i wartości testów przepływu istnieją
 * tylko w buildzie Debug, a apka i jej rozszerzenia nie linkują biblioteki atrap pakietu.
 *
 * Do udowodnienia:
 * - nazwy tylko dla Debug (zmienne `RAROG_RELAY_FAKE_GATE`, `RAROG_RELAY_AUTH_MAP`, `RAROG_RELAY_RENEW_EVERY`,
 *   znacznik atrap `RAROG_TEST_ONLY_RELAY_FAKE`) i każda nazwa z `FakeRelayGate` stoją w źródłach Swift
 *   `native/Rarog/Rarog/` wyłącznie w gałęzi `#if DEBUG` (do jej `#else`, `#elseif` albo `#endif`), także
 *   w komentarzach; warunek inny niż sam `DEBUG` (`!DEBUG`, `DEBUG && …`) się nie liczy;
 * - każda z tych nazw stoi w apce co najmniej raz, więc reguła ma czego pilnować;
 * - cel apki i cele rozszerzeń w `project.pbxproj` nie linkują `RarogTransportTesting` (ani zależnością produktu
 *   pakietu, ani plikiem fazy Frameworks), a cel testów UIKit linkuje (kontrola czytnika);
 * - `RelayGates.swift` i `RelayAccessSetup.swift` są w `membershipExceptions` celu `RarogUIKitTests`.
 *
 * Czego nie udowodni: że plik wykonywalny buildu wydania nie niesie atrapy. To widać dopiero w samym pliku: oględziny
 * wydania szukają znacznika w plikach wykonywalnych apki i rozszerzeń.
 */
import { describe, expect, it } from 'vitest';
import { PBXPROJ, REPO, readRepo } from './product-identity.ts';
import { repoFiles } from './source-scan.ts';

const APP_SOURCES = 'native/Rarog/Rarog';
/** Nazwy, które w źródłach apki stoją wyłącznie w gałęzi `#if DEBUG` (dopasowanie podciągu). */
const DEBUG_ONLY = [
  'RAROG_RELAY_FAKE_GATE', 'RAROG_RELAY_AUTH_MAP', 'RAROG_RELAY_RENEW_EVERY', 'RAROG_TEST_ONLY_RELAY_FAKE',
  'FakeRelayGate',
] as const;
const TESTING_LIBRARY = 'RarogTransportTesting';

interface Hit { readonly line: number; readonly name: string }
interface Scan { readonly outside: Hit[]; readonly inside: Hit[]; readonly error: string | null }

/** Dyrektywa kompilacji warunkowej Swift na początku linii (po wcięciu), bez komentarza na końcu. */
function directive(line: string): { kind: string; condition: string } | null {
  const m = /^\s*#(if|elseif|else|endif)\b(.*)$/.exec(line);
  if (!m) return null;
  return { kind: m[1] ?? '', condition: (m[2] ?? '').replace(/\/\/.*$/, '').trim() };
}

/** Stan leksera Swift na granicy linii: głębokość komentarza blokowego i otwarty napis wielowierszowy. */
interface LexState { depth: number; multiline: number | null }

/**
 * Przesuwa stan leksera przez jedną linię: komentarze blokowe (Swift je zagnieżdża), napisy wielowierszowe
 * i surowe (`#"""`), napisy jednoliniowe (żeby `"/*"` nie otwierało komentarza) i komentarz liniowy.
 */
function advance(state: LexState, line: string): void {
  let i = 0;
  while (i < line.length) {
    if (state.multiline !== null) {
      const close = '"""' + '#'.repeat(state.multiline);
      if (line.startsWith(close, i)) {
        i += close.length;
        state.multiline = null;
      } else {
        i += 1;
      }
    } else if (state.depth > 0) {
      if (line.startsWith('/*', i)) {
        state.depth += 1;
        i += 2;
      } else if (line.startsWith('*/', i)) {
        state.depth -= 1;
        i += 2;
      } else {
        i += 1;
      }
    } else if (line.startsWith('//', i)) {
      return;
    } else if (line.startsWith('/*', i)) {
      state.depth = 1;
      i += 2;
    } else {
      let hashes = 0;
      while (line[i + hashes] === '#') hashes += 1;
      if (line.startsWith('"""', i + hashes)) {
        state.multiline = hashes;
        i += hashes + 3;
      } else if (line[i + hashes] === '"') {
        i = endOfString(line, i + hashes + 1, hashes);
      } else {
        i += hashes > 0 ? hashes : 1;
      }
    }
  }
}

/** Indeks za końcem napisu jednoliniowego zaczętego przed `from` (`hashes` = liczba `#` surowego napisu). */
function endOfString(line: string, from: number, hashes: number): number {
  const close = '"' + '#'.repeat(hashes);
  let i = from;
  while (i < line.length) {
    if (hashes === 0 && line[i] === '\\') {
      i += 2;
    } else if (line.startsWith(close, i)) {
      return i + close.length;
    } else {
      i += 1;
    }
  }
  return i;
}

/**
 * Wystąpienia `names` w `source` w gałęzi `#if DEBUG` i poza nią. Gałąź `#if DEBUG` obejmuje zagnieżdżone bloki;
 * jej `#else` i `#elseif` są poza nią. Dyrektywą jest tylko linia, która zaczyna się poza komentarzem blokowym
 * i poza napisem wielowierszowym. Nazwy liczą się w całym tekście, także w komentarzach. Dyrektywa bez pary to
 * `error`.
 */
export function scanDebugOnly(source: string, names: readonly string[]): Scan {
  const frames: { debug: boolean }[] = [];
  const outside: Hit[] = [];
  const inside: Hit[] = [];
  const lex: LexState = { depth: 0, multiline: null };
  const lines = source.split('\n');
  for (const [index, text] of lines.entries()) {
    const found = names.filter((name) => text.includes(name)).map((name) => ({ line: index + 1, name }));
    (frames.some((frame) => frame.debug) ? inside : outside).push(...found);
    const inCode = lex.depth === 0 && lex.multiline === null;
    advance(lex, text);
    const d = inCode ? directive(text) : null;
    if (d === null) continue;
    if (d.kind === 'if') {
      frames.push({ debug: d.condition === 'DEBUG' });
    } else if (frames.length === 0) {
      return { outside, inside, error: `linia ${String(index + 1)}: #${d.kind} bez #if` };
    } else if (d.kind === 'endif') {
      frames.pop();
    } else {
      frames[frames.length - 1] = { debug: false };
    }
  }
  return { outside, inside, error: frames.length > 0 ? `${String(frames.length)} × #if bez #endif` : null };
}

// --- project.pbxproj ----------------------------------------------------------------------------------------------

interface PbxObject { readonly id: string; readonly name: string; readonly body: string }

/** Obiekty wieloliniowe projektu (stoją na dwóch tabulatorach) z tym `isa`. */
function pbxObjects(pbx: string, isa: string): PbxObject[] {
  const re = /^\t\t(\w{24}) \/\* ([^*]+) \*\/ = \{\n([\s\S]*?)^\t\t\};$/gm;
  return [...pbx.matchAll(re)]
    .filter((m) => m[3]?.includes(`\t\t\tisa = ${isa};`))
    .map((m) => ({ id: m[1] ?? '', name: m[2] ?? '', body: m[3] ?? '' }));
}

/** Identyfikatory z listy `key = ( … );` w ciele obiektu. */
function listIds(body: string, key: string): string[] {
  const list = new RegExp(`\\t\\t\\t${key} = \\(\\n([\\s\\S]*?)\\t\\t\\t\\);`).exec(body)?.[1] ?? '';
  return [...list.matchAll(/(\w{24}) \/\*/g)].map((m) => m[1] ?? '');
}

/** Nazwy z listy `key = ( … );` (pliki wyjątków członkostwa). */
function listNames(body: string, key: string): string[] {
  const list = new RegExp(`\\t\\t\\t${key} = \\(\\n([\\s\\S]*?)\\t\\t\\t\\);`).exec(body)?.[1] ?? '';
  return [...list.matchAll(/^\t+([^,\s]+),$/gm)].map((m) => m[1] ?? '');
}

interface Linked { readonly target: string; readonly productType: string; readonly products: string[] }

/** Produkty pakietów, które linkuje każdy cel: zależności produktu i pliki fazy Frameworks. */
export function linkedProducts(pbx: string): Linked[] {
  const productName = new Map(pbxObjects(pbx, 'XCSwiftPackageProductDependency').map((o) =>
    [o.id, /\t\t\tproductName = (\w+);/.exec(o.body)?.[1] ?? '']));
  const buildFileProduct = new Map([...pbx.matchAll(
    /^\t\t(\w{24}) \/\* [^*]+ \*\/ = \{isa = PBXBuildFile; productRef = (\w{24}) /gm,
  )].map((m) => [m[1] ?? '', m[2] ?? '']));
  const frameworks = new Map(pbxObjects(pbx, 'PBXFrameworksBuildPhase').map((o) => [o.id, listIds(o.body, 'files')]));
  return pbxObjects(pbx, 'PBXNativeTarget').map((target) => {
    const refs = [
      ...listIds(target.body, 'packageProductDependencies'),
      ...listIds(target.body, 'buildPhases').flatMap((phase) => frameworks.get(phase) ?? [])
        .map((file) => buildFileProduct.get(file) ?? ''),
    ];
    return {
      target: target.name,
      productType: /\t\t\tproductType = "([^"]+)";/.exec(target.body)?.[1] ?? '',
      products: [...new Set(refs.map((ref) => productName.get(ref) ?? `?${ref}`))].sort(),
    };
  });
}

const RELEASE_TYPES = ['com.apple.product-type.application', 'com.apple.product-type.app-extension'];

/** Cele wydania (apka, rozszerzenia), które linkują bibliotekę atrap. */
export function releaseTargetsWithTesting(pbx: string): string[] {
  return linkedProducts(pbx)
    .filter((t) => RELEASE_TYPES.includes(t.productType) && t.products.includes(TESTING_LIBRARY))
    .map((t) => t.target);
}

// --- testy ---------------------------------------------------------------------------------------------------------

describe('reguła `#if DEBUG` (przypadki)', () => {
  const names = ['RAROG_RELAY_FAKE_GATE', 'FakeRelayGate'];
  const scan = (source: string): Scan => scanDebugOnly(source, names);

  it('nazwa w gałęzi `#if DEBUG`, także w zagnieżdżonym bloku, jest w środku', () => {
    expect(scan([
      'let a = 1',
      '#if DEBUG',
      'final class AppFakeRelayGate {}',
      '  #if os(iOS)',
      '  let k = "RAROG_RELAY_FAKE_GATE"',
      '  #else',
      '  // RAROG_RELAY_FAKE_GATE',
      '  #endif',
      '#endif',
    ].join('\n'))).toEqual({
      outside: [],
      inside: [{ line: 3, name: 'FakeRelayGate' }, { line: 5, name: 'RAROG_RELAY_FAKE_GATE' },
        { line: 7, name: 'RAROG_RELAY_FAKE_GATE' }],
      error: null,
    });
  });

  it.each<[string, string[], Hit[]]>([
    ['po `#endif`', ['#if DEBUG', '#endif', 'let k = "RAROG_RELAY_FAKE_GATE"'], [{ line: 3, name: 'RAROG_RELAY_FAKE_GATE' }]],
    ['w `#else`', ['#if DEBUG', 'let a = 1', '#else', 'let g = FakeRelayGate()', '#endif'],
      [{ line: 4, name: 'FakeRelayGate' }]],
    ['w `#elseif`', ['#if DEBUG', '#elseif os(iOS)', 'let g = FakeRelayGate()', '#endif'],
      [{ line: 3, name: 'FakeRelayGate' }]],
    ['pod `#if !DEBUG`', ['#if !DEBUG', 'let g = FakeRelayGate()', '#endif'], [{ line: 2, name: 'FakeRelayGate' }]],
    ['pod warunkiem złożonym', ['#if DEBUG && os(iOS)', 'let g = FakeRelayGate()', '#endif'],
      [{ line: 2, name: 'FakeRelayGate' }]],
    ['w komentarzu bez bloku', ['/// Atrapa: `RAROG_RELAY_FAKE_GATE=1`.', 'enum Setup {}'],
      [{ line: 1, name: 'RAROG_RELAY_FAKE_GATE' }]],
    ['między pozornymi dyrektywami w komentarzu blokowym',
      ['/*', '#if DEBUG', '*/', 'let o = env["RAROG_RELAY_FAKE_GATE"]', '/*', '#endif', '*/'],
      [{ line: 4, name: 'RAROG_RELAY_FAKE_GATE' }]],
    ['między pozornymi dyrektywami w zagnieżdżonym komentarzu blokowym',
      ['/* a /* b */', '#if DEBUG', '*/', 'let g = FakeRelayGate()', '/*', '#endif', '*/'],
      [{ line: 4, name: 'FakeRelayGate' }]],
    ['między pozornymi dyrektywami w napisie wielowierszowym',
      ['let s = """', '#if DEBUG', '"""', 'let g = FakeRelayGate()', 'let t = """', '#endif', '"""'],
      [{ line: 4, name: 'FakeRelayGate' }]],
    ['między pozornymi dyrektywami w surowym napisie wielowierszowym',
      ['let s = #"""', '"""', '#if DEBUG', '"""#', 'let g = FakeRelayGate()', 'let t = #"""', '#endif', '"""#'],
      [{ line: 5, name: 'FakeRelayGate' }]],
  ])('nazwa %s jest poza gałęzią Debug (przypadek ujemny)', (_name, lines, outside) => {
    const result = scan(lines.join('\n'));
    expect(result.outside).toEqual(outside);
    expect(result.error).toBeNull();
  });

  it('dyrektywa po komentarzu blokowym zamkniętym w linii i po napisie z „/*” liczy się', () => {
    expect(scan([
      'let s = "/*" /* zamknięty */',
      '#if DEBUG',
      'let g = FakeRelayGate()',
      '#endif',
    ].join('\n'))).toEqual({ outside: [], inside: [{ line: 3, name: 'FakeRelayGate' }], error: null });
  });

  it.each<[string, string[], string]>([
    ['`#endif` bez `#if`', ['let a = 1', '#endif'], 'linia 2: #endif bez #if'],
    ['`#else` bez `#if`', ['#else'], 'linia 1: #else bez #if'],
    ['`#if` bez `#endif`', ['#if DEBUG', 'let g = FakeRelayGate()'], '1 × #if bez #endif'],
  ])('dyrektywa bez pary: %s', (_name, lines, error) => {
    expect(scan(lines.join('\n')).error).toBe(error);
  });
});

describe('źródła apki: atrapy rejestru relaya tylko w Debug', () => {
  const files = repoFiles(REPO, APP_SOURCES).filter((file) => file.endsWith('.swift'));

  it('nazwy tylko dla Debug stoją wyłącznie w gałęzi `#if DEBUG`', () => {
    expect(files.length, `pliki Swift w ${APP_SOURCES}`).toBeGreaterThan(0);
    const outside: string[] = [];
    const errors: string[] = [];
    for (const file of files) {
      const result = scanDebugOnly(readRepo(file), DEBUG_ONLY);
      outside.push(...result.outside.map((hit) => `${file}:${String(hit.line)} ${hit.name}`));
      if (result.error !== null) errors.push(`${file}: ${result.error}`);
    }
    expect(errors, 'dyrektywy kompilacji bez pary').toEqual([]);
    expect(outside, 'przenieś do bloku `#if DEBUG … #endif` (kod i komentarz): build wydania nie może ich nieść')
      .toEqual([]);
  });

  it('każda nazwa stoi w apce co najmniej raz (w gałęzi Debug)', () => {
    const seen = new Set(files.flatMap((file) => scanDebugOnly(readRepo(file), DEBUG_ONLY).inside.map((h) => h.name)));
    expect(DEBUG_ONLY.filter((name) => !seen.has(name)), 'nazwa bez wystąpienia: reguła nie ma czego pilnować')
      .toEqual([]);
  });
});

describe('`project.pbxproj`: biblioteka atrap poza celami wydania', () => {
  const pbx = readRepo(PBXPROJ);
  const targets = linkedProducts(pbx);

  it('apka i rozszerzenia nie linkują `RarogTransportTesting`, testy UIKit linkują', () => {
    const byName = new Map(targets.map((t) => [t.target, t]));
    expect(byName.get('Rarog')?.productType).toBe('com.apple.product-type.application');
    for (const name of ['RarogWidgets', 'RarogNotificationService']) {
      expect(byName.get(name)?.productType, name).toBe('com.apple.product-type.app-extension');
    }
    expect(targets.filter((t) => RELEASE_TYPES.includes(t.productType)).map((t) => t.target).sort())
      .toEqual(['Rarog', 'RarogNotificationService', 'RarogWidgets']);
    expect(targets.flatMap((t) => t.products).filter((p) => p.startsWith('?')), 'odwołanie bez obiektu').toEqual([]);
    expect(byName.get('Rarog')?.products).toContain('RarogTransport');
    expect(byName.get('RarogUIKitTests')?.products, 'kontrola czytnika').toContain(TESTING_LIBRARY);
    expect(releaseTargetsWithTesting(pbx)).toEqual([]);
  });

  it.each<[string, (pbx: string) => string]>([
    ['zależność produktu w celu apki', (text) => text.replace(
      '\t\t\t\t300000000000000000000070 /* RarogIroh */,\n',
      '\t\t\t\t300000000000000000000070 /* RarogIroh */,\n\t\t\t\t2B0000000000000000000074 /* RarogTransportTesting */,\n')],
    ['plik fazy Frameworks w celu NSE', (text) => text.replace(
      '\t\t\t\t2F0000000000000000000081 /* RarogTransport in Frameworks */,\n',
      '\t\t\t\t2F0000000000000000000081 /* RarogTransport in Frameworks */,\n'
        + '\t\t\t\t2B0000000000000000000084 /* RarogTransportTesting in Frameworks */,\n')],
  ])('przypadek ujemny: %s przewraca regułę', (_name, mutate) => {
    const mutated = mutate(pbx);
    expect(mutated).not.toBe(pbx);
    expect(releaseTargetsWithTesting(mutated)).toHaveLength(1);
  });

  it('`RelayGates.swift` i `RelayAccessSetup.swift` kompilują się też w celu testów UIKit', () => {
    const uikit = targets.find((t) => t.target === 'RarogUIKitTests');
    expect(uikit).toBeDefined();
    const sets = pbxObjects(pbx, 'PBXFileSystemSynchronizedBuildFileExceptionSet')
      .filter((o) => o.body.includes('/* RarogUIKitTests */;') && o.name.includes('"Rarog" folder'));
    expect(sets).toHaveLength(1);
    expect(listNames(sets[0]?.body ?? '', 'membershipExceptions'))
      .toEqual(expect.arrayContaining(['RelayGates.swift', 'RelayAccessSetup.swift']));
  });
});
