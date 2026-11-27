/**
 * Pane labels with a leading description: every reader accepts both the bare format
 * (`rc:<key code><trace code>`, `rt:<id code>`) and `<description> · rc:…`, `<description> · rt:…`.
 *
 * These tests pin the reading side: the parser, the supervisor's tab label sync (its write gate
 * compares against the label it READ) and terminal pane recovery. The writing side is pinned in
 * `server/test/etykiety-paneli-zapis.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { keyCodeOf } from '../src/herdr/label-code.ts';
import {
  claudePaneLabel, labelTrace, parsePaneLabel, termPaneLabel,
} from '../src/herdr/provenance.ts';
import type { HerdrPaneInfo } from '../src/herdr/types.ts';
import { RAROG_TERM_TOKEN, createHerdrBackend } from '../src/term/herdr-backend.ts';
import { matchTermLabel, termIdFor } from '../src/term/lifecycle.ts';
import { FakeHerdr } from './fake-term-herdr.ts';
import { namedFixtureAgent, startTabLabelHarness } from './helpers/supervisor-tab-label-harness.ts';
import type { TabLabelHarness } from './helpers/supervisor-tab-label-harness.ts';

const KEY = 'abababababababab';
const TRACE = '89abcdef';
const CLAUDE = claudePaneLabel(KEY, TRACE);
const TERM = termPaneLabel(KEY);
const OF_CLAUDE = { kind: 'claude', keyCode: keyCodeOf(KEY), trace: TRACE };

describe('parsePaneLabel — bare and described formats', () => {
  const cases: [string, Readonly<Record<string, string>> | null][] = [
    [CLAUDE, OF_CLAUDE],
    [`PR-y · ${CLAUDE}`, OF_CLAUDE],
    [TERM, { kind: 'term', id: KEY }],
    [`rarog 2 · atlas · ${TERM}`, { kind: 'term', id: KEY }],
    [`x · ${TERM} · ${CLAUDE}`, OF_CLAUDE],
    [`foo ${TERM}`, null],
    [`  · ${TERM}`, null],
    [`Opis · ${CLAUDE.toUpperCase()}`, null],
  ];
  for (const [label, expected] of cases) {
    it(`${JSON.stringify(label)} → ${expected === null ? 'null' : expected.kind}`, () => {
      expect(parsePaneLabel(label)).toEqual(expected);
    });
  }

  it('a description does not loosen the suffix: separators and the code stay exact', () => {
    const foreign = [
      ` · ${TERM}`,
      `a ·${TERM}`,
      `a· ${TERM}`,
      `a · ${TERM} `,
      `a · ${TERM}0`,
      `a · ${CLAUDE.slice(0, -7)}`,
      `a · ${CLAUDE} extra`,
      `a · R${TERM.slice(1)}`,
      `a\nb · ${TERM}`,
    ];
    for (const label of foreign) expect(parsePaneLabel(label), JSON.stringify(label)).toBeNull();
  });

  it('a terminal identity in a described label still matches its directory', () => {
    const cwd = '/Users/u/Projects/atlas';
    const id = termIdFor(cwd, 2);
    expect(matchTermLabel(`rarog 2 · atlas · ${termPaneLabel(id)}`, cwd))
      .toEqual({ id, slot: 2, role: 'shell' });
  });
});

/** The terminal fake plus a record of every `pane.rename` and a hook inside `tab.get`. */
class RecordingHerdr extends FakeHerdr {
  readonly paneRenames: { paneId: string; label: string | null }[] = [];
  onGetTab: (() => void) | null = null;

