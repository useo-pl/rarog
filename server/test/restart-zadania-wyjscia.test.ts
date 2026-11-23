/**
 * Session restart that meets the CLI exit dialog "Background work is running" after `/exit`: the note
 * names the tasks from that dialog instead of guessing. The behaviour stays: one Esc ("Stay"), restart canceled,
 * session alive, no new process.
 *
 * Two parts: the task lines read from the dialog block (`exitDialogTasks`, pure, over fixture screens) and the
 * manager path through `restart()` with a fake driver whose screen read returns a fixture screen, fails or hangs.
 * The fakes are a trimmed copy of `session-restart.test.ts`: one process on an older release, `/exit`
 * raises the dialog instead of ending it.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HerdrMode, HerdrStatus } from '@rarog/shared';
import { createManager } from '../src/sessions/manager.ts';
import type { HerdrManagerDeps, Manager } from '../src/sessions/manager.ts';
import { RESTART_EXIT_ASKED_DETAIL, restartExitTasksNotice } from '../src/sessions/state-sentences.ts';
import { exitDialogTasks } from '../src/herdr/dialogs/policy/exit-tasks.ts';
import type { RestartProbe } from '../src/drivers/types.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import type { CliRegistryEntry } from '../src/cli-version.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures/herdr');
const screen = (file: string): string => readFileSync(join(FIXTURES, file), 'utf8');

const SCHEDULED = screen('restart/wyjscie-tlo-harmonogram-2.1.322.txt');
const SHELL_2_1_322 = screen('kontrolny/wyjscie-tlo-2.1.322.txt');
const SHELL_2_1_309 = screen('dialog-background-work-exit-2.1.309.txt');
/** A consent dialog: another question on exit. */
const CONSENT = screen('dialog-permission.txt');

/** The 2.1.322 capture with its one task line replaced by `lines` (a case the test builds, not a capture). */
function withTasks(lines: readonly string[]): string {
  return SHELL_2_1_322.replace('   shell · sleep 6007', lines.map((line) => `   ${line}`).join('\n'));
}

