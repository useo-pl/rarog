/**
 * Pane labels lead with a description: `<description> · rc:<key code><trace code>` and
 * `<description> · rt:<id code>`, so herdr's Go-to window names a Rarog pane by its tab.
 *
 * This file pins the writing side: the generator, the launcher, the supervisor's tab label sync
 * (with the migration of bare labels) and the terminal backend (new pane, migration in
 * `reconcile`). Every write sits behind a fresh read that must find the label read in the pass.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { foreign } from '@rarog/shared/sentences';
import { HERDR_RESYNC_MS, loadConfig } from '../src/config.ts';
import { createHerdrLauncher } from '../src/herdr/launcher.ts';
import { keyCodeOf } from '../src/herdr/label-code.ts';
import { createProjectPlacement } from '../src/herdr/project-workspace.ts';
import {
  claudePaneLabel, labelTrace, paneLabelDescription, parsePaneLabel, projectKey, termPaneLabel,
} from '../src/herdr/provenance.ts';
import { HerdrUnavailableError } from '../src/herdr/socket.ts';
import type { HerdrPaneInfo } from '../src/herdr/types.ts';
import {
  RAROG_TERM_TOKEN, TERM_HERDR_STATE_FILENAME, createHerdrBackend,
} from '../src/term/herdr-backend.ts';
import { termIdFor } from '../src/term/lifecycle.ts';
import { FakeHerdr } from './fake-term-herdr.ts';
import { namedFixtureAgent, startTabLabelHarness } from './helpers/supervisor-tab-label-harness.ts';
import type { TabLabelHarness } from './helpers/supervisor-tab-label-harness.ts';

const KEY = 'abababababababab';

/**
 * The terminal fake plus a record of every `pane.rename`, its outcome (a timeout with or without
 * effect), a hook inside `tab.get` and a successful `agent.start` for the launcher.
 */
class RecordingHerdr extends FakeHerdr {
  readonly paneRenames: { paneId: string; label: string | null }[] = [];
  paneRenameOutcome: 'ok' | 'timeout' | 'timeout-applied' = 'ok';
  onGetTab: (() => void) | null = null;

  override async renamePane(paneId: string, label: string | null): Promise<void> {
    this.paneRenames.push({ paneId, label });
    if (this.paneRenameOutcome !== 'timeout') await super.renamePane(paneId, label);
    if (this.paneRenameOutcome !== 'ok') {
      throw new HerdrUnavailableError(foreign('herdr: no answer in time (pane.rename)'));
    }
  }

  /** Changes a label the way a human in herdr would: not counted as a Rarog write. */
  relabelByHand(paneId: string, label: string): void {
    void super.renamePane(paneId, label);
  }

  override getTab(tabId: string): ReturnType<FakeHerdr['getTab']> {
    const hook = this.onGetTab;
    this.onGetTab = null;
    hook?.();
    return super.getTab(tabId);
  }

  override startAgent(): Promise<{ argv: readonly string[] }> {
    return Promise.resolve({ argv: ['claude'] });
  }
}

describe('the label generator: description first, provenance suffix last', () => {
  it('Claude and terminal labels with a description', () => {
    expect(claudePaneLabel(KEY, labelTrace('PR-y'), 'PR-y'))
      .toBe(`PR-y · ${claudePaneLabel(KEY, labelTrace('PR-y'))}`);
    expect(termPaneLabel(KEY, 'rarog 2 · atlas')).toBe(`rarog 2 · atlas · ${termPaneLabel(KEY)}`);
  });

  it('description: the card cleanup, 40 code points, trimmed; empty = the bare format', () => {
    expect(paneLabelDescription('  a\u0000\n\u2028b  ')).toBe('a b');
    expect(paneLabelDescription('x'.repeat(41))).toBe('x'.repeat(40));
    // Code points, not UTF-16 units: 40 emoji stay whole.
    expect(paneLabelDescription('😀'.repeat(45))).toBe('😀'.repeat(40));
    // The cut lands after a space, so the description loses it.
    expect(paneLabelDescription(`${'a'.repeat(39)} tail`)).toBe('a'.repeat(39));
    for (const blank of ['', '   ', '\u0007\n']) {
      expect(claudePaneLabel(KEY, '89abcdef', blank)).toMatch(/^rc:[0-9a-z]{14}$/u);
      expect(termPaneLabel(KEY, blank)).toMatch(/^rt:[0-9a-z]{13}$/u);
    }
  });

  it('every generated label reads back as its provenance, whatever the tab label', () => {
    const piece = fc.constantFrom(
      'a', ' ', '·', ' · ', '\n', '\r', '\u2028', '\u0085', '😀', 'rarog-term ', `rarog-claude ${KEY} `, 'rt:', 'rc:',
    );
    const tabLabel = fc.oneof(
      fc.string({ unit: 'grapheme', maxLength: 60 }),
      fc.array(piece, { maxLength: 30 }).map((parts) => parts.join('')),
    );
    fc.assert(fc.property(tabLabel, (raw) => {
      expect(parsePaneLabel(claudePaneLabel(KEY, '89abcdef', raw)))
        .toEqual({ kind: 'claude', keyCode: keyCodeOf(KEY), trace: '89abcdef' });
      expect(parsePaneLabel(termPaneLabel(KEY, raw))).toEqual({ kind: 'term', id: KEY });
    }));
  });
});

