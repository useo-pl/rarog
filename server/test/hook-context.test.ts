/**
 * Hook kontekstu `SessionStart` (`scripts/hooks/rarog-context.mjs`): w panelu herdr
 * pod korzeniami Raroga podaje modelowi format znacznika pytania („Do Ciebie”), wszędzie indziej milczy.
 *
 * Kontrakt jest procesowy (stdin i środowisko → stdout, kod zawsze 0), więc każdy przypadek skryptu uruchamia go jako
 * proces z WŁASNYM środowiskiem (bez `HERDR_ENV` procesu testów, który bywa uruchomiony w panelu herdr). Druga połowa:
 * wpis w ustawieniach ma własny stan (`hooks:print`, `hooks:doctor`), a `/health` (`rarogHookEntries`) go nie liczy.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTEXT_HOOK_EVENT, HOOK_INSTALL_FILES, HOOK_TIMEOUT_S, contextHookBlock, contextHookCommand, expectedHookEntries,
  hookBlock, hookCommand, hookInstallDir, inspectContextHook, inspectSettingsFile, pasteHookBlock, rarogHookEntries,
  writeHookRoots,
} from '../src/herdr/hook-config.ts';
import { realRarogDirsCreated } from './rarog-home.ts';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'hooks', 'rarog-context.mjs');
const CLI = join(REPO, 'bin', 'rarog.mjs');
const SOURCES = ['startup', 'resume', 'clear', 'compact', 'fork'] as const;

let dir = '';
let data = '';
let root = '';
let project = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rarog-context-'));
  data = join(dir, 'data');
  root = join(dir, 'Projects');
  project = join(root, 'apka');
  mkdirSync(project, { recursive: true });
  writeHookRoots(data, [root]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  expect(realRarogDirsCreated()).toEqual([]);
});

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

/** Skrypt jako proces: `stdin` = tekst na wejściu, `herdr` = `HERDR_ENV=1`. Środowisko budujemy od zera. */
function runHook(stdin: string, options: { readonly herdr?: boolean; readonly dataDir?: string } = {}): Promise<Run> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '', HOME: dir, RAROG_DATA_DIR: options.dataDir ?? data,
    ...(options.herdr === false ? {} : { HERDR_ENV: '1' }),
  };
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => { resolve({ code, stdout, stderr, ms: Date.now() - started }); });
    child.stdin.end(stdin);
  });
}

/** Wejście `SessionStart` w kształcie z docs hooków (pola, które hook czyta, plus `session_id`). */
const input = (source: string, cwd = project): string => JSON.stringify({
  session_id: '550e8400-e29b-41d4-a716-446655440000', hook_event_name: 'SessionStart', source, cwd,
  transcript_path: join(dir, 'rozmowa.jsonl'),
});

/** Cisza: kod 0, nic na stdout i stderr. */
const SILENT = { code: 0, stdout: '', stderr: '' };

describe('rarog-context.mjs: kontekst w panelu herdr pod korzeniem', () => {
  for (const source of SOURCES) {
    it(`HERDR_ENV=1 i cwd pod korzeniem, source ${source} → JSON z pełnym formatem znacznika`, async () => {
      const run = await runHook(input(source));
      expect(run.code).toBe(0);
      expect(run.stderr).toBe('');
      expect(run.stdout.endsWith('\n')).toBe(true);
      const parsed = JSON.parse(run.stdout) as { hookSpecificOutput: Record<string, unknown> };
      expect(Object.keys(parsed)).toEqual(['hookSpecificOutput']);
      expect(parsed.hookSpecificOutput['hookEventName']).toBe('SessionStart');
      const text = parsed.hookSpecificOutput['additionalContext'];
      expect(typeof text).toBe('string');
      // Pełny format renderera (`MarkdownQuestion.swift`): osobny akapit najwyższego poziomu, pogrubiony znacznik na
      // początku, oba znaczniki, blok do końca odpowiedzi; fakt, nie polecenie.
      for (const part of ['Rarog pane', 'orange bar', 'own top-level paragraph', 'not inside a list, quote or heading',
        'starts with the bold marker **To you:**', '**Do Ciebie:** in Polish replies', 'to the end of the reply']) {
        expect(text, part).toContain(part);
      }
      expect(String(text).length).toBeLessThan(10_000);
    });
  }

  it('cwd to sam korzeń, przez dowiązanie → kontekst (porównanie po realpath)', async () => {
    const link = join(dir, 'skrot');
    symlinkSync(project, link);
    const run = await runHook(input('startup', link));
    expect(run.stdout).toContain('"additionalContext"');
    expect((await runHook(input('startup', root))).stdout).toContain('"additionalContext"');
  });

  it('czas poniżej 200 ms na ścieżce z kontekstem (bez sieci; margines na zimny start node w teście)', async () => {
    const runs = await Promise.all([runHook(input('startup')), runHook(input('startup')), runHook(input('startup'))]);
    expect(Math.min(...runs.map((run) => run.ms))).toBeLessThan(1000);
  });
});

