/**
 * Claim window of the consent channel: after the hook claimed a phone answer (card `claimed`), herdr `blocked`
 * of that session does not move it back to `waiting-permission` for a short window (`CONSENT_CLAIM_WINDOW_MS`).
 *
 * The answered dialog stays on the pane for a moment after the claim, so herdr still sees it and repeats `blocked`.
 * Without the window the app showed the answered card, then "waiting for consent" without the input field, then the
 * field again: two layout jumps within a second. The window ends early on another herdr status, a new hook
 * registration of the engine session (main thread or subagent), a card of another request, or a dialog card from the
 * screen or the transcript. After the window a `blocked` herdr still reports moves the state as before.
 *
 * Real manager, fake herdr supervisor and driver, a consent channel whose cards the test sets, fake timers.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HerdrStatus, ServerEvent, SessionState } from '@rarog/shared';
import type { DriverEvent } from '../src/drivers/types.ts';
import type { ConsentCardView } from '../src/herdr/dialogs/layer1/cards.ts';
import { CONSENT_SECRET_BYTES } from '../src/herdr/dialogs/layer1/contract.ts';
import type { ConsentDecision, ConsentWireState } from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import { CONSENT_CLAIM_WINDOW_MS } from '../src/sessions/claim-window.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { ConsentManagerChannel, HerdrManagerDeps, Manager } from '../src/sessions/manager.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';

const ENGINE = '7a3e1c55-9d0b-4f62-8e11-2b6f4c9d0e31';
/** Another conversation in the same pane (`/clear`, `/resume`). */
const ENGINE_OTHER = 'c4d1e9a0-6b2f-4e83-a5c7-0f9b3d2e8a64';
const PROMPT = '5c2d8e10-1f4a-4b7e-9c3d-6a8b0e2f4d17';
const PROJECT = '/Users/u/Projects/atlas';
const PANE = 'w9:p72';
const KEY = `${PROMPT}-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
const KEY_OTHER = `${PROMPT}-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`;

class FakeSupervisor extends AtrapaNadzorcy {
  override status(): HerdrStatus {
    return { available: true, agentCount: 0, readOnly: false, canLaunch: false };
  }

  protected nowyDriver(key: string): AtrapaDrivera {
    const driver = new AtrapaDrivera(key);
    driver.queue.push({ type: 'agent-state', state: 'working', seen: true });
    return driver;
  }

  appear(agent: HerdrAgent): void {
    this.lifecycle.push({ type: 'appeared', agent });
  }
}

function makeDeps(): HerdrManagerDeps {
  return {
    sessionIdFor: (key: string) => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`,
    aliasFor: () => undefined,
    rememberAlias: () => undefined,
    assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true,
    writeUploads: async () => [],
    writeUploadFiles: async () => [],
    sweepUploads: async () => undefined,
  };
}

function makeAgent(): HerdrAgent {
  return {
    key: PANE, paneId: PANE, agentSessionId: ENGINE, engine: 'claude', termId: null, cwd: PROJECT, status: 'working',
    title: 'atlas', stateChangeSeq: 1, mode: 'auto', modeReadAt: 0, inScope: true, tabId: 'w9:t3',
    launchedByRarog: false, interactiveReady: true,
  };
}

function viewOf(permId: string, state: ConsentWireState): ConsentCardView {
  return {
    permId, sessionId: ENGINE, promptId: PROMPT, toolName: 'Bash', agentId: null, presentation: null, state,
    canAllow: state === 'pending', canDeny: state === 'pending', canRelease: state === 'pending', unavailable: null,
    cause: null, late: false, createdAt: Date.now(),
  };
}

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

interface Built {
  readonly manager: Manager;
  readonly driver: AtrapaDrivera;
  readonly id: string;
  readonly lines: string[];
  /** States of `session-changed` frames of the session since the last {@link Built.mark}. */
  states(): SessionState[];
  mark(): void;
  state(): SessionState | undefined;
  /** A card change from the channel cycle (`onCard` → `applyConsentCard`); the channel then reads this view. */
  card(permId: string, state: ConsentWireState, decision?: ConsentDecision | null): Promise<void>;
  push(event: DriverEvent): Promise<void>;
  /** Moves the fake clock forward and lets the event pump run. */
  advance(ms: number): Promise<void>;
}

