/**
 * Pane labels in the old format (`<description> · rarog-term <id>`,
 * `<description> · rarog-claude <key> <trace>`): the normalizer every reader goes through and the
 * pass that rewrites such labels in herdr.
 *
 * The pass runs from the supervisor whenever herdr answers and a pass is due, over the whole
 * `pane.list`: whatever agent stands in the pane, however the tab is split, whatever the tab label
 * flag says. The pane label is the only Rarog mark that survives a herdr restart, so a rewrite that
 * did not land leaves the pane Rarog's (the normalizer) and the next pass finishes it.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { foreign } from '@rarog/shared/sentences';
import { HERDR_RESYNC_MS, loadConfig } from '../src/config.ts';
import { parseAgentList } from '../src/herdr/client.ts';
import { encodeHex } from '../src/herdr/label-code.ts';
import { createLabelMigration, legacyToCurrent } from '../src/herdr/label-migration.ts';
import { labelTrace, paneLabelTermId, parsePaneLabel, termPaneLabel } from '../src/herdr/provenance.ts';
import { HerdrUnavailableError } from '../src/herdr/socket.ts';
import { HerdrError, HerdrReadOnlyError } from '../src/herdr/types.ts';
import type { HerdrAgentInfo, HerdrPaneInfo } from '../src/herdr/types.ts';
import { RAROG_TERM_TOKEN, createHerdrBackend } from '../src/term/herdr-backend.ts';
import { matchTermLabel, termIdFor } from '../src/term/lifecycle.ts';
import { FakeHerdr } from './fake-term-herdr.ts';
import {
  StaticAgentClient, namedFixtureAgent, startTabLabelHarness,
} from './helpers/supervisor-tab-label-harness.ts';
import type { TabLabelHarness } from './helpers/supervisor-tab-label-harness.ts';

const TERM_ID = 'd703c6f230f3e25e';
const KEY = '5987c60c24159c09';
const TRACE = '428a2dd7';
const LEGACY_TERM = `rarog 1 · atlas · rarog-term ${TERM_ID}`;
const CURRENT_TERM = 'rarog 1 · atlas · rt:tw1wdwhgyfh5w';
const LEGACY_CLAUDE = `fixes · rarog-claude ${KEY} ${TRACE}`;
const CURRENT_CLAUDE = 'fixes · rc:b63wc318a52vnr';

describe('legacyToCurrent: the old format → the same provenance in the current one', () => {
  const cases: [string, string][] = [
    [`rarog-term ${TERM_ID}`, 'rt:tw1wdwhgyfh5w'],
    [LEGACY_TERM, CURRENT_TERM],
    [`rarog-claude ${KEY} ${TRACE}`, 'rc:b63wc318a52vnr'],
    [LEGACY_CLAUDE, CURRENT_CLAUDE],
    // The description stays verbatim, also one that reads like a suffix.
    [`a · rt:tw1wdwhgyfh5w · rarog-claude ${KEY} ${TRACE}`, 'a · rt:tw1wdwhgyfh5w · rc:b63wc318a52vnr'],
  ];
  for (const [legacy, current] of cases) {
    it(`${JSON.stringify(legacy)} → ${JSON.stringify(current)}`, () => {
      expect(legacyToCurrent(legacy)).toBe(current);
    });
  }

  it('a human label, a current label and a near miss stay as they are', () => {
    for (const label of [
      '', 'atlas', 'notes 87', CURRENT_TERM, CURRENT_CLAUDE,
      `  · rarog-term ${TERM_ID}`, `rarog-term ${TERM_ID.toUpperCase()}`, `rarog-term ${TERM_ID} `,
      `rarog-term ${TERM_ID}0`, `rarog-claude ${KEY}`, `rarog-claude ${KEY} ${TRACE} x`, `inny-term ${TERM_ID}`,
      `a\nb · rarog-term ${TERM_ID}`,
    ]) {
      expect(legacyToCurrent(label), JSON.stringify(label)).toBe(label);
    }
  });

  it('every reader sees one provenance in both formats', () => {
    expect(parsePaneLabel(LEGACY_TERM)).toEqual(parsePaneLabel(CURRENT_TERM));
    expect(paneLabelTermId(LEGACY_TERM)).toBe(TERM_ID);
    expect(parsePaneLabel(LEGACY_CLAUDE)).toEqual({ kind: 'claude', keyCode: 'b63wc31', trace: TRACE });
    expect(parsePaneLabel(LEGACY_CLAUDE)).toEqual(parsePaneLabel(CURRENT_CLAUDE));
    const cwd = '/Users/u/Projects/atlas';
    const id = termIdFor(cwd, 2);
    expect(matchTermLabel(`rarog 2 · atlas · rarog-term ${id}`, cwd)).toEqual({ id, slot: 2, role: 'shell' });
  });
});

/** The terminal fake with a record of `pane.rename`, a switch for herdr being down and hooks on `pane.list`. */
class MigrationHerdr extends FakeHerdr {
  readonly renames: { paneId: string; label: string | null }[] = [];
  lists = 0;
  down = false;
  renameOutcome: 'ok' | 'timeout' | 'read-only' | 'refused' = 'ok';
  /** Runs right before the n-th `pane.list` (1-based) answers. */
  readonly beforeList = new Map<number, () => void>();

