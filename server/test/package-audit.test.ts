/**
 * Audyt tarballa paczki npm wobec manifestu budowania (`scripts/package-audit.mjs`): prawdziwy `npm pack`
 * małej paczki i tarballe zapisane w teście nagłówkami tar ustar i pax. Sieci nie ma: `npm pack --dry-run` czyta
 * plik tarballa, a rejestr w zmiennej `npm_config_registry` wołającego wskazuje martwy port i nie może dojść do npm.
 *
 * Sprawdza: zgodny tarball przechodzi; każda różnica pliku, nazwy, wersji, sha256, integrity i nazwy pliku daje kod 1
 * z opisem; `--files-only` pomija tylko sha256, integrity i nazwę pliku tarballa; wpisy inne niż plik zwykły,
 * ścieżki poza `package/`, powtórzenia, SDK Anthropic (ścieżka albo pole zależności) i zła suma kontrolna nagłówka
 * to kod 1; złe wywołanie to kod 64; audyt importuje wyłącznie moduły `node:*`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AUDIT = path.join(REPO, 'scripts', 'package-audit.mjs');
const TIMEOUT_MS = 60_000;

interface ManifestFile { path: string; size: number; sha256: string }
interface Manifest {
  name: string;
  version: string;
  tarball: string;
  sha256: string;
  integrity: string;
  entryCount?: number;
  unpackedSize?: number;
  files: ManifestFile[];
}
interface Entry { path: string; type?: '0' | '1' | '2' | '5'; data?: string; linkname?: string; pax?: boolean }

let base = '';

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const integrity = (data: Buffer) => `sha512-${createHash('sha512').update(data).digest('base64')}`;

function audit(args: string[]) {
  // Synchronous: a limit here is the only one that can fire, since a blocked worker never reaches the vitest timeout.
  const result = spawnSync(process.execPath, [AUDIT, ...args], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: { ...process.env, npm_config_registry: 'http://127.0.0.1:9/', npm_config_offline: 'false' },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function header(name: string, size: number, type: string, linkname = ''): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write(type === '5' ? '0000755\0' : '0000644\0', 100, 'latin1');
  block.write('0000000\0', 108, 'latin1');
  block.write('0000000\0', 116, 'latin1');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  block.write(`${(499162500).toString(8).padStart(11, '0')}\0`, 136, 'latin1');
  block.fill(0x20, 148, 156);
  block.write(type, 156, 'latin1');
  block.write(linkname, 157, 100, 'utf8');
  block.write('ustar\u000000', 257, 'latin1');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return block;
}

function padded(data: Buffer): Buffer {
  return Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

/** Rekord pax `<długość> path=<ścieżka>\n`; długość liczy też własne cyfry. */
function paxPath(value: string): Buffer {
  const body = ` path=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length += 1;
  return Buffer.from(`${String(length)}${body}`, 'utf8');
}

function tarGz(entries: Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? '0';
    const data = Buffer.from(entry.data ?? '', 'utf8');
    if (entry.pax === true) {
      const record = paxPath(entry.path);
      blocks.push(header('PaxHeader/long', record.length, 'x'), padded(record));
    }
    blocks.push(header(entry.pax === true ? 'package/long' : entry.path, type === '0' ? data.length : 0, type,
      entry.linkname));
    if (type === '0') blocks.push(padded(data));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function pkgJson(name: string, version: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ name, version, ...extra }, null, 2)}\n`;
}

/** Tarball z wpisów i manifest z plików zwykłych tych wpisów, tak jak pakowacz liczy je z drzewa. */
function writeCase(dir: string, entries: Entry[], options: { name?: string; version?: string } = {}) {
  mkdirSync(dir, { recursive: true });
  const tgz = tarGz(entries);
  const tarball = path.join(dir, 'paczka-1.0.0.tgz');
  writeFileSync(tarball, tgz);
  const files = entries.filter((entry) => (entry.type ?? '0') === '0')
    .map((entry) => ({ path: entry.path.replace(/^package\//u, ''), data: entry.data ?? '' }));
  const manifest: Manifest = {
    name: options.name ?? 'paczka',
    version: options.version ?? '1.0.0',
    tarball: 'paczka-1.0.0.tgz',
    sha256: sha256(tgz),
    integrity: integrity(tgz),
    files: files.map((file) => ({ path: file.path, size: Buffer.byteLength(file.data), sha256: sha256(file.data) })),
  };
  const manifestPath = path.join(dir, 'paczka-1.0.0.build.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { tarball, manifestPath, manifest };
}

const GOOD: Entry[] = [
  { path: 'package/package.json', data: pkgJson('paczka', '1.0.0') },
  { path: 'package/index.js', data: 'export const x = 1;\n' },
  { path: 'package/lib/a.js', data: 'export default 2;\n' },
];

beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'rarog-package-audit-test-')));
});

