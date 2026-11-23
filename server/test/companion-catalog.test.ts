/**
 * The voice agent's session catalog (`server/src/companion/catalog.ts`) over a live session manager: which sessions get
 * a row (the scope gate of the whole mode across sessions), the row's keys, `conversation` across `/clear` and
 * `asksOwner` from the newest message in memory. The manager is real, with a herdr supervisor stand-in and drivers
 * steered by the test (no socket, no conversation file), as in `manager-companion-target.test.ts`; the directories are
 * real, in a temporary directory, so the work area is judged on disk with its symlinks.
 */
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foreign, say } from '@rarog/shared/sentences';
import { companionSessionsSchema } from '@rarog/shared/rest';
import { companionCatalog } from '../src/companion/catalog.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { HerdrManagerDeps, Manager, ManagerConfig } from '../src/sessions/manager.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';

const CONV_A = '4b7f0d2e-9c61-4a3b-8e15-2d9f6c0a7b31';
const CONV_B = '7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const QUESTION = 'Done.\n\n**Do Ciebie:** merge now or wait?';

class Nadzorca extends AtrapaNadzorcy {
  protected nowyDriver(key: string): AtrapaDrivera {
    return new AtrapaDrivera(key, { dziennik: this.log });
  }

  appear(agent: HerdrAgent): void {
    this.lifecycle.push({ type: 'appeared', agent });
  }
}

