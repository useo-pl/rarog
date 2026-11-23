/**
 * Voice agent on the session manager's side (`server/src/sessions/companion-scope.ts`): the scope gate shared
 * with the commands list, the session the agent may ask about and the listeners of engine conversation changes.
 * The same rules through a live manager: `manager-companion-target.test.ts`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConversationListeners, companionTargetOf, inCommandScope, sessionCwdInArea,
} from '../src/sessions/companion-scope.ts';
import { Session } from '../src/sessions/session.ts';
import type { SessionInit } from '../src/sessions/session.ts';

const ROOTS = ['/Users/x/Projects'];
const AT = new Date(1_756_000_000_000).toISOString();

function session(extra: Partial<SessionInit> = {}): Session {
  return new Session({
    id: 's1', cwd: '/Users/x/Projects/rarog', title: 'rarog', state: 'running', stateSince: AT, createdAt: AT,
    lastActivityAt: AT, ...extra,
  });
}

describe('companion-scope: zasięg listy komend i agenta głosowego', () => {
  const real = { demo: false, herdrRoots: ROOTS };

  it('panel herdr pod korzeniem → w zasięgu; cel to katalog i bieżąca rozmowa silnika', () => {
    const one = session({ herdrKey: 'k1', engineSessionId: '11111111-1111-4111-8111-111111111111' });
    expect(inCommandScope(one, real)).toBe(true);
    expect(companionTargetOf(one, real)).toEqual({
      cwd: '/Users/x/Projects/rarog', agentSessionId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('przed pierwszą rozmową silnika cel nie ma rozmowy', () => {
    expect(companionTargetOf(session({ herdrKey: 'k1' }), real)).toEqual({
      cwd: '/Users/x/Projects/rarog', agentSessionId: undefined,
    });
  });

  it('Codex, panel poza zasięgiem i katalog sesji poza korzeniami → poza zasięgiem, bez celu', () => {
    const outside = [
      session({ herdrKey: 'k1', engine: 'codex' }),
      session({ herdrKey: 'k1', outOfScope: true }),
      session({ herdrKey: 'k1', cwd: '/Users/x/elsewhere' }),
    ];
    for (const one of outside) {
      expect(inCommandScope(one, real)).toBe(false);
      expect(companionTargetOf(one, real)).toBeNull();
    }
  });

  it('karta bez panelu i tryb demo nie sprawdzają korzeni', () => {
    expect(inCommandScope(session({ cwd: '/Users/x/elsewhere' }), real)).toBe(true);
    expect(inCommandScope(session({ herdrKey: 'k1', cwd: '/Users/x/elsewhere' }), { demo: true })).toBe(true);
  });

  it('with the root ~: a hidden entry of home and a protected folder are out, the rest of home is in', () => {
    const home = { demo: false, herdrRoots: ['/Users/x'], home: '/Users/x' };
    for (const cwd of ['/Users/x/.cache/x', '/Users/x/Desktop/x', '/Users/x/Library/x']) {
      expect(inCommandScope(session({ herdrKey: 'k1', cwd }), home), cwd).toBe(false);
      expect(sessionCwdInArea(session({ herdrKey: 'k1', cwd }), home), cwd).toBe(false);
    }
    expect(inCommandScope(session({ herdrKey: 'k1', cwd: '/Users/x/inne/x' }), home)).toBe(true);
    expect(sessionCwdInArea(session({ herdrKey: 'k1', cwd: '/Users/x/inne/x' }), home)).toBe(true);
    // A card without a pane is in scope with its directory, as before.
    expect(sessionCwdInArea(session({ cwd: '/Users/x/Desktop/x' }), home)).toBe(true);
  });
});

/*
 * The directory as written was the whole check, so a pane in `~/inne/link -> ~/Desktop/x` or under a root that is a
 * symlink to home (`<root>/Desktop/x`) had the diff, the command list and the voice agent.
 */
describe('companion-scope: the work area on disk', () => {
  let base = '';
  let home = '';
  let dom = '';

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'rarog-companion-scope-')));
    home = join(base, 'home');
    dom = join(base, 'dom');
    for (const dir of ['inne/x', 'Desktop/x']) mkdirSync(join(home, dir), { recursive: true });
    symlinkSync(join(home, 'Desktop', 'x'), join(home, 'inne', 'link'));
    symlinkSync(home, dom);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('a symlink into ~/Desktop: no diff, no command list, no voice agent', () => {
    const config = { demo: false, herdrRoots: [home], home };
    const one = session({ herdrKey: 'k1', cwd: join(home, 'inne', 'link') });
    expect(sessionCwdInArea(one, config)).toBe(false);
    expect(inCommandScope(one, config)).toBe(false);
    expect(companionTargetOf(one, config)).toBeNull();
    expect(sessionCwdInArea(session({ herdrKey: 'k1', cwd: join(home, 'inne', 'x') }), config)).toBe(true);
  });

  it('a root that is a symlink to home: its Desktop is out, the rest of home is in', () => {
    const config = { demo: false, herdrRoots: [dom], home };
    const desktop = session({ herdrKey: 'k1', cwd: join(dom, 'Desktop', 'x') });
    expect(sessionCwdInArea(desktop, config)).toBe(false);
    expect(companionTargetOf(desktop, config)).toBeNull();
    const inne = session({ herdrKey: 'k1', cwd: join(dom, 'inne', 'x') });
    expect(companionTargetOf(inne, config)).toEqual({ cwd: join(dom, 'inne', 'x'), agentSessionId: undefined });
  });
});

describe('companion-scope: słuchacze zmiany rozmowy', () => {
  it('każdy słuchacz dostaje sesję i nową rozmowę; odpięty milczy', () => {
    const listeners = new ConversationListeners(() => {});
    const heard: string[] = [];
    const detach = listeners.add((id, conversation) => { heard.push(`a ${id} ${conversation}`); });
    listeners.add((id, conversation) => { heard.push(`b ${id} ${conversation}`); });
    listeners.notify('s1', 'c2');
    detach();
    listeners.notify('s1', 'c3');
    expect(heard).toEqual(['a s1 c2', 'b s1 c2', 'b s1 c3']);
  });

  it('wyjątek słuchacza idzie do logu i nie zatrzymuje pozostałych', () => {
    const log: string[] = [];
    const listeners = new ConversationListeners((line) => { log.push(line); });
    const heard: string[] = [];
    listeners.add(() => { throw new Error('boom'); });
    listeners.add((id) => { heard.push(id); });
    listeners.notify('s1', 'c2');
    expect(heard).toEqual(['s1']);
    expect(log).toEqual(['conversation listener failed: boom']);
  });
});