describe('launcher: a new Claude pane carries its tab label', () => {
  it('start with the title "PR-y" → `PR-y · rc:<key code><sha(PR-y) code>`', async () => {
    const cwd = '/Users/u/Projects/atlas';
    const sessionId = '11111111-2222-4333-8444-555555555555';
    const herdr = new RecordingHerdr();
    const launcher = createHerdrLauncher({
      client: herdr,
      placement: createProjectPlacement(),
      trust: { isTrusted: () => Promise.resolve(true) },
      probeAgent: () => Promise.resolve({ agentSessionId: sessionId, status: 'idle', interactiveReady: true }),
      registerLaunch: () => 'key-1',
      readScreen: () => Promise.resolve(''),
      now: () => 0,
      sleep: () => Promise.resolve(),
      newSessionId: () => sessionId,
      logger: () => {},
    });

    await (await launcher.launch({ cwd, label: 'PR-y' })).ready;

    const expected = `PR-y · ${claudePaneLabel(projectKey(cwd), labelTrace('PR-y'))}`;
    expect(herdr.paneRenames).toEqual([{ paneId: 'w1:p1', label: expected }]);
    expect(herdr.tabLabels).toEqual([{ tabId: 'w1:p1t', label: 'PR-y' }]);
  });
});

describe('supervisor: the pane label follows the tab label', () => {
  let harnesses: TabLabelHarness[] = [];
  afterEach(() => {
    for (const harness of harnesses) harness.supervisor.dispose();
    harnesses = [];
  });

  const agent = namedFixtureAgent(0, 'rarog-abc123');
  const paneId = agent.paneId;
  const tabId = agent.tabId;
  const bare = (tabLabel: string): string => claudePaneLabel(KEY, labelTrace(tabLabel));
  const described = (tabLabel: string): string => claudePaneLabel(KEY, labelTrace(tabLabel), tabLabel);

  function herdrWith(paneLabel: string, tabLabel: string, split = false): RecordingHerdr {
    const herdr = new RecordingHerdr();
    const pane: HerdrPaneInfo = {
      paneId, tabId, workspaceId: 'w9', cwd: agent.cwd, tokens: {}, label: paneLabel,
    };
    herdr.addPane(pane);
    if (split) herdr.addPane({ ...pane, paneId: 'w9:pSIDE', label: null });
    herdr.setTabLabel(tabId, tabLabel);
    return herdr;
  }

  async function start(herdr: RecordingHerdr, tabLabels?: boolean): Promise<TabLabelHarness> {
    const harness = await startTabLabelHarness(
      [agent], herdr, tabLabels === undefined ? {} : { tabLabels },
    );
    harnesses.push(harness);
    return harness;
  }

  async function sync(h: TabLabelHarness, cardLabel: string): Promise<void> {
    h.supervisor.syncTabLabel?.(paneId, cardLabel);
    await h.fire();
  }

  /** One resync tick (pending syncs come back after it), then the debounce. */
  async function resync(h: TabLabelHarness): Promise<void> {
    h.scheduler.advance(HERDR_RESYNC_MS);
    await h.fire();
  }

  it('card "a" → "b": `b · rc:<key code><sha(b) code>` in one `pane.rename`', async () => {
    const herdr = herdrWith(described('a'), 'a');
    const h = await start(herdr);

    await sync(h, 'b');

    expect(herdr.tabLabels).toEqual([{ tabId, label: 'b' }]);
    expect(herdr.paneRenames).toEqual([{ paneId, label: `b · ${bare('b')}` }]);
  });

  it('old bare label, tab with the card label → one migration; the second pass writes nothing', async () => {
    const herdr = herdrWith(bare('a'), 'a');
    const h = await start(herdr);

    await sync(h, 'a');
    await sync(h, 'a');

    expect(herdr.tabLabels).toEqual([]);
    expect(herdr.paneRenames).toEqual([{ paneId, label: `a · ${bare('a')}` }]);

    // A Rarog restart: no memory of the settled label, the described label itself says "done".
    h.supervisor.dispose();
    await sync(await start(herdr), 'a');
    expect(herdr.paneRenames).toHaveLength(1);
  });

  it('tab named by hand "moje" → the pane leads with "moje" and keeps the old trace, the tab stays', async () => {
    const herdr = herdrWith(bare('old'), 'moje');
    const h = await start(herdr);

    await sync(h, 'nowa');
    await sync(h, 'nowsza');

    expect(herdr.tabLabels).toEqual([]);
    expect((await herdr.getTab(tabId)).label).toBe('moje');
    expect(herdr.paneRenames).toEqual([{ paneId, label: `moje · ${bare('old')}` }]);
  });

  it('a pane label set by hand (outside the pattern) → zero writes', async () => {
    const herdr = herdrWith('my pane', 'a');
    const h = await start(herdr);

    await sync(h, 'b');

    expect(herdr.paneRenames).toEqual([]);
    expect(herdr.tabLabels).toEqual([]);
  });

  it('split tab → zero writes, also for an old bare label', async () => {
    const herdr = herdrWith(bare('a'), 'a', true);
    const h = await start(herdr);

    await sync(h, 'a');
    await sync(h, 'b');

    expect(herdr.paneRenames).toEqual([]);
    expect(herdr.tabLabels).toEqual([]);
  });

  it('title over 40 characters → description cut, trace from the full title, second pass writes nothing', async () => {
    const title = 'release notes for the offline sync on a phone';
    const herdr = herdrWith(bare('old'), 'old');
    const h = await start(herdr);

    await sync(h, title);
    await sync(h, title);

    expect(herdr.tabLabels).toEqual([{ tabId, label: title }]);
    expect(herdr.paneRenames).toEqual([{
      paneId, label: `release notes for the offline sync on a · ${bare(title)}`,
    }]);

    h.supervisor.dispose();
    await sync(await start(herdr), title);
    expect(herdr.paneRenames).toHaveLength(1);
  });

  it('only the description changes before the migration write → zero writes', async () => {
    const herdr = herdrWith(bare('a'), 'a');
    herdr.onGetTab = () => { herdr.relabelByHand(paneId, `zz · ${bare('a')}`); };
    const h = await start(herdr);

    await sync(h, 'a');

    expect(herdr.paneRenames).toEqual([]);
    expect(h.logs.some((line) => line.includes(`pane ${paneId} changed before`))).toBe(true);
  });

  it('the label changes before the write for a tab named by hand → zero writes', async () => {
    const herdr = herdrWith(bare('old'), 'moje');
    herdr.onGetTab = () => { herdr.relabelByHand(paneId, `zz · ${bare('old')}`); };
    const h = await start(herdr);

    await sync(h, 'nowa');

    expect(herdr.paneRenames).toEqual([]);
    expect(herdr.tabLabels).toEqual([]);
  });

  it('`pane.rename` timeout that took effect → the next pass finds the label and writes nothing', async () => {
    const herdr = herdrWith(bare('a'), 'a');
    herdr.paneRenameOutcome = 'timeout-applied';
    const h = await start(herdr);

    await sync(h, 'a');
    herdr.paneRenameOutcome = 'ok';
    for (let i = 0; i < 5; i += 1) await resync(h);

    expect(herdr.paneRenames).toEqual([{ paneId, label: described('a') }]);
    expect(herdr.pane(paneId)?.label).toBe(described('a'));
  });

  it('`pane.rename` timeout without effect → retries back off, no write loop', async () => {
    const herdr = herdrWith(bare('a'), 'a');
    herdr.paneRenameOutcome = 'timeout';
    const h = await start(herdr);

    await sync(h, 'a');
    for (let i = 0; i < 10; i += 1) await resync(h);

    // The first write and one retry at the next resync; later retries wait for the back-off
    // (the harness clock stands still), so ten resyncs do not mean ten writes.
    expect(herdr.paneRenames).toEqual([
      { paneId, label: described('a') }, { paneId, label: described('a') },
    ]);
    expect(herdr.pane(paneId)?.label).toBe(bare('a'));
  });

  it('`RAROG_HERDR_TAB_LABELS=0` → the description does not follow the card', async () => {
    const herdr = herdrWith(described('a'), 'a');
    const h = await start(herdr, false);

    await sync(h, 'b');

    expect(herdr.paneRenames).toEqual([]);
    expect(herdr.tabLabels).toEqual([]);
    expect(herdr.pane(paneId)?.label).toBe(described('a'));
  });
});