  override renamePane(paneId: string, label: string | null): Promise<void> {
    this.paneRenames.push({ paneId, label });
    return super.renamePane(paneId, label);
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
}

describe('supervisor tab label sync reads a described Claude pane label', () => {
  let harness: TabLabelHarness | null = null;
  afterEach(() => {
    harness?.supervisor.dispose();
    harness = null;
  });

  async function withPane(paneLabel: string, tabLabel: string): Promise<{
    herdr: RecordingHerdr; paneId: string; tabId: string; h: TabLabelHarness;
  }> {
    const agent = namedFixtureAgent(0, 'rarog-abc123');
    const herdr = new RecordingHerdr();
    const pane: HerdrPaneInfo = {
      paneId: agent.paneId, tabId: agent.tabId, workspaceId: 'w9', cwd: agent.cwd, tokens: {},
      label: paneLabel,
    };
    herdr.addPane(pane);
    herdr.setTabLabel(agent.tabId, tabLabel);
    harness = await startTabLabelHarness([agent], herdr);
    return { herdr, paneId: agent.paneId, tabId: agent.tabId, h: harness };
  }

  it('card "a" → "b": `tab.rename` to "b" and `pane.rename` with "b" in front and the new trace', async () => {
    const { herdr, paneId, tabId, h } = await withPane(
      `a · ${claudePaneLabel(KEY, labelTrace('a'))}`, 'a',
    );

    h.supervisor.syncTabLabel?.(paneId, 'b');
    await h.fire();

    expect(herdr.tabLabels).toEqual([{ tabId, label: 'b' }]);
    expect(herdr.paneRenames).toEqual([{ paneId, label: claudePaneLabel(KEY, labelTrace('b'), 'b') }]);
    expect(herdr.pane(paneId)?.label).toBe(claudePaneLabel(KEY, labelTrace('b'), 'b'));
  });

  it('tab already carries the card label, trace is stale → one `pane.rename`, no `tab.rename`', async () => {
    const { herdr, paneId, h } = await withPane(
      `b · ${claudePaneLabel(KEY, labelTrace('a'))}`, 'b',
    );

    h.supervisor.syncTabLabel?.(paneId, 'b');
    await h.fire();

    expect(herdr.tabLabels).toEqual([]);
    expect(herdr.paneRenames).toEqual([{ paneId, label: claudePaneLabel(KEY, labelTrace('b'), 'b') }]);
  });

  it('only the description changes between the read and the write gate → zero writes', async () => {
    const { herdr, paneId, h } = await withPane(
      `a · ${claudePaneLabel(KEY, labelTrace('a'))}`, 'a',
    );
    // Same key and trace, other description: the gate compares the label it read, verbatim.
    herdr.onGetTab = () => {
      herdr.relabelByHand(paneId, `zz · ${claudePaneLabel(KEY, labelTrace('a'))}`);
    };

    h.supervisor.syncTabLabel?.(paneId, 'b');
    await h.fire();

    expect(herdr.tabLabels).toEqual([]);
    expect(herdr.paneRenames).toEqual([]);
    expect(h.logs.some((line) => line.includes(`pane ${paneId} changed before`))).toBe(true);
  });
});

describe('terminal pane recovery reads a described `rt:` label', () => {
  const CWD = '/Users/testowy/Projects/atlas';
  const ID = termIdFor(CWD, 2);
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
  });

  function backendOver(herdr: FakeHerdr): ReturnType<typeof createHerdrBackend> {
    const dataDir = mkdtempSync(join(tmpdir(), 'rarog-pane-labels-'));
    dirs.push(dataDir);
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
    });
    return createHerdrBackend({
      config, logger: { info: () => {}, error: () => {} }, launchClient: () => herdr,
    });
  }

  const paneWith = (paneId: string, label: string): HerdrPaneInfo => ({
    paneId, tabId: `${paneId}t`, workspaceId: 'w1', cwd: CWD, tokens: {}, label,
  });

  it('`rarog 2 · atlas · rt:<id>` without a token → the token comes back', async () => {
    const herdr = new RecordingHerdr();
    const label = `rarog 2 · atlas · ${termPaneLabel(ID)}`;
    herdr.addPane(paneWith('w1:p1', label));

    const result = await backendOver(herdr).reconcile();

    expect(result.restored).toEqual(['w1:p1']);
    expect(result.confirmed.get('w1:p1')).toBe(ID);
    expect(herdr.pane('w1:p1')?.tokens).toEqual({ [RAROG_TERM_TOKEN]: ID });
    expect(herdr.pane('w1:p1')?.label).toBe(label);
    expect(herdr.paneRenames).toEqual([]);
  });

  it('one id on two panes (bare and described label) → conflict, zero writes', async () => {
    const herdr = new RecordingHerdr();
    herdr.addPane(paneWith('w1:p1', termPaneLabel(ID)));
    herdr.addPane(paneWith('w1:p2', `rarog 2 · atlas · ${termPaneLabel(ID)}`));

    const result = await backendOver(herdr).reconcile();

    expect([...result.conflicts]).toEqual([ID]);
    expect(result.restored).toEqual([]);
    expect(herdr.stamps).toEqual([]);
    expect(herdr.paneRenames).toEqual([]);
    expect(herdr.tabLabels).toEqual([]);
  });
});