describe('rarog-context.mjs: cisza i kod 0 w każdym innym przypadku', () => {
  it('brak HERDR_ENV → nic, kod 0', async () => {
    expect(await runHook(input('startup'), { herdr: false })).toMatchObject(SILENT);
  });

  it('cwd poza korzeniami → nic, kod 0', async () => {
    const outside = join(dir, 'gdzie-indziej');
    mkdirSync(outside);
    expect(await runHook(input('startup', outside))).toMatchObject(SILENT);
    // Prefiks nazwy to nie korzeń: `Projects-klient` nie leży w `Projects`.
    const sibling = `${root}-klient`;
    mkdirSync(sibling);
    expect(await runHook(input('startup', sibling))).toMatchObject(SILENT);
    // `cwd`, którego nie ma, nie da się rozwiązać: fail-closed.
    expect(await runHook(input('startup', join(root, 'nie-ma')))).toMatchObject(SILENT);
  });

  it('brak roots.json → nic, kod 0', async () => {
    expect(await runHook(input('startup'), { dataDir: join(dir, 'pusty') })).toMatchObject(SILENT);
    writeFileSync(join(data, 'roots.json'), '{"roots": []}\n');
    expect(await runHook(input('startup'))).toMatchObject(SILENT);
  });

  it('zły JSON na wejściu → nic, kod 0', async () => {
    for (const bad of ['{"hook_event_name": ', '[]', 'null', '"SessionStart"', '']) {
      expect(await runHook(bad), bad).toMatchObject(SILENT);
    }
  });

  it('inne zdarzenie albo brak cwd → nic, kod 0', async () => {
    const other = JSON.stringify({ hook_event_name: 'PreToolUse', cwd: project, tool_name: 'Bash' });
    expect(await runHook(other)).toMatchObject(SILENT);
    expect(await runHook(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }))).toMatchObject(SILENT);
  });
});

describe('wpis hooka kontekstu w ustawieniach: własny stan, poza `/health`', () => {
  const settings = (hooks: unknown): string => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify(hooks));
    return path;
  };
  const command = (): string => contextHookCommand(dir);

  it('komenda wskazuje kopię, blok `SessionStart` bez matchera z sufitem 5 s', () => {
    expect(command()).toBe(`node '${dir}/.claude/hooks/rarog/rarog-context.mjs'`);
    expect(contextHookBlock(command())).toEqual({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: command(), timeout: HOOK_TIMEOUT_S }] }] },
    });
    expect(CONTEXT_HOOK_EVENT).toBe('SessionStart');
    expect(HOOK_INSTALL_FILES, 'plik hooka kontekstu leży w kopii hooka').toContain('rarog-context.mjs');
  });

  it('`ok` dla drukowanego wpisu; `missing` bez wpisu i bez pliku; `mismatch` dla innego wpisu i złego JSON', () => {
    expect(inspectContextHook(settings(pasteHookBlock(hookCommand(dir), command())), command()).status).toBe('ok');
    expect(inspectContextHook(settings(hookBlock(hookCommand(dir))), command()).status).toBe('missing');
    expect(inspectContextHook(join(dir, 'nie-ma.json'), command()).status).toBe('missing');
    const noTimeout = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: command() }] }] } };
    expect(inspectContextHook(settings(noTimeout), command()).status).toBe('mismatch');
    const checkout = `node ${join(REPO, 'scripts', 'hooks', 'rarog-context.mjs')}`;
    expect(inspectContextHook(settings(contextHookBlock(checkout)), command()))
      .toMatchObject({ status: 'mismatch', checkout: true });
    writeFileSync(join(dir, 'zepsute.json'), '{ "hooks": ');
    expect(inspectContextHook(join(dir, 'zepsute.json'), command())).toMatchObject({ status: 'mismatch', readable: false });
  });

  it('wpis kontekstu nie jest wpisem hooka zgód: blok zgód z nim dalej `ok`, sam wpis to `missing` hooka', () => {
    const expected = expectedHookEntries(hookCommand(dir));
    const both = settings(pasteHookBlock(hookCommand(dir), command()));
    expect(inspectSettingsFile(both, expected).status).toBe('ok');
    expect(rarogHookEntries(pasteHookBlock(hookCommand(dir), command())).map((one) => one.event).sort())
      .toEqual(['PermissionRequest', 'PreToolUse']);
    expect(inspectSettingsFile(settings(contextHookBlock(command())), expected).status).toBe('missing');
  });
});