  override listPanes(): Promise<HerdrPaneInfo[]> {
    this.lists += 1;
    if (this.down) return Promise.reject(new HerdrUnavailableError(foreign('herdr: socket down')));
    this.beforeList.get(this.lists)?.();
    return super.listPanes();
  }

  override async renamePane(paneId: string, label: string | null): Promise<void> {
    this.renames.push({ paneId, label });
    if (this.renameOutcome === 'timeout') throw new HerdrUnavailableError(foreign('herdr: no answer in time'));
    if (this.renameOutcome === 'read-only') throw new HerdrReadOnlyError(foreign('herdr: read-only'));
    if (this.renameOutcome === 'refused') throw new HerdrError(foreign('herdr: label refused'));
    await super.renamePane(paneId, label);
  }

  /** A label change made by a human in herdr: not a Rarog write. */
  relabelByHand(paneId: string, label: string): void {
    void super.renamePane(paneId, label);
  }

  labels(): (string | null)[] {
    return ['w1:p1', 'w1:p2', 'w1:p3', 'w1:p4'].map((paneId) => this.pane(paneId)?.label ?? null);
  }
}

const paneOf = (paneId: string, label: string | null, extra: Partial<HerdrPaneInfo> = {}): HerdrPaneInfo => ({
  paneId, tabId: `${paneId}t`, workspaceId: 'w1', cwd: '/Users/u/Projects/atlas', tokens: {}, label, ...extra,
});