const idOf = (key: string): string => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`;
/** A readable token: the test sees which conversation a row names. */
const token = (agentSessionId: string | undefined): string => `token-${agentSessionId ?? 'none'}`;

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

let base = '';
let home = '';
let root = '';
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  base = realpathSync(await mkdtemp(join(tmpdir(), 'rarog-catalog-')));
  home = join(base, 'home');
  root = join(home, 'Projects');
  for (const dir of ['Projects/atlas', 'Projects/birch', 'Desktop/tajne']) mkdirSync(join(home, dir), { recursive: true });
  mkdirSync(join(base, 'elsewhere'), { recursive: true });
  // A directory under the root that leads into a protected folder of home.
  symlinkSync(join(home, 'Desktop', 'tajne'), join(root, 'link'));
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await rm(base, { recursive: true, force: true });
});

interface Rig {
  manager: Manager;
  supervisor: Nadzorca;
  push(key: string, ...events: DriverEvent[]): Promise<void>;
}

function agent(key: string, overrides: Partial<HerdrAgent> = {}): HerdrAgent {
  return {
    key, paneId: key, tabId: 'w1:t1', agentSessionId: CONV_A, engine: 'claude', termId: null,
    cwd: join(root, 'atlas'), status: 'idle', title: key, stateChangeSeq: 1, mode: 'auto', modeReadAt: 0,
    inScope: true, launchedByRarog: false, interactiveReady: true, ...overrides,
  };
}

async function rig(agents: readonly HerdrAgent[]): Promise<Rig> {
  const supervisor = new Nadzorca();
  const deps: HerdrManagerDeps = {
    sessionIdFor: idOf,
    aliasFor: () => undefined,
    rememberAlias: () => undefined,
    assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true,
    writeUploads: () => Promise.resolve([]),
    writeUploadFiles: () => Promise.resolve([]),
    sweepUploads: () => Promise.resolve(),
  };
  // `home` is the scope gate's home directory (`SessionScopeConfig.home`), so the protected folders are the
  // temporary ones; a variable, not a literal, because `ManagerConfig` itself does not name it.
  const config = {
    demo: false, dataDir: join(base, 'dane'), herdrSupervisor: supervisor, herdrDeps: deps, herdrRoots: [root], home,
    now: () => Date.parse('2026-11-20T10:00:00.000Z'), gitStatus: null, gitWatcher: null,
    liveSessionsReader: () => Promise.resolve(null),
  };
  const manager = await createManager(config satisfies ManagerConfig);
  await manager.ready;
  closers.push(async () => {
    await manager.dispose();
    supervisor.dispose();
  });
  for (const one of agents) supervisor.appear(one);
  await flush();
  return {
    manager, supervisor,
    push: async (key, ...events) => {
      for (const event of events) supervisor.driver(key).queue.push(event);
      await flush();
    },
  };
}

const text = (role: 'user' | 'assistant' | 'system', value: string): DriverEvent => ({
  type: 'message', role, blocks: [{ type: 'text', text: foreign(value) }],
});
const working: DriverEvent = { type: 'agent-state', state: 'working', seen: true };
const idle: DriverEvent = { type: 'agent-state', state: 'idle', seen: false };

describe('companion catalog: which sessions have a row', () => {
  it('a Claude Code session in scope has a row; Codex, out of scope, outside the roots and a link out of the area do not', async () => {
    // Each pane but the first fails exactly one check of the gate; the others would let it through.
    const r = await rig([
      agent('w1:p1'),
      agent('w1:p2', { engine: 'codex', agentSessionId: CONV_B }),
      // herdr reports the pane out of scope (it went `cd` out of the roots); the card keeps a directory in them.
      agent('w1:p3', { inScope: false, cwd: join(root, 'birch'), agentSessionId: CONV_B }),
      agent('w1:p4', { cwd: join(base, 'elsewhere'), agentSessionId: CONV_B }),
      agent('w1:p5', { cwd: join(root, 'link'), agentSessionId: CONV_B }),
    ]);
    // Every pane has a card in the session list: the catalog alone leaves four of them out.
    expect(r.manager.list().map((s) => s.id).sort()).toEqual(['w1:p1', 'w1:p2', 'w1:p3', 'w1:p4', 'w1:p5'].map(idOf));
    const catalog = companionCatalog(r.manager, token);
    expect(companionSessionsSchema.parse(catalog)).toEqual(catalog);
    expect(catalog.sessions.map((row) => row.id)).toEqual([idOf('w1:p1')]);
  });

  it('a row carries exactly the id, the conversation token and stateSince as the session list has it', async () => {
    const r = await rig([agent('w1:p1'), agent('w1:p6', { cwd: join(root, 'birch'), agentSessionId: CONV_B })]);
    await r.push('w1:p1', { type: 'init', engineSessionId: CONV_A, model: 'claude-opus-5' });
    await r.push('w1:p6', { type: 'init', engineSessionId: CONV_B, model: 'claude-opus-5' });
    const catalog = companionCatalog(r.manager, token);
    expect(catalog.sessions).toHaveLength(2);
    for (const row of catalog.sessions) {
      expect(Object.keys(row).sort()).toEqual(['conversation', 'id', 'stateSince']);
      expect(row.stateSince).toBe(r.manager.get(row.id)?.stateSince);
    }
    expect(catalog.sessions.find((row) => row.id === idOf('w1:p6'))?.conversation).toBe(token(CONV_B));
  });
});

describe('companion catalog: conversation and asksOwner', () => {
  const KEY = 'w1:p1';
  const ID = idOf(KEY);
  const rowOf = (r: Rig) => companionCatalog(r.manager, token).sessions.find((row) => row.id === ID);

  async function answered(r: Rig, answer: string): Promise<void> {
    await r.push(KEY, { type: 'init', engineSessionId: CONV_A, model: 'claude-opus-5' }, working, text('user', 'prompt'),
      text('assistant', answer), idle);
  }

  it('the last answer asks the owner while the session waits for input: asksOwner: true', async () => {
    const r = await rig([agent(KEY)]);
    await answered(r, QUESTION);
    expect(r.manager.get(ID)?.state).toBe('waiting-input');
    const row = rowOf(r);
    expect(row?.asksOwner).toBe(true);
    expect(Object.keys(row ?? {}).sort()).toEqual(['asksOwner', 'conversation', 'id', 'stateSince']);
    expect(row?.conversation).toBe(token(CONV_A));
  });

  it('the marker in a code block, a list, a quote or a heading of the last answer: no field', async () => {
    for (const answer of [
      'Example:\n\n```\n**Do Ciebie:** merge?\n```', '- **Do Ciebie:** merge?', '> **Do Ciebie:** merge?',
      '## **Do Ciebie:** merge?',
    ]) {
      const r = await rig([agent(KEY)]);
      await answered(r, answer);
      expect(r.manager.get(ID)?.state, answer).toBe('waiting-input');
      expect(rowOf(r) && 'asksOwner' in rowOf(r)!, answer).toBe(false);
    }
  });

  it('a session in its turn: no field, also with the question as the last message', async () => {
    const r = await rig([agent(KEY)]);
    await r.push(KEY, { type: 'init', engineSessionId: CONV_A, model: 'claude-opus-5' }, working, text('user', 'prompt'),
      text('assistant', QUESTION));
    expect(r.manager.get(ID)?.state).toBe('running');
    expect(rowOf(r)).toBeDefined();
    expect('asksOwner' in rowOf(r)!).toBe(false);
  });

  it('the last message arrives after the session went to waiting-input: the next read has the field', async () => {
    const r = await rig([agent(KEY)]);
    await r.push(KEY, { type: 'init', engineSessionId: CONV_A, model: 'claude-opus-5' }, working, text('user', 'prompt'), idle);
    expect(r.manager.get(ID)?.state).toBe('waiting-input');
    expect('asksOwner' in rowOf(r)!).toBe(false);
    await r.push(KEY, text('assistant', QUESTION));
    expect(r.manager.get(ID)?.state).toBe('waiting-input');
    expect(rowOf(r)?.asksOwner).toBe(true);
  });

  it('only the last message counts: a task notification after the question drops the field', async () => {
    const r = await rig([agent(KEY)]);
    await answered(r, QUESTION);
    expect(rowOf(r)?.asksOwner).toBe(true);
    await r.push(KEY, {
      type: 'message', role: 'user', blocks: [{ type: 'text', text: foreign('Background command finished') }],
      notice: { kind: 'command', outcome: 'done' },
    });
    expect(r.manager.get(ID)?.state).toBe('waiting-input');
    expect('asksOwner' in rowOf(r)!).toBe(false);
  });

  it('/clear: another conversation token, and without a new turn no field', async () => {
    const r = await rig([agent(KEY)]);
    await answered(r, QUESTION);
    expect(rowOf(r)?.conversation).toBe(token(CONV_A));
    await r.push(KEY, { type: 'init', engineSessionId: CONV_B, model: 'claude-opus-5' }, {
      type: 'message', role: 'system', blocks: [{ type: 'text', text: say('transcript.repoint-clear') }],
    });
    const row = rowOf(r);
    expect(row?.conversation).toBe(token(CONV_B));
    expect(row?.conversation).not.toBe(token(CONV_A));
    expect('asksOwner' in row!).toBe(false);
  });

  it('/clear announced before its note: the new token and no field from the previous conversation', async () => {
    const r = await rig([agent(KEY)]);
    await answered(r, QUESTION);
    expect(rowOf(r)?.asksOwner).toBe(true);
    // The driver announces the new conversation at once; the follower's note comes only after a disk probe.
    await r.push(KEY, { type: 'init', engineSessionId: CONV_B, model: 'claude-opus-5' });
    expect(r.manager.get(ID)?.state).toBe('waiting-input');
    const row = rowOf(r);
    expect(row?.conversation).toBe(token(CONV_B));
    expect('asksOwner' in row!).toBe(false);
  });

  it('after /clear an answer that asks the owner in the new conversation brings the field back', async () => {
    const r = await rig([agent(KEY)]);
    await answered(r, QUESTION);
    await r.push(KEY, { type: 'init', engineSessionId: CONV_B, model: 'claude-opus-5' });
    expect('asksOwner' in rowOf(r)!).toBe(false);
    await r.push(KEY, text('assistant', QUESTION));
    expect(r.manager.get(ID)?.state).toBe('waiting-input');
    expect(rowOf(r)).toEqual({
      id: ID, asksOwner: true, conversation: token(CONV_B), stateSince: r.manager.get(ID)?.stateSince,
    });
  });

  it('/resume to an earlier conversation: its imported history counts, so its own last question is the field', async () => {
    const r = await rig([agent(KEY)]);
    await answered(r, 'Plain answer.');
    await r.push(KEY, { type: 'init', engineSessionId: CONV_B, model: 'claude-opus-5' });
    // `/resume` of a conversation whose last answer asks the owner: the pane moves, then its history is imported.
    await r.push(KEY, { type: 'init', engineSessionId: CONV_A, model: 'claude-opus-5' }, {
      type: 'history', messages: [
        { role: 'user', blocks: [{ type: 'text', text: foreign('earlier prompt') }], at: '2026-11-19T09:00:00.000Z' },
        { role: 'assistant', blocks: [{ type: 'text', text: foreign(QUESTION) }], at: '2026-11-19T09:01:00.000Z' },
      ],
    });
    expect(r.manager.get(ID)?.state).toBe('waiting-input');
    const row = rowOf(r);
    expect(row?.conversation).toBe(token(CONV_A));
    expect(row?.asksOwner).toBe(true);
    // The pane's move alone, before any history of the resumed conversation, gives no field.
    await r.push(KEY, { type: 'init', engineSessionId: CONV_B, model: 'claude-opus-5' });
    expect('asksOwner' in rowOf(r)!).toBe(false);
  });

  const historyOf = (engineSessionId: string, answer: string): DriverEvent => ({
    type: 'history', engineSessionId, messages: [
      { role: 'user', blocks: [{ type: 'text', text: foreign('earlier prompt') }], at: '2026-11-19T09:00:00.000Z' },
      { role: 'assistant', blocks: [{ type: 'text', text: foreign(answer) }], at: '2026-11-19T09:01:00.000Z' },
    ],
  });

  it('the pane moved to another conversation before its driver attached: the history handed over before the '
    + 'announcement counts as the announced conversation\'s', async () => {
    const r = await rig([agent(KEY)]);
    await answered(r, 'Plain answer.');
    // The new driver follows the conversation the pane runs now: its history comes first, then the line that names it.
    await r.push(KEY, historyOf(CONV_B, QUESTION), { type: 'init', engineSessionId: CONV_B, model: 'claude-opus-5' });
    expect(r.manager.get(ID)?.state).toBe('waiting-input');
    const row = rowOf(r);
    expect(row?.conversation).toBe(token(CONV_B));
    expect(row?.asksOwner).toBe(true);
  });

  it('history of the conversation the session had, then a move to another one: no field from the history', async () => {
    const r = await rig([agent(KEY)]);
    await answered(r, 'Plain answer.');
    // A driver attached to the session's own conversation, and the pane moved before the line that names it.
    await r.push(KEY, historyOf(CONV_A, QUESTION), { type: 'init', engineSessionId: CONV_B, model: 'claude-opus-5' });
    expect(r.manager.get(ID)?.state).toBe('waiting-input');
    const row = rowOf(r);
    expect(row?.conversation).toBe(token(CONV_B));
    expect('asksOwner' in row!).toBe(false);
  });
});