/** `rarog hooks …` jako proces z `HOME` testu i `PATH` bez herdr. */
function runCli(args: readonly string[]): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'hooks', ...args], {
      cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => { resolve({ code, stdout, stderr, ms: Date.now() - started }); });
  });
}

describe('`hooks:print` i `hooks:doctor` z hookiem kontekstu', () => {
  it('`hooks:print` zawiera blok `SessionStart` hooka kontekstu obok bloku zgód', async () => {
    const run = await runCli(['print']);
    expect(run.code).toBe(0);
    const block = JSON.parse(run.stdout.slice(run.stdout.indexOf('{'), run.stdout.lastIndexOf('}') + 1)) as {
      hooks: Record<string, unknown>;
    };
    // The printed block carries all four entries; this test checks only its `hooks` part, the rest is
    // covered in `server/test/hook-config.test.ts`.
    expect(block.hooks).toEqual(
      (pasteHookBlock(hookCommand(dir), contextHookCommand(dir)) as { hooks: Record<string, unknown> }).hooks,
    );
    expect(block.hooks['SessionStart']).toEqual((contextHookBlock(contextHookCommand(dir)) as {
      hooks: Record<string, unknown>;
    }).hooks['SessionStart']);
    expect(run.stdout).toContain('rarog-context.mjs');
  });

  /** Ustawienia `HOME` testu z blokiem zgód (bez wpisu kontekstu, jak u istniejących instalacji) i kopią z repo. */
  function installedWithoutContext(): void {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(hookBlock(hookCommand(dir))));
    const copy = hookInstallDir(dir);
    mkdirSync(copy, { recursive: true });
    for (const name of HOOK_INSTALL_FILES) copyFileSync(join(REPO, 'scripts', 'hooks', name), join(copy, name));
    writeHookRoots(join(dir, '.local', 'share', 'rarog'), [root]);
  }

  it('`hooks:doctor` bez bloku kontekstu → `missing`, kod wyjścia jak dziś (hook `ok` = 0)', async () => {
    installedWithoutContext();
    const run = await runCli(['doctor']);
    expect(run.stdout.split('\n')[0]).toBe('hook: ok   (same value as /health)');
    expect(run.stdout).toContain('context: missing');
    expect(run.stdout).toMatch(/hooks[: ]print/);
    expect(run.code).toBe(0);
  });

  it('`hooks:doctor` bez żadnego bloku → hook `missing` i kontekst `missing`, kod 1 jak dziś', async () => {
    const run = await runCli(['doctor']);
    expect(run.stdout.split('\n')[0]).toBe('hook: missing   (same value as /health)');
    expect(run.stdout).toContain('context: missing');
    expect(run.code).toBe(1);
  });

  it('`hooks:doctor` z pełnym blokiem z `print` → kontekst `ok`, hook `ok`, kod 0', async () => {
    installedWithoutContext();
    writeFileSync(join(dir, '.claude', 'settings.json'),
      JSON.stringify(pasteHookBlock(hookCommand(dir), contextHookCommand(dir))));
    const run = await runCli(['doctor']);
    expect(run.stdout.split('\n')[0]).toBe('hook: ok   (same value as /health)');
    expect(run.stdout).toContain('context: ok');
    expect(run.code).toBe(0);
  });
});