describe('the migration pass', () => {
  function migrationOver(herdr: MigrationHerdr, writable = (): boolean => true): {
    run: () => Promise<void>; requestPass: () => void; logs: string[];
  } {
    const logs: string[] = [];
    const migration = createLabelMigration({ client: herdr, writable, log: (line) => { logs.push(line); } });
    return { run: () => migration.run(), requestPass: () => { migration.requestPass(); }, logs };
  }

  function herdrWithFour(): MigrationHerdr {
    const herdr = new MigrationHerdr();
    herdr.addPane(paneOf('w1:p1', LEGACY_TERM));
    herdr.addPane(paneOf('w1:p2', LEGACY_CLAUDE));
    herdr.addPane(paneOf('w1:p3', 'notes'));
    herdr.addPane(paneOf('w1:p4', null));
    return herdr;
  }

  it('rewrites each old label after a fresh read, leaves the rest, one log line with the count', async () => {
    const herdr = herdrWithFour();
    const { run, logs } = migrationOver(herdr);

    await run();

    expect(herdr.renames).toEqual([
      { paneId: 'w1:p1', label: CURRENT_TERM }, { paneId: 'w1:p2', label: CURRENT_CLAUDE },
    ]);
    expect(herdr.labels()).toEqual([CURRENT_TERM, CURRENT_CLAUDE, 'notes', null]);
    // One list for the pass, one fresh read before each write.
    expect(herdr.lists).toBe(3);
    expect(logs.filter((line) => line.includes('label migration'))).toEqual([
      'herdr: pane label migration — 2 of 2 old-format pane labels rewritten',
    ]);
  });

  it('after a pass that left nothing old, the next runs read nothing until a pass is requested', async () => {
    const herdr = herdrWithFour();
    const { run, requestPass } = migrationOver(herdr);
    await run();
    const lists = herdr.lists;

    for (let i = 0; i < 5; i += 1) await run();
    expect(herdr.lists).toBe(lists);

    requestPass();
    await run();
    expect(herdr.lists).toBe(lists + 1);
    expect(herdr.renames).toHaveLength(2);
  });

  it('two runs at once share one pass', async () => {
    const herdr = herdrWithFour();
    const { run } = migrationOver(herdr);

    await Promise.all([run(), run()]);

    expect(herdr.renames).toHaveLength(2);
    expect(herdr.lists).toBe(3);
  });

  it('a label that changed between the reads is not touched', async () => {
    const herdr = herdrWithFour();
    // The fresh read before the first write finds a name given by hand.
    herdr.beforeList.set(2, () => { herdr.relabelByHand('w1:p1', 'my shell'); });
    const { run, logs } = migrationOver(herdr);

    await run();

    expect(herdr.renames).toEqual([{ paneId: 'w1:p2', label: CURRENT_CLAUDE }]);
    expect(herdr.labels()[0]).toBe('my shell');
    expect(logs.some((line) => line.includes('pane w1:p1 changed before'))).toBe(true);
  });

  it('a pane moved to another address between the reads is rewritten by the next run, no pass request', async () => {
    const herdr = herdrWithFour();
    // The fresh read before the first write finds the pane under a new address.
    herdr.beforeList.set(2, () => {
      void herdr.closePane('w1:p1');
      herdr.addPane(paneOf('w2:p1', LEGACY_TERM, { workspaceId: 'w2' }));
    });
    const { run } = migrationOver(herdr);

    await run();
    expect(herdr.pane('w2:p1')?.label).toBe(LEGACY_TERM);

    await run();
    expect(herdr.pane('w2:p1')?.label).toBe(CURRENT_TERM);
  });

  it('`pane.rename` times out → the pane stays Rarog\'s, the next pass finishes the rewrite', async () => {
    const herdr = herdrWithFour();
    herdr.renameOutcome = 'timeout';
    const { run } = migrationOver(herdr);

    await run();

    expect(herdr.labels()[0]).toBe(LEGACY_TERM);
    expect(paneLabelTermId(herdr.labels()[0])).toBe(TERM_ID);

    herdr.renameOutcome = 'ok';
    await run();

    expect(herdr.labels()).toEqual([CURRENT_TERM, CURRENT_CLAUDE, 'notes', null]);
  });

  it('herdr cannot be read → no write; the next pass rewrites', async () => {
    const herdr = herdrWithFour();
    herdr.down = true;
    const { run } = migrationOver(herdr);

    await run();
    expect(herdr.renames).toEqual([]);

    herdr.down = false;
    await run();
    expect(herdr.labels()).toEqual([CURRENT_TERM, CURRENT_CLAUDE, 'notes', null]);
  });

  it('write channel closed → zero calls and one log line; the socket gate ends the pass', async () => {
    const herdr = herdrWithFour();
    const closed = migrationOver(herdr, () => false);
    for (let i = 0; i < 3; i += 1) await closed.run();
    expect(herdr.lists).toBe(0);
    expect(closed.logs.filter((line) => line.includes('on hold'))).toHaveLength(1);

    herdr.renameOutcome = 'read-only';
    const gated = migrationOver(herdr);
    await gated.run();
    expect(herdr.renames).toHaveLength(1);
    herdr.renameOutcome = 'ok';
    await gated.run();
    expect(herdr.labels()).toEqual([CURRENT_TERM, CURRENT_CLAUDE, 'notes', null]);
  });

  it('a rename herdr refuses is not retried in the same process; the pane stays readable', async () => {
    const herdr = herdrWithFour();
    herdr.renameOutcome = 'refused';
    const { run, logs } = migrationOver(herdr);

    await run();
    await run();

    expect(herdr.renames).toHaveLength(2);
    expect(herdr.labels().slice(0, 2)).toEqual([LEGACY_TERM, LEGACY_CLAUDE]);
    expect(parsePaneLabel(LEGACY_CLAUDE)?.kind).toBe('claude');
    expect(logs.filter((line) => line.includes('failed'))).toHaveLength(2);
  });
});

const rawAgents = (JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'herdr', 'agent-list.json'), 'utf8'),
) as { result: { agents: Record<string, unknown>[] } }).result.agents;