describe('claim window: herdr `blocked` right after a claimed phone answer', () => {
  let dataDir: string;
  const closers: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-claim-window-'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const close of closers.splice(0).reverse()) await close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function build(): Promise<Built> {
    const cards = new Map<string, ConsentCardView>();
    const consent: ConsentManagerChannel = {
      cards: () => [...cards.values()],
      decide: () => Promise.reject(new Error('unused')),
      release: () => Promise.reject(new Error('unused')),
      revoke: () => Promise.resolve([]),
      retire: () => Promise.resolve(),
      turnEnded: () => Promise.resolve(),
      reattached: () => Promise.resolve(),
    };
    const supervisor = new FakeSupervisor();
    const lines: string[] = [];
    const manager = await createManager({
      demo: false, dataDir, projects: [{ path: PROJECT, name: 'atlas' }], projectRoots: [], gitStatus: null,
      herdrSupervisor: supervisor, herdrDeps: makeDeps(), herdrRoots: [PROJECT], herdrSend: true, consent,
      logger: (line) => { lines.push(line); },
    });
    await manager.ready;
    const events: ServerEvent[] = [];
    manager.onEvent((_scope, _seq, event) => { events.push(event); });
    supervisor.appear(makeAgent());
    await flush();
    closers.push(async () => {
      await manager.dispose();
      supervisor.dispose();
    });
    const driver = supervisor.driver(PANE);
    const id = manager.list().find((s) => s.paneId === PANE)?.id ?? '';
    expect(id).not.toBe('');
    // Fake clock from here on: the window timer and `Date.now()` of the manager.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let from = events.length;
    return {
      manager, driver, id, lines,
      states: () => events.slice(from).flatMap((e) => (e.type === 'session-changed' && e.session.id === id
        ? [e.session.state] : [])),
      mark: () => { from = events.length; },
      state: () => manager.get(id)?.state,
      card: async (permId, state, decision = null) => {
        const view = viewOf(permId, state);
        cards.set(permId, view);
        manager.applyConsentCard?.(view, decision);
        await flush();
      },
      push: async (event) => {
        driver.queue.push(event);
        await flush();
      },
      advance: async (ms) => {
        vi.advanceTimersByTime(ms);
        await flush();
      },
    };
  }

  /** Dialog with a channel card, the phone's `allow`, then the hook's claim: the session is back in `running`. */
  async function claimed(): Promise<Built> {
    const b = await build();
    await b.push({ type: 'agent-state', state: 'blocked' });
    expect(b.state()).toBe('waiting-permission');
    await b.card(KEY, 'pending');
    await b.card(KEY, 'sent', 'allow');
    expect(b.state()).toBe('running');
    await b.card(KEY, 'claimed', 'allow');
    expect(b.state()).toBe('running');
    b.mark();
    return b;
  }

  it('1. claim, `blocked` after 400 ms, `working` after 1100 ms: `running` all the time', async () => {
    const b = await claimed();
    const logged = b.lines.length;
    await b.advance(400);
    await b.push({ type: 'agent-state', state: 'blocked' });
    expect(b.state()).toBe('running');
    await b.advance(700);
    await b.push({ type: 'agent-state', state: 'working' });
    expect(b.state()).toBe('running');
    await b.advance(CONSENT_CLAIM_WINDOW_MS);
    expect(b.state()).toBe('running');
    expect(b.states()).not.toContain('waiting-permission');
    expect(b.lines.slice(logged).some((line) => line.includes('→ waiting-permission'))).toBe(false);
    expect(b.lines.slice(logged)).toEqual([
      `consent: claim window of session ${b.id} holds herdr blocked (400 ms after the claim)`,
    ]);
  });

  it('2. claim, `blocked` lasting 3 s: `waiting-permission` only after the window', async () => {
    const b = await claimed();
    await b.advance(400);
    await b.push({ type: 'agent-state', state: 'blocked' });
    await b.advance(CONSENT_CLAIM_WINDOW_MS - 401);
    expect(b.state()).toBe('running');
    expect(b.states()).not.toContain('waiting-permission');
    await b.advance(1);
    expect(b.state()).toBe('waiting-permission');
    await b.advance(3_000 - CONSENT_CLAIM_WINDOW_MS);
    expect(b.state()).toBe('waiting-permission');
    expect(b.lines).toContain(
      `consent: claim window of session ${b.id} ended (window over): running → waiting-permission (herdr: blocked)`,
    );
  });

  it('2b. a `blocked` repeat inside the window does not extend it', async () => {
    const b = await claimed();
    await b.advance(400);
    await b.push({ type: 'agent-state', state: 'blocked' });
    await b.advance(1_500);
    await b.push({ type: 'agent-state', state: 'blocked' });
    expect(b.state()).toBe('running');
    await b.advance(CONSENT_CLAIM_WINDOW_MS - 1_900);
    expect(b.state()).toBe('waiting-permission');
  });

  it('3. claim, a new hook registration of the session inside the window, then `blocked`: `waiting-permission` at once',
    async () => {
      const b = await claimed();
      await b.advance(300);
      b.manager.noteConsentRegistration?.(ENGINE);
      await b.advance(100);
      await b.push({ type: 'agent-state', state: 'blocked' });
      expect(b.state()).toBe('waiting-permission');
    });

  it('3b. a held `blocked` moves the state as soon as a new registration arrives', async () => {
    const b = await claimed();
    await b.advance(300);
    await b.push({ type: 'agent-state', state: 'blocked' });
    expect(b.state()).toBe('running');
    b.manager.noteConsentRegistration?.(ENGINE);
    await flush();
    expect(b.state()).toBe('waiting-permission');
    expect(b.lines).toContain(
      `consent: claim window of session ${b.id} ended (registration): running → waiting-permission (herdr: blocked)`,
    );
  });

  it('3c. a registration of another engine session leaves the window open', async () => {
    const b = await claimed();
    await b.advance(300);
    b.manager.noteConsentRegistration?.('0b8f6a2e-3c41-4d5a-9e7f-1a2b3c4d5e6f');
    await b.push({ type: 'agent-state', state: 'blocked' });
    expect(b.state()).toBe('running');
  });

  it('3d. a card of another request inside the window: `waiting-permission` at once, the next `blocked` too',
    async () => {
      const b = await claimed();
      await b.advance(300);
      await b.push({ type: 'agent-state', state: 'blocked' });
      expect(b.state()).toBe('running');
      await b.card(KEY_OTHER, 'pending');
      expect(b.state()).toBe('waiting-permission');
    });

  it.each([
    {
      name: 'a dialog outside the transcript', state: 'waiting-permission' as const,
      card: { type: 'screen-dialog' } as DriverEvent,
    },
    {
      name: 'a consent card from the screen', state: 'waiting-permission' as const,
      card: { type: 'permission-request', reqId: 'r1', toolName: 'dialog', input: null, displayText: '' } as DriverEvent,
    },
    {
      name: 'a question form', state: 'waiting-question' as const,
      card: { type: 'question-request', reqId: 'q1', questions: [] } as DriverEvent,
    },
  ])('4. claim, a held `blocked`, then $name from the screen: the card state at once', async ({ card, state }) => {
    const b = await claimed();
    await b.advance(300);
    await b.push({ type: 'agent-state', state: 'blocked' });
    expect(b.state()).toBe('running');
    await b.push(card);
    expect(b.state()).toBe(state);
  });

  it('4b. claim, a question form from the screen, then `blocked`: the window is over, `blocked` moves the state'
    + ' as before', async () => {
    const b = await claimed();
    await b.advance(300);
    await b.push({ type: 'question-request', reqId: 'q1', questions: [] });
    expect(b.state()).toBe('waiting-question');
    await b.push({ type: 'agent-state', state: 'blocked' });
    expect(b.state()).toBe('waiting-permission');
  });

  it('herdr reports another status inside the window: the window ends, the next `blocked` moves the state', async () => {
    const b = await claimed();
    await b.advance(300);
    await b.push({ type: 'agent-state', state: 'working' });
    await b.advance(300);
    await b.push({ type: 'agent-state', state: 'blocked' });
    expect(b.state()).toBe('waiting-permission');
  });

  it('6. a held `blocked`, then an interrupt just before the end of the window: `waiting-input` stays after the timer',
    async () => {
      const b = await claimed();
      await b.advance(400);
      await b.push({ type: 'agent-state', state: 'blocked' });
      expect(b.state()).toBe('running');
      await b.advance(1_500);
      await b.manager.interrupt(b.id);
      await flush();
      expect(b.state()).toBe('waiting-input');
      await b.advance(CONSENT_CLAIM_WINDOW_MS);
      expect(b.state()).toBe('waiting-input');
      expect(b.states()).not.toContain('waiting-permission');
    });

  it('6c. the session already in `waiting-input` with a held `blocked` (the state does not move), then an interrupt:'
    + ' the window ends, the timer does not set `waiting-permission`', async () => {
    const b = await build();
    await b.push({ type: 'result', subtype: 'success' });
    expect(b.state()).toBe('waiting-input');
    await b.card(KEY, 'claimed', 'allow');
    expect(b.state()).toBe('waiting-input');
    b.mark();
    await b.advance(400);
    await b.push({ type: 'agent-state', state: 'blocked' });
    expect(b.state()).toBe('waiting-input');
    expect(b.lines).toContain(`consent: claim window of session ${b.id} holds herdr blocked (400 ms after the claim)`);
    await b.manager.interrupt(b.id);
    await flush();
    expect(b.state()).toBe('waiting-input');
    await b.advance(CONSENT_CLAIM_WINDOW_MS);
    expect(b.state()).toBe('waiting-input');
    expect(b.states()).not.toContain('waiting-permission');
  });

  it('6b. a held `blocked`, then the turn ends (`result`) inside the window: `waiting-input` stays after the timer',
    async () => {
      const b = await claimed();
      await b.advance(400);
      await b.push({ type: 'agent-state', state: 'blocked' });
      await b.advance(1_500);
      await b.push({ type: 'result', subtype: 'success' });
      expect(b.state()).toBe('waiting-input');
      await b.advance(CONSENT_CLAIM_WINDOW_MS);
      expect(b.state()).toBe('waiting-input');
      expect(b.states()).not.toContain('waiting-permission');
    });

  it('7. the pane moves to another conversation inside the window: its `blocked` moves the state at once',
    async () => {
      const b = await claimed();
      const logged = b.lines.length;
      await b.advance(300);
      await b.push({ type: 'init', engineSessionId: ENGINE_OTHER, model: '' });
      await b.advance(100);
      await b.push({ type: 'agent-state', state: 'blocked' });
      expect(b.state()).toBe('waiting-permission');
      await b.advance(CONSENT_CLAIM_WINDOW_MS);
      expect(b.state()).toBe('waiting-permission');
      expect(b.lines.slice(logged).some((line) => line.startsWith('consent: claim window'))).toBe(false);
    });

  it('7b. a held `blocked` of the old conversation, then the pane moves to another: the old timer changes nothing',
    async () => {
      const b = await claimed();
      await b.advance(300);
      await b.push({ type: 'agent-state', state: 'blocked' });
      expect(b.state()).toBe('running');
      await b.advance(300);
      await b.push({ type: 'init', engineSessionId: ENGINE_OTHER, model: '' });
      await b.advance(CONSENT_CLAIM_WINDOW_MS);
      expect(b.state()).toBe('running');
      expect(b.lines.some((line) => line.includes('ended (window over)'))).toBe(false);
    });

  it('5. without a claim: `blocked` moves the state at once (plain `blocked`, and after a `sent` answer)', async () => {
    const b = await build();
    await b.push({ type: 'agent-state', state: 'blocked' });
    expect(b.state()).toBe('waiting-permission');
    await b.card(KEY, 'pending');
    await b.card(KEY, 'sent', 'allow');
    expect(b.state()).toBe('running');
    await b.advance(400);
    await b.push({ type: 'agent-state', state: 'blocked' });
    expect(b.state()).toBe('waiting-permission');
  });

  it('a claim of a `deny` holds `blocked` the same way', async () => {
    const b = await build();
    await b.push({ type: 'agent-state', state: 'blocked' });
    await b.card(KEY, 'pending');
    await b.card(KEY, 'sent', 'deny');
    await b.card(KEY, 'claimed', 'deny');
    await b.advance(400);
    await b.push({ type: 'agent-state', state: 'blocked' });
    expect(b.state()).toBe('running');
    await b.push({ type: 'agent-state', state: 'idle' });
    expect(b.state()).toBe('waiting-input');
  });
});

describe('consent registry: a subagent registration calls `onAccepted` with the main session', () => {
  it('scope `all`: the registration with `agentId` is accepted and `onAccepted` gets its engine session', () => {
    const accepted: string[] = [];
    const reg = createConsentRegistry({
      bootId: 'boot-claim-window', send: () => true, sessions: () => [ENGINE], log: () => {},
      onAccepted: (sessionId) => { accepted.push(sessionId); },
    });
    reg.setScope('all');
    const outcome = reg.register({
      key: KEY, sessionId: ENGINE, promptId: PROMPT, secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'),
      inputSha256: 'a'.repeat(64), cardSha256: 'b'.repeat(64), pid: process.pid, startedAt: Date.now() - 1_000,
      agentId: 'a0123456789abcdef',
    });
    expect(outcome.status).toBe(200);
    expect(accepted).toEqual([ENGINE]);
  });
});
