/**
 * `scripts/gdzie-testy.mjs`: the tests of a source file or a Swift type, with a ready command per group.
 *
 * Cases run the script on the real repo. A TypeScript case asks vitest for the import graph (`vitest related`),
 * which takes seconds, so each case gets its own time limit; Swift cases read files only.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIMIT_MS = 120_000;

interface Run {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

function runIn(root: string, ...args: string[]): Run {
  // The child starts its own vitest instance; the worker's VITEST_* variables would make it think it runs inside one.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST')));
  const script = path.join(root, 'scripts', 'gdzie-testy.mjs');
  const r = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', timeout: LIMIT_MS, env });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const run = (...args: string[]): Run => runIn(REPO, ...args);

/** Groups of the output: heading line → listed lines (paths or `Class  path`, without command lines). */
function groups(out: string): { heading: string; items: string[] }[] {
  const result: { heading: string; items: string[] }[] = [];
  for (const line of out.split('\n').slice(1)) {
    if (line === '') continue;
    if (!line.startsWith(' ')) result.push({ heading: line, items: [] });
    else if (/^ {2}\S/u.test(line) && !line.startsWith('  run: ')) result.at(-1)?.items.push(line.trim());
  }
  return result;
}

const serverTests = readdirSync(path.join(REPO, 'server/test')).filter((f) => f.endsWith('.test.ts'));

const DIRECT = /^Import the module directly \(\d+\):$/u;

describe('gdzie-testy: TypeScript module', () => {
  it('layer1/top.ts: tests named `layer1-top*` first, then other dependents, incl. a test that imports only observe.ts', { timeout: LIMIT_MS + 10_000 }, () => {
    const r = run('server/src/herdr/dialogs/layer1/top.ts', '--wszystkie');
    expect(r.code, r.err).toBe(0);
    const [named, ...rest] = groups(r.out);
    expect(named?.heading).toMatch(/^Named after the module \(\d+\):$/u);
    const top = serverTests.filter((f) => f.startsWith('layer1-top')).map((f) => `server/test/${f}`);
    expect(top.length).toBeGreaterThanOrEqual(3);
    for (const t of top) expect(named?.items).toContain(t);

    const other = rest.find((g) => g.heading.startsWith('Other dependent tests'));
    const count = Number(/\((\d+)\):$/u.exec(other?.heading ?? '')?.[1]);
    expect(count).toBeGreaterThanOrEqual(4);
    expect(other?.items).toHaveLength(count);
    // Depends on top.ts only through observe.ts: vitest's import graph finds it, a name search does not.
    const viaObserve = serverTests.filter((f) => {
      const src = readFileSync(path.join(REPO, 'server/test', f), 'utf8');
      return /from '[^']*layer1\/observe\.ts'/u.test(src) && !/from '[^']*layer1\/top\.ts'/u.test(src);
    }).map((f) => `server/test/${f}`);
    expect(viaObserve.length).toBeGreaterThan(0);
    expect(viaObserve.filter((t) => other?.items.includes(t))).not.toEqual([]);
  });

  it('config-env.ts: `env-registry.test.ts` (synonym) is the first test', { timeout: LIMIT_MS + 10_000 }, () => {
    const r = run('server/src/config-env.ts');
    expect(r.code, r.err).toBe(0);
    expect(groups(r.out)[0]?.items[0]).toBe('server/test/env-registry.test.ts');
    expect(r.out).toMatch(/^ {2}run: pnpm exec vitest run server\/test\/env-registry\.test\.ts$/mu);
  });

  it('herdr/socket.ts: other dependents collapse to a count; --wszystkie lists them all', { timeout: 2 * LIMIT_MS + 10_000 }, () => {
    const short = run('server/src/herdr/socket.ts');
    expect(short.code, short.err).toBe(0);
    const collapsed = /^Other dependent tests \(vitest related\): (\d+) more \(list them with --wszystkie\)$/mu.exec(short.out);
    expect(collapsed, short.out).not.toBeNull();
    const count = Number(collapsed?.[1]);
    expect(count).toBeGreaterThan(15);

    const full = run('server/src/herdr/socket.ts', '--wszystkie');
    expect(full.code, full.err).toBe(0);
    const other = groups(full.out).find((g) => g.heading.startsWith('Other dependent tests'));
    expect(other?.heading).toBe(`Other dependent tests (vitest related) (${count}):`);
    expect(other?.items).toHaveLength(count);
  });

  it('screen/auto-deny.ts: tests that import it directly stand by name with a command, transitive ones still collapse', { timeout: 2 * LIMIT_MS + 10_000 }, () => {
    const module = 'server/src/herdr/dialogs/screen/auto-deny.ts';
    const importers = ['server/test/dialogs-auto-refusal-counter.test.ts',
      'server/test/dialogs-operation.test.ts'];
    const r = run(module);
    expect(r.code, r.err).toBe(0);
    const direct = groups(r.out).find((g) => DIRECT.test(g.heading));
    for (const t of importers) expect(direct?.items, r.out).toContain(t);
    expect(r.out).toContain(`  run: pnpm exec vitest run ${direct?.items.join(' ')}\n`);
    expect(r.out).toMatch(/^Other dependent tests \(vitest related\): \d+ more \(list them with --wszystkie\)$/mu);

    // With the full list, a direct importer is not repeated among the transitive dependents.
    const other = groups(run(module, '--wszystkie').out).find((g) => g.heading.startsWith('Other dependent tests'));
    expect(other?.items.length).toBeGreaterThan(15);
    expect(other?.items.filter((t) => direct?.items.includes(t))).toEqual([]);
  });

  it('cli/systemd-unit.ts: dated tests that import it directly stand by name', { timeout: LIMIT_MS + 10_000 }, () => {
    const direct = groups(run('server/src/cli/systemd-unit.ts').out).find((g) => DIRECT.test(g.heading));
    expect(direct?.items).toContain('server/test/rarog-service-linux.test.ts');
    expect(direct?.items).toContain('server/test/hook-copy.test.ts');
  });

  it('a module no test imports or names: the sentence and exit code 1', { timeout: LIMIT_MS + 10_000 }, () => {
    const r = run('server/src/log-timestamps-install.ts');
    expect(r.code).toBe(1);
    expect(r.out).toBe('server/src/log-timestamps-install.ts: no tests reference this module\n');
  });
});