/** A Codex agent on a fixture pane, through the input filter with Codex status on. */
function codexAgent(index: number): HerdrAgentInfo {
  const [info] = parseAgentList({
    agents: [{
      ...rawAgents[index], agent: 'codex',
      agent_session: { agent: 'codex', kind: 'id', source: 'herdr:codex', value: '0198f0c4-1f2a-7c31-9a44-6f2b5d0e7a10' },
    }],
  }, { codexStatus: true });
  if (info === undefined) throw new Error('input filter rejected the Codex agent');
  return info;
}

/** An agent client that fails `agent.list` while herdr is down. */
class FlakyAgentClient extends StaticAgentClient {
  down = false;

  override listAgents(): Promise<HerdrAgentInfo[]> {
    if (this.down) return Promise.reject(new HerdrUnavailableError(foreign('herdr: socket down')));
    return super.listAgents();
  }
}

/** Lets the pass started by a resync run to the end (no timers involved). */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => { setTimeout(resolve, 2); });
}

describe('supervisor: the migration pass covers the whole `pane.list`', () => {
  let harness: TabLabelHarness | null = null;
  afterEach(() => {
    harness?.supervisor.dispose();
    harness = null;
  });

  const claude = namedFixtureAgent(0, 'rarog-abc123');
  const codex = codexAgent(3);
  const claudePane = (label: string): HerdrPaneInfo => ({
    paneId: claude.paneId, tabId: claude.tabId, workspaceId: 'w9', cwd: claude.cwd, tokens: {}, label,
  });

  for (const tabLabels of [true, false]) {
    it(`at start, \`RAROG_HERDR_TAB_LABELS=${tabLabels ? '1' : '0'}\`: a split tab, a Codex pane, a pane without an agent`,
      async () => {
        const herdr = new MigrationHerdr();
        herdr.addPane(claudePane(LEGACY_CLAUDE));
        // The second pane of the Claude agent's tab: a split tab.
        herdr.addPane({ ...claudePane(LEGACY_TERM), paneId: 'w9:pSPLIT' });
        herdr.addPane({
          paneId: codex.paneId, tabId: codex.tabId, workspaceId: 'wA', cwd: codex.cwd, tokens: {},
          label: `codex · rarog-claude ${KEY} ${TRACE}`,
        });
        herdr.addPane(paneOf('w1:p1', `rarog-term ${TERM_ID}`));
        herdr.addPane(paneOf('w1:p2', 'notes'));
        harness = await startTabLabelHarness([claude, codex], herdr, { tabLabels });
        await settle();

        expect(herdr.renames).toEqual([
          { paneId: claude.paneId, label: CURRENT_CLAUDE },
          { paneId: 'w9:pSPLIT', label: CURRENT_TERM },
          { paneId: codex.paneId, label: 'codex · rc:b63wc318a52vnr' },
          { paneId: 'w1:p1', label: 'rt:tw1wdwhgyfh5w' },
        ]);
        expect(herdr.pane('w1:p2')?.label).toBe('notes');
        expect(herdr.tabLabels).toEqual([]);
      });
  }

  it('herdr unavailable at start → no write; the resync after its return rewrites', async () => {
    const herdr = new MigrationHerdr();
    herdr.addPane(paneOf('w1:p1', LEGACY_TERM));
    herdr.down = true;
    const client = new FlakyAgentClient([]);
    client.down = true;
    harness = await startTabLabelHarness([], herdr, { client });
    await settle();
    expect(herdr.renames).toEqual([]);

    herdr.down = false;
    client.down = false;
    harness.scheduler.advance(HERDR_RESYNC_MS);
    await settle();

    expect(herdr.renames).toEqual([{ paneId: 'w1:p1', label: CURRENT_TERM }]);
    expect(harness.logs).toContain('herdr: available again');
  });

  it('`pane.rename` timed out: the tab label sync waits, the next resync finishes both', async () => {
    const herdr = new MigrationHerdr();
    herdr.addPane(claudePane(`fixes · rarog-claude ${KEY} ${labelTrace('fixes')}`));
    herdr.setTabLabel(claude.tabId, 'fixes');
    herdr.renameOutcome = 'timeout';
    harness = await startTabLabelHarness([claude], herdr);
    await settle();
    expect(herdr.renames).toHaveLength(1);

    // The old label is still Rarog's for every reader, but only the migration rewrites it.
    harness.supervisor.syncTabLabel?.(claude.paneId, 'notes');
    await harness.fire();
    expect(herdr.tabLabels).toEqual([]);
    expect(herdr.renames).toHaveLength(1);

    herdr.renameOutcome = 'ok';
    harness.scheduler.advance(HERDR_RESYNC_MS);
    await settle();
    await harness.fire();

    expect(herdr.tabLabels).toEqual([{ tabId: claude.tabId, label: 'notes' }]);
    expect(herdr.pane(claude.paneId)?.label).toBe(`notes · rc:b63wc31${encodeHex(labelTrace('notes'))}`);
  });

  it('a tab named by hand stays after the migration: `notes 87` → `notes 1161` is not Rarog\'s', async () => {
    // The two names share the first 20 bits of their trace; the full 32 bits tell them apart.
    expect(labelTrace('notes 1161').slice(0, 5)).toBe(labelTrace('notes 87').slice(0, 5));
    const herdr = new MigrationHerdr();
    herdr.addPane(claudePane(`notes 87 · rarog-claude ${KEY} ${labelTrace('notes 87')}`));
    herdr.setTabLabel(claude.tabId, 'notes 1161');
    harness = await startTabLabelHarness([claude], herdr);
    await settle();
    const migrated = herdr.pane(claude.paneId)?.label;
    expect(migrated).toBe(`notes 87 · rc:b63wc31${encodeHex(labelTrace('notes 87'))}`);

    harness.supervisor.syncTabLabel?.(claude.paneId, 'notes 2000');
    await harness.fire();

    expect(herdr.tabLabels).toEqual([]);
    const after = herdr.pane(claude.paneId)?.label;
    expect(after).toBe(`notes 1161 · rc:b63wc31${encodeHex(labelTrace('notes 87'))}`);
    expect(parsePaneLabel(after)).toEqual({ kind: 'claude', keyCode: 'b63wc31', trace: labelTrace('notes 87') });
  });
});