describe('exitDialogTasks: task lines of the exit dialog', () => {
  it('scheduled task (CLI 2.1.322) → its line, as the CLI cut it', () => {
    expect(exitDialogTasks(SCHEDULED)).toEqual(['scheduled task · Runs once in 3d · Check the build…']);
  });

  it('shell task in both captures → one line each', () => {
    expect(exitDialogTasks(SHELL_2_1_322)).toEqual(['shell · sleep 6007']);
    expect(exitDialogTasks(SHELL_2_1_309)).toEqual(['shell · B=$(mktemp -d "$TMPDIR/wr-probe.XXXXXX"); cd "$B"…']);
  });

  it('five tasks → five lines in screen order, blank lines skipped', () => {
    const lines = ['shell · sleep 1', 'shell · sleep 2', 'agent · Review', 'shell · sleep 4', 'scheduled task · Daily'];
    expect(exitDialogTasks(withTasks(lines))).toEqual(lines);
  });

  it('another dialog, a screen without a block, or the exit dialog without the list header → null', () => {
    expect(exitDialogTasks(CONSENT)).toBeNull();
    expect(exitDialogTasks('')).toBeNull();
    expect(exitDialogTasks(SCHEDULED.replace('The following will stop when you exit:', 'Something else:'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Manager: restart() through the exit dialog
// ---------------------------------------------------------------------------

const PROJECT = '/Users/u/Projects/atlas';
const ENGINE_SESSION = '11111111-1111-4111-8111-111111111111';
const KEY = 'w9:p72';

/** What the screen read before Esc returns: a screen, an error, or a promise that never settles. */
type ExitScreen = string | Error | 'hang';

class FakeDriver extends AtrapaDrivera {
  readonly probe: RestartProbe = {
    agent: { agentSessionId: ENGINE_SESSION, status: 'idle' }, composer: 'empty', mode: 'auto',
  };
  exitScreen: ExitScreen = SCHEDULED;
  /** Order of the screen read and of Esc. */
  readonly order: string[] = [];
  onExit: (() => void) | null = null;

  restartProbe(): Promise<RestartProbe> {
    return Promise.resolve(this.probe);
  }

  requestExit(): Promise<boolean> {
    this.onExit?.();
    return Promise.resolve(true);
  }

  readExitTasks(): Promise<readonly string[] | null> {
    this.order.push('read');
    const value = this.exitScreen;
    if (value === 'hang') return new Promise(() => undefined);
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(exitDialogTasks(value));
  }

  override interrupt(): Promise<boolean> {
    this.order.push('esc');
    return super.interrupt();
  }
}

class FakeSupervisor extends AtrapaNadzorcy<FakeDriver> {
  readonly live = new Map<string, HerdrAgent>();
  readonly engineLive = new Set<string>();
  readonly launches: unknown[] = [];

  override status(): HerdrStatus {
    return { available: true, agentCount: 0, readOnly: false, canLaunch: true };
  }

  protected nowyDriver(key: string): FakeDriver {
    return new FakeDriver(key, { dziennik: this.log });
  }

  override attach(key: string): FakeDriver {
    const driver = super.attach(key);
    driver.queue.push({ type: 'agent-state', state: 'idle', seen: true });
    return driver;
  }

  override async ensureFreshMode(): Promise<HerdrMode> {
    return 'auto';
  }

  launchAvailable(): boolean {
    return true;
  }

  agentFor(key: string): HerdrAgent | undefined {
    return this.live.get(key);
  }

  override async liveEngineSessions(): Promise<ReadonlySet<string>> {
    return new Set(this.engineLive);
  }

  override launch(req: unknown): never {
    this.launches.push(req);
    throw new Error('no launch expected');
  }

  appear(agent: HerdrAgent): void {
    this.live.set(agent.key, agent);
    this.engineLive.add(agent.agentSessionId);
    this.lifecycle.push({ type: 'appeared', agent });
  }
}

function makeDeps(): HerdrManagerDeps {
  const aliases = new Map<string, string>();
  return {
    sessionIdFor: (key: string) => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`,
    aliasFor: (engine) => aliases.get(engine),
    rememberAlias: (engine, id) => { aliases.set(engine, id); },
    resumeSource: {
      locate: (_root, _cwd, uuid) => Promise.resolve(uuid === ENGINE_SESSION ? '/store/a.jsonl' : null),
      cwdOf: () => Promise.resolve(PROJECT),
    },
    assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true,
    writeUploads: async () => [],
    writeUploadFiles: async () => [],
    sweepUploads: async () => undefined,
  };
}

const AGENT: HerdrAgent = {
  key: KEY, paneId: KEY, agentSessionId: ENGINE_SESSION, engine: 'claude', termId: null, cwd: PROJECT,
  status: 'idle', title: 's3-back', stateChangeSeq: 1, mode: 'auto', modeReadAt: 0, inScope: true, tabId: 'w9:t3',
  launchedByRarog: false, interactiveReady: true,
};

async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

async function until(condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
}

describe('restartExitTasksNotice: the clipped line stays well-formed Unicode', () => {
  it('an emoji split by the clip boundary → no lone surrogate in text or args', () => {
    // 78 units before the emoji: the cut at 79 lands between its two halves.
    const line = `shell · ${'x'.repeat(70)}😀${'y'.repeat(20)}`;
    const notice = restartExitTasksNotice([line]);
    const note = notice?.note as { text: string; ref: { args: string[] } } | undefined;
    expect(note?.ref.args[0]?.length).toBeLessThanOrEqual(80);
    expect(note?.ref.args[0]?.endsWith('…')).toBe(true);
    // A lone surrogate under the `u` flag; the repo's TS lib does not know `isWellFormed()` yet.
    const loneSurrogate = /[\uD800-\uDFFF]/u;
    expect(note?.ref.args[0]).not.toMatch(loneSurrogate);
    expect(note?.text).not.toMatch(loneSurrogate);
  });
});

describe('restart() meets the exit dialog after /exit', () => {
  let dataDir: string;
  const managers: Manager[] = [];
  const supervisors: FakeSupervisor[] = [];
  let logLines: string[];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-restart-tasks-'));
    logLines = [];
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  interface Built { manager: Manager; supervisor: FakeSupervisor; driver: FakeDriver; id: string }

  async function build(exitScreen: ExitScreen): Promise<Built> {
    const registry = new Map<string, CliRegistryEntry[]>([
      [ENGINE_SESSION, [{ pid: 4242, version: '2.1.280', status: 'idle' }]],
    ]);
    const supervisor = new FakeSupervisor();
    supervisors.push(supervisor);
    const manager = await createManager({
      demo: false,
      dataDir,
      projects: [{ path: PROJECT, name: 'atlas' }],
      projectRoots: [],
      gitStatus: null,
      maxPanes: 6,
      herdrSupervisor: supervisor,
      herdrDeps: makeDeps(),
      herdrRoots: [PROJECT],
      herdrSend: true,
      transcriptRoot: '/store',
      cliVersionReader: () => Promise.resolve({ installed: '2.1.283', registry }),
      liveSessionsReader: () => Promise.resolve(new Set([ENGINE_SESSION])),
      restartTiming: { exitTimeoutMs: 1_000, pollMs: 5, dialogReadMs: 50 },
      launchThrottle: { minIntervalMs: 0 },
      logger: (line) => { logLines.push(line); },
    });
    managers.push(manager);
    await manager.ready;
    supervisor.appear(AGENT);
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    expect(id).not.toBe('');
    const driver = supervisor.driver(KEY);
    driver.exitScreen = exitScreen;
    // `/exit` raises a dialog instead of ending the process: herdr reports `blocked`.
    driver.onExit = (): void => { driver.queue.push({ type: 'agent-state', state: 'blocked' }); };
    return { manager, supervisor, driver, id };
  }

  /** Runs the restart up to the canceled note and returns the system notes of the transcript. */
  async function restartToNote(built: Built): Promise<{ text: string; ref?: unknown }[]> {
    await built.manager.restart(built.id);
    await until(() => built.driver.interrupts === 1);
    await flush();
    return built.manager.transcript(built.id).messages
      .filter((m) => m.role === 'system')
      .flatMap((m) => m.blocks)
      .flatMap((b) => (b.type === 'text' ? [{ text: b.text, ref: (b as { ref?: unknown }).ref }] : []));
  }

  it('scheduled task → note with its line, one Esc after the read, restart canceled, no new process', async () => {
    const built = await build(SCHEDULED);
    const notes = await restartToNote(built);
    expect(built.driver.order).toEqual(['read', 'esc']);
    expect(built.driver.interrupts).toBe(1);
    expect(built.supervisor.launches).toEqual([]);
    expect(notes).toContainEqual({
      text: '⚠ Restart canceled: the session has background tasks that would stop on exit: '
        + 'scheduled task · Runs once in 3d · Check the build…. The session keeps running; restart it in the '
        + 'terminal or after these tasks finish.',
      ref: { code: 'restart.exit-background-tasks.list', args: ['scheduled task · Runs once in 3d · Check the build…'] },
    });
    expect(notes.some((note) => note.text.includes(RESTART_EXIT_ASKED_DETAIL.text))).toBe(false);
    expect(built.manager.get(built.id)?.stateDetail)
      .toBe('Restart canceled: background tasks would stop on exit. The session keeps running.');
    // The log line carries the count of tasks, not their text.
    const line = logLines.find((l) => l.includes('canceled'));
    expect(line).toContain('1 background task');
    expect(logLines.join('\n')).not.toContain('Check the build');
  });

  it('five tasks → three lines and "and 2 more"', async () => {
    const lines = ['shell · sleep 1', 'shell · sleep 2', 'agent · Review', 'shell · sleep 4', 'scheduled task · Daily'];
    const built = await build(withTasks(lines));
    const notes = await restartToNote(built);
    expect(built.driver.interrupts).toBe(1);
    expect(notes).toContainEqual(expect.objectContaining({
      ref: { code: 'restart.exit-background-tasks.list-more', args: ['shell · sleep 1; shell · sleep 2; agent · Review', '2'] },
    }));
    const note = notes.find((n) => n.text.includes('and 2 more'));
    expect(note?.text).toContain('stop on exit: shell · sleep 1; shell · sleep 2; agent · Review and 2 more.');
    expect(logLines.find((l) => l.includes('canceled'))).toContain('5 background tasks');
  });

  it('a long task line is cut to a bounded length with an ellipsis', async () => {
    const long = `shell · ${'x'.repeat(300)}`;
    const built = await build(withTasks([long]));
    const notes = await restartToNote(built);
    const ref = notes.find((n) => (n.ref as { code?: string } | undefined)?.code === 'restart.exit-background-tasks.list')
      ?.ref as { args: string[] } | undefined;
    expect(ref?.args[0]?.length).toBeLessThanOrEqual(80);
    expect(ref?.args[0]?.endsWith('…')).toBe(true);
  });

  const TODAY = {
    text: `⚠ ${RESTART_EXIT_ASKED_DETAIL.text}`, ref: { code: 'restart.exit-note', args: ['restart.exit-asked'] },
  };

  it('another question on exit (consent) → today\'s note, one Esc', async () => {
    const built = await build(CONSENT);
    const notes = await restartToNote(built);
    expect(built.driver.interrupts).toBe(1);
    expect(notes).toContainEqual(TODAY);
    expect(built.manager.get(built.id)?.stateDetail).toBe(RESTART_EXIT_ASKED_DETAIL.text);
    expect(built.supervisor.launches).toEqual([]);
  });

  it('the screen read fails → today\'s note, Esc still goes', async () => {
    const built = await build(new Error('EIO'));
    const notes = await restartToNote(built);
    expect(built.driver.order).toEqual(['read', 'esc']);
    expect(notes).toContainEqual(TODAY);
  });

  it('the screen read hangs past its limit → today\'s note, Esc still goes', async () => {
    const built = await build('hang');
    const notes = await restartToNote(built);
    expect(built.driver.order).toEqual(['read', 'esc']);
    expect(built.driver.interrupts).toBe(1);
    expect(notes).toContainEqual(TODAY);
    expect(built.supervisor.launches).toEqual([]);
  });
});