describe('gdzie-testy: what counts as a direct import (a made-up repo)', () => {
  /** A repo with the script, `server/src/widget.ts` and tests that reach it in different ways; returns its root. */
  function madeUpRepo(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'gdzie-'));
    const put = (rel: string, text: string): void => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    };
    mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
    copyFileSync(path.join(REPO, 'scripts', 'gdzie-testy.mjs'), path.join(root, 'scripts', 'gdzie-testy.mjs'));
    copyFileSync(path.join(REPO, 'scripts', 'lib', 'repo-files.mjs'), path.join(root, 'scripts', 'lib', 'repo-files.mjs'));
    symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'));
    put('.gitignore', 'node_modules\n');
    put('server/src/widget.ts', 'export type Widget = number;\nexport const widget: Widget = 1;\n');
    put('server/src/via.ts', "import { widget } from './widget.ts';\nexport const via = widget + 1;\n");
    put('server/test/widget.test.ts', "import { widget } from '../src/widget.ts';\nexport const a = widget;\n");
    for (let i = 1; i <= 16; i++) {
      put(`server/test/plain-${String(i).padStart(2, '0')}.test.ts`,
        "import { widget } from '../src/widget.ts';\nexport const a = widget;\n");
    }
    put('server/test/dynamic.test.ts', "const m = await import('../src/widget.ts');\nexport const a = m.widget;\n");
    put('server/test/mocked.test.ts', "import { vi } from 'vitest';\nvi.mock('../src/widget.ts', () => ({ widget: 2 }));\n");
    put('server/test/type-only.test.ts', "import type { Widget } from '../src/widget.ts';\nexport const a: Widget = 3;\n");
    // With `verbatimModuleSyntax` (the repo's setting) this one stays as `import '../src/widget.ts'` and runs the module.
    put('server/test/inline-type.test.ts', "import { type Widget } from '../src/widget.ts';\nexport const a: Widget = 3;\n");
    put('server/test/reexport-type.test.ts', "export { type Widget } from '../src/widget.ts';\n");
    put('server/test/in-text.test.ts', [
      "// import { widget } from '../src/widget.ts';",
      "export const sample = \"import { widget } from '../src/widget.ts'\";",
      "export const code = `await import('../src/widget.ts')`;",
      '',
    ].join('\n'));
    put('server/test/via.test.ts', "import { via } from '../src/via.ts';\nexport const a = via;\n");
    return root;
  }

  it('value import, `import { type }`, `import()` and `vi.mock` count; `import type`, a type-only re-export, a comment and a string do not', { timeout: LIMIT_MS + 10_000 }, () => {
    const r = runIn(madeUpRepo(), 'server/src/widget.ts');
    expect(r.code, r.err).toBe(0);
    const all = groups(r.out);
    expect(all[0]?.items).toEqual(['server/test/widget.test.ts']);
    const direct = all.find((g) => DIRECT.test(g.heading));
    const plain = Array.from({ length: 16 }, (_, i) => `server/test/plain-${String(i + 1).padStart(2, '0')}.test.ts`);
    // More than the list limit (15), all by name without --wszystkie.
    expect(direct?.items, r.out).toEqual(['server/test/dynamic.test.ts', 'server/test/inline-type.test.ts',
      'server/test/mocked.test.ts', ...plain]);
    const items = all.flatMap((g) => g.items);
    expect(items).toEqual([...new Set(items)]);
    expect(all.find((g) => g.heading.startsWith('Other dependent tests'))?.items).toContain('server/test/via.test.ts');
  });
});