describe('terminal: the pane leads with the terminal tab label', () => {
  const CWD = '/Users/testowy/Projects/atlas';
  const ID = termIdFor(CWD, 2);
  const DESCRIBED = `rarog 2 · atlas · ${termPaneLabel(ID)}`;
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
  });

  function dataDirOf(): string {
    const dataDir = mkdtempSync(join(tmpdir(), 'rarog-pane-labels-write-'));
    dirs.push(dataDir);
    return dataDir;
  }

  function backendOver(
    herdr: FakeHerdr, dataDir = dataDirOf(), env: Record<string, string> = {},
  ): ReturnType<typeof createHerdrBackend> {
    const config = loadConfig({
      RAROG_ORIGINS: 'https://rarog.example',
      RAROG_TERM: '1',
      RAROG_TERM_BACKEND: 'herdr',
      RAROG_HERDR_BIN: '/usr/bin/true',
      RAROG_HERDR_LAUNCH: '1',
      RAROG_PROJECT_ROOTS: '/Users/testowy/Projects',
      RAROG_DATA_DIR: dataDir,
      HOME: '/Users/testowy',
      PATH: '/usr/bin:/bin',
      TMPDIR: '/tmp',
      ...env,
    });
    return createHerdrBackend({
      config, logger: { info: () => {}, error: () => {} }, launchClient: () => herdr,
    });
  }

  /** A terminal pane alone in tab `<pane>t`, with the token unless `token` is false. */
  function herdrWith(label: string | null, opts: { cwd?: string; token?: boolean; tab?: string } = {}): RecordingHerdr {
    const herdr = new RecordingHerdr();
    herdr.addPane({
      paneId: 'w1:p1', tabId: 'w1:p1t', workspaceId: 'w1', cwd: opts.cwd ?? CWD,
      tokens: opts.token === false ? {} : { [RAROG_TERM_TOKEN]: ID }, label,
    });
    herdr.setTabLabel('w1:p1t', opts.tab ?? 'rarog 2 · atlas');
    return herdr;
  }

  it('new pane in slot 2 → `rarog 2 · atlas · rt:<id code>`; reconcile then writes nothing', async () => {
    const herdr = new RecordingHerdr();
    const backend = backendOver(herdr);

    const handle = await backend.ensureSession(ID, CWD);
    await backend.reconcile();

    expect(handle.fresh).toBe(true);
    expect(herdr.paneRenames).toEqual([{ paneId: handle.ref, label: DESCRIBED }]);
    expect(herdr.tabLabels).toEqual([{ tabId: `${handle.ref}t`, label: 'rarog 2 · atlas' }]);
  });

  it('bare `rt:<id code>` with a token → one migration; the second pass and a restart write nothing', async () => {
    const herdr = herdrWith(termPaneLabel(ID));
    const dataDir = dataDirOf();
    const backend = backendOver(herdr, dataDir);

    await backend.reconcile();
    await backend.reconcile();
    backend.dispose();
    await backendOver(herdr, dataDir).reconcile();

    expect(herdr.paneRenames).toEqual([{ paneId: 'w1:p1', label: DESCRIBED }]);
    expect(herdr.tabLabels).toEqual([]);
    expect(herdr.stamps).toEqual([]);
  });

  it('directory from the state file when the shell moved away', async () => {
    const herdr = herdrWith(termPaneLabel(ID), { cwd: '/Users/testowy/elsewhere' });
    const dataDir = dataDirOf();
    writeFileSync(join(dataDir, TERM_HERDR_STATE_FILENAME), JSON.stringify({ 'w1:p1': { seen: 1, cwd: CWD } }));

    await backendOver(herdr, dataDir).reconcile();

    expect(herdr.paneRenames).toEqual([{ paneId: 'w1:p1', label: DESCRIBED }]);
  });

  it('identity matches neither the state file nor `cwd` → the old label stays', async () => {
    const herdr = herdrWith(termPaneLabel(ID), { cwd: '/Users/testowy/elsewhere' });

    await backendOver(herdr).reconcile();

    expect(herdr.paneRenames).toEqual([]);
    expect(herdr.pane('w1:p1')?.label).toBe(termPaneLabel(ID));
  });

  it('token next to a pane label set by hand → zero writes', async () => {
    const herdr = herdrWith('my shell');

    await backendOver(herdr).reconcile();

    expect(herdr.paneRenames).toEqual([]);
    expect(herdr.tabLabels).toEqual([]);
  });

  it('split tab → zero writes', async () => {
    const herdr = herdrWith(termPaneLabel(ID));
    herdr.addPane({
      paneId: 'w1:p8', tabId: 'w1:p1t', workspaceId: 'w1', cwd: CWD, tokens: {}, label: null,
    });

    await backendOver(herdr).reconcile();

    expect(herdr.paneRenames).toEqual([]);
  });

  it('only the description changes before the write → zero writes', async () => {
    const herdr = herdrWith(termPaneLabel(ID));
    herdr.onGetTab = () => { herdr.relabelByHand('w1:p1', `zz · ${termPaneLabel(ID)}`); };

    await backendOver(herdr).reconcile();

    expect(herdr.paneRenames).toEqual([]);
    expect(herdr.pane('w1:p1')?.label).toBe(`zz · ${termPaneLabel(ID)}`);
  });

  it('`pane.rename` timeout → the token still comes back, one retry on the next pass, then nothing', async () => {
    // An orphan after a herdr restart: bare label, no token.
    const herdr = herdrWith(termPaneLabel(ID), { token: false });
    herdr.paneRenameOutcome = 'timeout';
    const backend = backendOver(herdr);

    const first = await backend.reconcile();

    expect(first.restored).toEqual(['w1:p1']);
    expect(first.unknown.size).toBe(0);
    expect(herdr.pane('w1:p1')?.tokens).toEqual({ [RAROG_TERM_TOKEN]: ID });
    // Opening the terminal finds its pane by the token, the unknown label write blocks nothing.
    expect(await backend.ensureSession(ID, CWD)).toEqual({ ref: 'w1:p1', id: ID, fresh: false });

    herdr.paneRenameOutcome = 'ok';
    await backend.reconcile();
    await backend.reconcile();

    expect(herdr.paneRenames).toEqual([
      { paneId: 'w1:p1', label: DESCRIBED }, { paneId: 'w1:p1', label: DESCRIBED },
    ]);
    expect(herdr.pane('w1:p1')?.label).toBe(DESCRIBED);
  });

  it('`pane.rename` timeout that took effect → the next pass writes nothing', async () => {
    const herdr = herdrWith(termPaneLabel(ID));
    herdr.paneRenameOutcome = 'timeout-applied';
    const backend = backendOver(herdr);

    await backend.reconcile();
    herdr.paneRenameOutcome = 'ok';
    await backend.reconcile();

    expect(herdr.paneRenames).toEqual([{ paneId: 'w1:p1', label: DESCRIBED }]);
  });

  it('`RAROG_HERDR_TAB_LABELS=0` → no migration of the pane label', async () => {
    const herdr = herdrWith(termPaneLabel(ID));

    await backendOver(herdr, dataDirOf(), { RAROG_HERDR_TAB_LABELS: '0' }).reconcile();

    expect(herdr.paneRenames).toEqual([]);
  });
});