afterAll(() => {
  if (base !== '') rmSync(base, { recursive: true, force: true });
});

describe('audyt tarballa z `npm pack`', () => {
  let tarball = '';
  let manifest: Manifest;
  let caseNo = 0;

  /** Kopia manifestu po zmianie `change` w nowym pliku. */
  const changed = (change: (copy: Manifest) => void) => {
    const copy = structuredClone(manifest);
    change(copy);
    caseNo += 1;
    const file = path.join(base, `npm-pack-${String(caseNo)}.build.json`);
    writeFileSync(file, JSON.stringify(copy));
    return file;
  };

  beforeAll(() => {
    const src = path.join(base, 'src');
    const out = path.join(base, 'npm-pack');
    mkdirSync(path.join(src, 'bin'), { recursive: true });
    mkdirSync(out);
    writeFileSync(path.join(src, 'package.json'), pkgJson('@scope/paczka', '2.3.4', { bin: { paczka: 'bin/p.js' } }));
    writeFileSync(path.join(src, 'bin', 'p.js'), '#!/usr/bin/env node\nconsole.log(1);\n');
    writeFileSync(path.join(src, 'README.md'), '# paczka\n');
    writeFileSync(path.join(base, 'empty-npmrc'), '');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/iu.test(key)));
    const packed = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', out], {
      cwd: src,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: { ...env, npm_config_userconfig: path.join(base, 'empty-npmrc'), npm_config_cache: path.join(base, 'cache') },
    });
    expect(packed.status, packed.stderr).toBe(0);
    const [result] = JSON.parse(packed.stdout) as [{
      filename: string; integrity: string; entryCount: number; unpackedSize: number; files: { path: string }[];
    }];
    tarball = path.join(out, result.filename);
    manifest = {
      name: '@scope/paczka',
      version: '2.3.4',
      tarball: result.filename,
      sha256: sha256(readFileSync(tarball)),
      integrity: result.integrity,
      entryCount: result.entryCount,
      unpackedSize: result.unpackedSize,
      files: result.files.map((file) => {
        const data = readFileSync(path.join(src, file.path));
        return { path: file.path, size: data.length, sha256: sha256(data) };
      }),
    };
  }, TIMEOUT_MS);

  it('zgodny tarball: kod 0, liczba plików i sha256 na stdout', () => {
    const run = audit(['--name', '@scope/paczka', '--version', '2.3.4', tarball, changed(() => undefined)]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe(`audit: @scope/paczka@2.3.4: 3 files match the manifest, tarball sha256 ${
      manifest.sha256}\n`);
  }, TIMEOUT_MS);

  it.each([
    ['sha256 pliku', (m: Manifest) => { m.files[0]!.sha256 = '0'.repeat(64); }, 'tarball sha256: different values'],
    ['plik spoza manifestu', (m: Manifest) => { m.files.pop(); }, 'files not in the manifest'],
    ['plik z manifestu bez wpisu', (m: Manifest) => { m.files.push({ path: 'x.js', size: 1, sha256: '1'.repeat(64) }); },
      'manifest files missing: x.js'],
    ['rozmiar pliku', (m: Manifest) => { m.files[0]!.size += 1; }, 'npm pack: different values'],
    ['nazwa w manifeście', (m: Manifest) => { m.name = '@scope/inna'; }, 'package.json in the tarball: name'],
    ['wersja w manifeście', (m: Manifest) => { m.version = '2.3.5'; }, 'npm pack: version 2.3.4'],
    ['liczba wpisów', (m: Manifest) => { m.entryCount = 99; }, 'npm pack: entryCount'],
  ])('różnica: %s → kod 1 z opisem', (_label, change, message) => {
    const run = audit([tarball, changed(change)]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(message);
  }, TIMEOUT_MS);

  it('`--name` i `--version` inne niż manifest: kod 1', () => {
    const run = audit(['--name', 'rarog', '--version', '9.9.9', tarball, changed(() => undefined)]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('name: expected rarog, manifest @scope/paczka');
    expect(run.stderr).toContain('version: expected 9.9.9, manifest 2.3.4');
  }, TIMEOUT_MS);

  it('sha256, integrity i nazwa pliku tarballa: kod 1, a z `--files-only` kod 0', () => {
    const other = changed((m) => {
      m.sha256 = 'f'.repeat(64);
      m.integrity = 'sha512-inne';
    });
    const renamed = path.join(path.dirname(tarball), 'pobrany.tgz');
    renameSync(tarball, renamed);
    try {
      const strict = audit([renamed, other]);
      expect(strict.code).toBe(1);
      expect(strict.stderr).toContain(`tarball sha256 ${manifest.sha256}, manifest ${'f'.repeat(64)}`);
      expect(strict.stderr).toContain('npm pack: integrity');
      expect(strict.stderr).toContain(`file pobrany.tgz, manifest ${manifest.tarball}`);
      const filesOnly = audit(['--files-only', renamed, other]);
      expect(filesOnly.code, filesOnly.stderr).toBe(0);
      expect(filesOnly.stdout).toContain('(content only)');
    } finally {
      renameSync(renamed, tarball);
    }
  }, TIMEOUT_MS);

  it('`--files-only` nie zdejmuje różnicy treści', () => {
    const run = audit(['--files-only', tarball, changed((m) => { m.files[1]!.sha256 = '0'.repeat(64); })]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('tarball sha256: different values');
  }, TIMEOUT_MS);
});

describe('audyt wpisów tarballa', () => {
  let caseNo = 0;
  const dir = () => {
    caseNo += 1;
    return path.join(base, `tar-${String(caseNo)}`);
  };

  it('tarball z nagłówkami ustar i pax (długa ścieżka) zgodny z manifestem: kod 0', () => {
    const long = `package/${'d'.repeat(120)}/plik.js`;
    const { tarball, manifestPath } = writeCase(dir(), [...GOOD, { path: long, data: 'x\n', pax: true }]);
    const run = audit([tarball, manifestPath]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('paczka@1.0.0: 4 files');
  }, TIMEOUT_MS);

  it.each([
    ['katalog', { path: 'package/lib/', type: '5' }, 'entry of type 5'],
    ['dowiązanie symboliczne', { path: 'package/link', type: '2', linkname: '/etc/passwd' }, 'entry of type 2'],
    ['dowiązanie twarde', { path: 'package/hard', type: '1', linkname: 'package/index.js' }, 'entry of type 1'],
    ['ścieżka poza `package/`', { path: 'inny/plik.js', data: '1' }, 'outside the package/ directory'],
    ['`..` w ścieżce', { path: 'package/../plik.js', data: '1' }, 'path not allowed'],
    ['powtórzony plik', { path: 'package/index.js', data: 'export const x = 1;\n' }, 'index.js repeated'],
    ['SDK Anthropic w ścieżce', { path: 'package/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
      data: pkgJson('@anthropic-ai/claude-agent-sdk', '1.0.0') }, 'Anthropic SDK in the package'],
  ] as [string, Entry, string][])('%s: kod 1 z opisem', (_label, extra, message) => {
    const { tarball, manifestPath } = writeCase(dir(), [...GOOD, extra]);
    const run = audit([tarball, manifestPath]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(message);
  }, TIMEOUT_MS);

  it('SDK Anthropic w polu zależności `package.json`: kod 1', () => {
    const entries = [{ path: 'package/package.json',
      data: pkgJson('paczka', '1.0.0', { optionalDependencies: { '@anthropic-ai/claude-agent-sdk': '1.0.0' } }) },
    ...GOOD.slice(1)];
    const { tarball, manifestPath } = writeCase(dir(), entries);
    const run = audit([tarball, manifestPath]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('@anthropic-ai/claude-agent-sdk in optionalDependencies');
  }, TIMEOUT_MS);

  /** Tarball z surowych bloków po manifeście z `package.json` i `index.js` o treści `safe`. */
  const rawCase = (blocks: (safe: Buffer, pkg: Buffer) => Buffer[]) => {
    const safe = Buffer.from('console.log("safe");\n');
    const pkg = Buffer.from(GOOD[0]!.data!, 'utf8');
    const { tarball, manifestPath } = writeCase(dir(), [GOOD[0]!, { path: 'package/index.js', data: safe.toString() }]);
    writeFileSync(tarball, gzipSync(Buffer.concat(blocks(safe, pkg))));
    return audit(['--files-only', tarball, manifestPath]);
  };
  const evil = Buffer.from('console.log("evil");\n');

  it('wpis za pojedynczym zerowym blokiem: kod 1', () => {
    const run = rawCase((safe, pkg) => [
      header('package/package.json', pkg.length, '0'), padded(pkg),
      header('package/index.js', safe.length, '0'), padded(safe),
      Buffer.alloc(512),
      header('package/evil.js', evil.length, '0'), padded(evil),
      Buffer.alloc(1024),
    ]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('data past the end of the archive');
  }, TIMEOUT_MS);

  it('plik zwykły z niepustym linkname: kod 1', () => {
    const run = rawCase((safe, pkg) => [
      header('package/package.json', pkg.length, '0'), padded(pkg),
      header('package/index.js', safe.length, '0', 'inny.js'), padded(safe),
      Buffer.alloc(1024),
    ]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('index.js: regular file with linkname');
  }, TIMEOUT_MS);

  it('plik z linkname, zerowy blok i ta sama ścieżka innej treści tej samej długości: kod 1', () => {
    const run = rawCase((safe, pkg) => [
      header('package/package.json', pkg.length, '0'), padded(pkg),
      header('package/index.js', safe.length, '0', 'x'), padded(safe),
      Buffer.alloc(512),
      header('package/index.js', evil.length, '0'), padded(evil),
      Buffer.alloc(1024),
    ]);
    expect(run.code).toBe(1);
  }, TIMEOUT_MS);

  it('zła suma kontrolna nagłówka tar: kod 1', () => {
    const { tarball, manifestPath } = writeCase(dir(), GOOD);
    const tar = gunzipSync(readFileSync(tarball));
    tar[0] = tar[0] === 0x70 ? 0x71 : 0x70;
    writeFileSync(tarball, gzipSync(tar));
    const run = audit(['--files-only', tarball, manifestPath]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('bad header checksum');
  }, TIMEOUT_MS);
});

describe('audyt: wywołanie i kod', () => {
  it('złe wywołanie: kod 64; manifest, który nie jest JSON-em albo nie ma pól: kod 1', () => {
    expect(audit([]).code).toBe(64);
    expect(audit(['jeden.tgz']).code).toBe(64);
    expect(audit(['--nieznana', 'a.tgz', 'b.json']).code).toBe(64);
    const dirPath = path.join(base, 'zly-manifest');
    mkdirSync(dirPath);
    writeFileSync(path.join(dirPath, 'm.json'), '{');
    writeFileSync(path.join(dirPath, 'p.json'), JSON.stringify({ name: 'paczka', files: [] }));
    writeFileSync(path.join(dirPath, 'a.tgz'), '');
    const notJson = audit([path.join(dirPath, 'a.tgz'), path.join(dirPath, 'm.json')]);
    expect(notJson.code).toBe(1);
    expect(notJson.stderr).toContain('not JSON');
    const noFields = audit([path.join(dirPath, 'a.tgz'), path.join(dirPath, 'p.json')]);
    expect(noFields.code).toBe(1);
    expect(noFields.stderr).toContain('no version field');
    expect(noFields.stderr).toContain('no files list');
  }, TIMEOUT_MS);

  it('importuje wyłącznie moduły `node:*` (działa w repo bez `pnpm install`)', () => {
    const code = readFileSync(AUDIT, 'utf8');
    const specifiers = [
      ...code.matchAll(/^\s*import\s[^'"]*?from\s+['"]([^'"]+)['"]/gmu),
      ...code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu),
    ].map((match) => match[1] ?? '');
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((one) => !one.startsWith('node:'))).toEqual([]);
  });
});