describe('gdzie-testy: Swift', () => {
  it('RarogStore+Send.swift: a test that reads the source without importing it is listed with its command', () => {
    const r = run('native/Rarog/Packages/RarogCore/Sources/RarogCore/RarogStore+Send.swift');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('  server/test/send-limit.test.ts\n'
      + '    pnpm exec vitest run server/test/send-limit.test.ts\n');
  });

  it('PermissionCard: XCTest classes and a `@Suite` struct, each with its ios-test.sh command', () => {
    // The case needs a Swift Testing suite written as `struct` with `@Suite`.
    const suite = readFileSync(path.join(REPO,
      'native/Rarog/Packages/RarogUI/Tests/RarogUILogicTests/ConsentCardTests.swift'), 'utf8');
    expect(suite).toMatch(/^@Suite\(.*\)\nstruct ConsentCardTests \{/mu);

    const r = run('PermissionCard');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('  PermissionCardTileTests  native/Rarog/RarogUIKitTests/PermissionCardTileTests.swift\n'
      + '    bash scripts/ios-test.sh RarogUIKitTests/PermissionCardTileTests\n');
    expect(r.out).toContain('  ConsentCardViewTests  native/Rarog/RarogUIKitTests/ConsentCardViewTests.swift\n'
      + '    bash scripts/ios-test.sh RarogUIKitTests/ConsentCardViewTests\n');
    expect(r.out).toContain(
      '  ConsentCardTests  native/Rarog/Packages/RarogUI/Tests/RarogUILogicTests/ConsentCardTests.swift\n'
      + '    bash scripts/ios-test.sh --package RarogUI --filter ConsentCardTests\n');
    // The tile test carries the type in its name, so it comes before the other users of the type.
    expect(r.out.indexOf('PermissionCardTileTests')).toBeLessThan(r.out.indexOf('ConsentCardTests'));
    expect(r.out).not.toContain('xcodebuild');
  });

  it('a Swift type no test uses: the sentence and exit code 1', () => {
    const r = run('NoSuchTypeAnywhere');
    expect(r.code).toBe(1);
    expect(r.out).toBe('NoSuchTypeAnywhere: no tests reference this module\n');
  });
});

describe('gdzie-testy: usage', () => {
  it('no argument, two modules or a missing file: usage and exit code 2', () => {
    for (const args of [[], ['a.ts', 'b.ts'], ['server/src/no-such-file.ts']]) {
      const r = run(...args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err).toContain('usage: node scripts/gdzie-testy.mjs');
    }
  });
});