describe('terminal recovery reads an old-format label until it is rewritten', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
  });

  const cwd = '/Users/testowy/Projects/atlas';
  const id = termIdFor(cwd, 2);

  function backendOver(herdr: MigrationHerdr): ReturnType<typeof createHerdrBackend> {
    const dataDir = mkdtempSync(join(tmpdir(), 'rarog-label-migration-'));
    dirs.push(dataDir);
    const config = loadConfig({
      RAROG_ORIGINS: 'https://rarog.example', RAROG_TERM: '1', RAROG_TERM_BACKEND: 'herdr',
      RAROG_HERDR_BIN: '/usr/bin/true', RAROG_HERDR_LAUNCH: '1', RAROG_PROJECT_ROOTS: '/Users/testowy/Projects',
      RAROG_DATA_DIR: dataDir, HOME: '/Users/testowy', PATH: '/usr/bin:/bin', TMPDIR: '/tmp',
    });
    return createHerdrBackend({ config, logger: { info: () => {}, error: () => {} }, launchClient: () => herdr });
  }

  it('`rarog-term <id>` without a token → the token comes back, the label stays for the migration', async () => {
    const herdr = new MigrationHerdr();
    const label = `rarog 2 · atlas · rarog-term ${id}`;
    herdr.addPane(paneOf('w1:p1', label, { cwd }));
    const backend = backendOver(herdr);

    const result = await backend.reconcile();

    expect(result.restored).toEqual(['w1:p1']);
    expect(herdr.pane('w1:p1')?.tokens).toEqual({ [RAROG_TERM_TOKEN]: id });
    expect(herdr.pane('w1:p1')?.label).toBe(label);
    expect(herdr.renames).toEqual([]);
    backend.dispose();
  });

  it('a bare `rarog-term <id>` gets its tab label in front, whether recovery or migration runs first', async () => {
    const described = `rarog 2 · atlas · ${termPaneLabel(id)}`;
    for (const order of ['recovery first', 'migration first'] as const) {
      const herdr = new MigrationHerdr();
      herdr.addPane(paneOf('w1:p1', `rarog-term ${id}`, { cwd, tokens: { [RAROG_TERM_TOKEN]: id } }));
      herdr.setTabLabel('w1:p1t', 'rarog 2 · atlas');
      const backend = backendOver(herdr);
      const migration = createLabelMigration({ client: herdr, writable: () => true, log: () => {} });

      if (order === 'recovery first') await backend.reconcile();
      await migration.run();
      for (let i = 0; i < 3; i += 1) await backend.reconcile();

      expect({ order, label: herdr.pane('w1:p1')?.label }).toEqual({ order, label: described });
      backend.dispose();
    }
  });
});
