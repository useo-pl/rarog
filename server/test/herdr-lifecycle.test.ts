/**
 * herdr pane lifecycle (`server/src/sessions/herdr-lifecycle.ts`) through the manager, on supervisor and driver fakes.
 *
 * The tests moved here from `manager-herdr.test.ts` together with the module; the fakes are shared in
 * `helpers/manager-herdr-atrapy.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { foreign } from '@rarog/shared/sentences';
import type { DriverEvent } from '../src/drivers/types.ts';
import { GitStatusWatcher } from '../src/git-status.ts';
import type { GitRepoWatcher } from '../src/git-watch.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { HerdrManagerDeps, Manager, ManagerConfig } from '../src/sessions/manager.ts';
import { HERDR_RESTORE_MATCH_MS, HERDR_RESTORE_QUIET_MAX_MS } from '../src/sessions/state-sentences.ts';
import type { NoteInput, NotifierLike } from '../src/notify/index.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import { FakeSupervisor, PROJECT, flush, makeAgent, makeDeps } from './helpers/manager-herdr-atrapy.ts';

describe('manager — cykl życia paneli herdr', () => {
  let dataDir: string;
  const managers: Manager[] = [];
  const supervisors: FakeSupervisor[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-herdr-'));
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  function makeSupervisor(): FakeSupervisor {
    const supervisor = new FakeSupervisor();
    supervisors.push(supervisor);
    return supervisor;
  }

  async function build(
    supervisor: FakeSupervisor, deps: HerdrManagerDeps, overrides: Partial<ManagerConfig> = {},
  ): Promise<Manager> {
    const manager = await createManager({
      demo: false,
      dataDir,
      projects: [{ path: PROJECT, name: 'atlas' }],
      projectRoots: [],
      gitStatus: null,
      maxPanes: 6,
      herdrSupervisor: supervisor,
      herdrDeps: deps,
      herdrRoots: [PROJECT],
      herdrSend: true,
      ...overrides,
    });
    managers.push(manager);
    await manager.ready;
    return manager;
  }

  /*
   * Pełny restart serwera herdr (aktualizacja) zabija procesy paneli, a Rarog wraca, zanim
   * herdr odtworzy agentów — trasa zmierzona to `gone` + `appeared` (nowa karta
   * w `running`, bo `claude --resume` się ładuje). Jej pierwsze `idle` nie jest końcem tury.
   */
  describe('cisza po restarcie serwera herdr', () => {
    const spyNotes = (): { notifier: NotifierLike; notes: NoteInput[] } => {
      const notes: NoteInput[] = [];
      return {
        notes,
        notifier: {
          note: (input) => { notes.push(input); },
          seen: () => undefined,
          forget: () => undefined, quiet: () => undefined,
        },
      };
    };

    const idleNotes = (notes: NoteInput[]): NoteInput[] =>
      notes.filter((n) => n.event.type === 'agent-idle');

    /** Karta przed restartem, restart herdr, powrót tego samego uuid jako nowej karty. */
    async function restart(opts: {
      before?: HerdrAgent;
      after?: HerdrAgent;
      gapMs?: number;
    } = {}): Promise<{
      manager: Manager; supervisor: FakeSupervisor; notes: NoteInput[]; id: string;
      clock: { value: number };
    }> {
      const spy = spyNotes();
      const clock = { value: 1_000_000 };
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps(), {
        notifier: spy.notifier, now: () => clock.value,
      });
      const before = opts.before ?? makeAgent();
      // Karta „w turze" ma w chwili `gone` STAĆ w `running` — bez meldunku `idle` od atrapy.
      supervisor.autoSettle = before.status !== 'working';
      supervisor.appear(before);
      await flush();
      // Kolejność z prawdziwego resyncu po powrocie gniazda: `available`, POTEM `gone` dla
      // paneli, których herdr jeszcze nie odtworzył (supervisor: `markAvailable` przed `forget`).
      supervisor.emit({ type: 'unavailable', reason: foreign('herdr zamknął strumień') });
      await flush();
      supervisor.emit({ type: 'available' });
      supervisor.emit({ type: 'gone', key: before.key });
      await flush();
      clock.value += opts.gapMs ?? 15_000;
      // Odtworzony driver NIE melduje od razu `idle` (atrapa robi to domyślnie przy podpięciu):
      // kolejność statusów po powrocie ustawia każdy test sam, bo o nią tu chodzi.
      supervisor.autoSettle = false;
      const after = opts.after ?? makeAgent({ status: 'working' });
      supervisor.appear(after);
      await flush();
      const id = manager.list().find((s) => s.paneId === after.paneId)?.id ?? '';
      expect(id).not.toBe('');
      return { manager, supervisor, notes: spy.notes, id, clock };
    }

    it('bezczynna karta wraca po restarcie: pierwsze `idle` ciche, następna tura zwykła',
      async () => {
        const { manager, supervisor, notes, id } = await restart();
        expect(manager.get(id)?.state).toBe('running');
        const driver = supervisor.driver('w9:p72');

        driver.queue.push({ type: 'agent-state', state: 'idle' });
        await flush();
        expect(manager.get(id)?.state).toBe('waiting-input');
        expect(idleNotes(notes)).toHaveLength(1);
        expect(idleNotes(notes)[0]?.afterHerdrRestore).toBe(true);

        // Tura wpisana na Macu po odtworzeniu — jej koniec jest prawdziwy.
        driver.queue.push({ type: 'agent-state', state: 'working' });
        await flush();
        driver.queue.push({ type: 'agent-state', state: 'idle' });
        await flush();
        expect(idleNotes(notes)).toHaveLength(2);
        expect(idleNotes(notes)[1]?.afterHerdrRestore).toBeUndefined();
      });

    it('inny klucz panelu, ten sam uuid silnika — dalej odtworzenie', async () => {
      const { supervisor, notes } = await restart({
        after: makeAgent({ key: 'w9:p5', paneId: 'w9:p5', status: 'working' }),
      });
      supervisor.driver('w9:p5').queue.push({ type: 'agent-state', state: 'idle' });
      await flush();
      expect(idleNotes(notes)[0]?.afterHerdrRestore).toBe(true);
    });

    it('karta w turze w chwili `gone` NIE dostaje ciszy (fałszywy baner tańszy niż zgubiony)',
      async () => {
        const { manager, supervisor, notes } = await restart({
          before: makeAgent({ status: 'working' }),
        });
        expect(manager.list().filter((s) => s.paneId !== undefined)).toHaveLength(1);
        supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'idle' });
        await flush();
        expect(idleNotes(notes)).toHaveLength(1);
        expect(idleNotes(notes)[0]?.afterHerdrRestore).toBeUndefined();
      });

    it('nowa karta bez wcześniejszego `gone` (restart Raroga, sesja z terminala) — bez ciszy',
      async () => {
        const spy = spyNotes();
        const supervisor = makeSupervisor();
        await build(supervisor, makeDeps(), { notifier: spy.notifier });
        supervisor.autoSettle = false;
        supervisor.appear(makeAgent({ status: 'working' }));
        await flush();
        supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'idle' });
        await flush();
        expect(idleNotes(spy.notes)).toHaveLength(1);
        expect(idleNotes(spy.notes)[0]?.afterHerdrRestore).toBeUndefined();
      });

    it('powrót później niż okno dopasowania to nie odtworzenie', async () => {
      const { supervisor, notes } = await restart({ gapMs: HERDR_RESTORE_MATCH_MS + 1 });
      supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'idle' });
      await flush();
      expect(idleNotes(notes)[0]?.afterHerdrRestore).toBeUndefined();
    });

    it('znacznik jest tylko bezpiecznikiem czasu — po terminie `idle` idzie zwykłą drogą',
      async () => {
        const { supervisor, notes, clock } = await restart();
        clock.value += HERDR_RESTORE_QUIET_MAX_MS + 1;
        supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'idle' });
        await flush();
        expect(idleNotes(notes)[0]?.afterHerdrRestore).toBeUndefined();
      });

    it('wysyłka z Raroga w trakcie ładowania zdejmuje ciszę — jej koniec jest prawdziwy',
      async () => {
        const { manager, supervisor, notes, id } = await restart();
        await manager.sendMessage(id, 'zrób coś');
        await flush();
        supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'idle' });
        await flush();
        expect(idleNotes(notes).at(-1)?.afterHerdrRestore).toBeUndefined();
      });

    it('status `unknown` po odtworzeniu (karta `starting`) też dostaje ciszę', async () => {
      const { manager, supervisor, notes, id } = await restart({
        after: makeAgent({ status: 'unknown' }),
      });
      expect(manager.get(id)?.state).toBe('starting');
      supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'idle' });
      await flush();
      expect(idleNotes(notes)[0]?.afterHerdrRestore).toBe(true);
    });

    it('zamknięcie i wznowienie tego samego uuid przy ŻYWYM herdr to prawdziwa tura',
      async () => {
        const spy = spyNotes();
        const supervisor = makeSupervisor();
        await build(supervisor, makeDeps(), { notifier: spy.notifier });
        supervisor.appear(makeAgent());
        await flush();
        // Bez `unavailable`/`available`: człowiek zamknął panel i wznowił rozmowę z zadaniem.
        supervisor.emit({ type: 'gone', key: 'w9:p72' });
        await flush();
        supervisor.autoSettle = false;
        supervisor.appear(makeAgent({ status: 'working' }));
        await flush();
        supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'idle' });
        await flush();
        expect(idleNotes(spy.notes)).toHaveLength(1);
        expect(idleNotes(spy.notes)[0]?.afterHerdrRestore).toBeUndefined();
      });

    it('niezużyty znacznik nie przechodzi na INNĄ rozmowę pod tym samym kluczem',
      async () => {
        const { supervisor, notes } = await restart();
        // Odtworzona karta znika jeszcze w `running`, a w panelu wstaje inna rozmowa.
        supervisor.emit({ type: 'gone', key: 'w9:p72' });
        await flush();
        supervisor.appear(makeAgent({
          status: 'working', agentSessionId: '99999999-9999-4999-8999-999999999999',
        }));
        await flush();
        supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'idle' });
        await flush();
        expect(idleNotes(notes)).toHaveLength(1);
        expect(idleNotes(notes)[0]?.afterHerdrRestore).toBeUndefined();
      });

    it('pierwszy stan inny niż praca zużywa znacznik, także bez powiadomienia', async () => {
      const { manager, supervisor, notes, id } = await restart();
      const driver = supervisor.driver('w9:p72');
      // Dialog po odtworzeniu (np. pytanie `--resume`): klasa `blocking`, znacznik znika.
      driver.queue.push({ type: 'agent-state', state: 'blocked' });
      await flush();
      expect(manager.get(id)?.state).toBe('waiting-permission');
      driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      driver.queue.push({ type: 'agent-state', state: 'idle' });
      await flush();
      expect(idleNotes(notes)).toHaveLength(1);
      expect(idleNotes(notes)[0]?.afterHerdrRestore).toBeUndefined();
    });
  });

  /*
   * Git never runs in a macOS-protected folder of home that no root opens. `git status` and the `.git` watcher
   * (a `stat` of `<cwd>/.git` and up) would wait there for a privacy prompt nobody sees, and the server hangs. A pane
   * outside the roots elsewhere keeps its git row. Git and the watcher are fakes, so no test reads the real home.
   */
  describe('git row of a pane in a protected folder of home', () => {
    const desktop = join(homedir(), 'Desktop', 'rarog-git-probe');
    const outside = '/srv/rarog-git-probe';
    const toolCall: DriverEvent = {
      type: 'message', role: 'assistant', blocks: [{ type: 'tool-call', toolName: 'Bash', summary: 'ls' }],
    };

    async function withGit(): Promise<{
      manager: Manager; supervisor: FakeSupervisor; dirs: string[]; calls: string[]; clock: { value: number };
      change: (cwds: readonly string[]) => void;
    }> {
      const dirs: string[] = [];
      const calls: string[] = [];
      const clock = { value: 0 };
      let onChange: ((cwds: readonly string[]) => void) | null = null;
      const fake = {
        watch: (cwd: string) => { calls.push(`watch:${cwd}`); },
        unwatch: (cwd: string) => { calls.push(`unwatch:${cwd}`); },
        close: () => undefined,
      } as unknown as GitRepoWatcher;
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps(), {
        gitStatus: new GitStatusWatcher({
          run: async (cwd) => {
            dirs.push(cwd);
            return { ok: true, stdout: '# branch.head main\n' };
          },
          throttleMs: 0, now: () => clock.value,
        }),
        gitWatcher: (cb) => {
          onChange = cb;
          return fake;
        },
        now: () => clock.value,
      });
      return { manager, supervisor, dirs, calls, clock, change: (cwds) => { onChange?.(cwds); } };
    }

    it('no git status and no watcher on appearance, re-attach, a tool call, a transcript or a .git change;'
      + ' a pane outside the roots elsewhere keeps both', async () => {
      const git = await withGit();
      git.supervisor.appear(makeAgent({ cwd: desktop, inScope: false }));
      git.supervisor.appear(makeAgent({
        key: 'w9:p80', paneId: 'w9:p80', cwd: outside, inScope: false,
        agentSessionId: '22222222-2222-4222-8222-222222222222',
      }));
      await flush();
      expect(git.dirs).toEqual([outside]);
      expect(git.calls).toEqual([`watch:${outside}`]);
      const id = git.manager.list().find((s) => s.cwd === desktop)?.id ?? '';
      expect(id).not.toBe('');

      git.clock.value = 31_000;
      git.supervisor.reattach(makeAgent({ cwd: desktop, inScope: false }));
      await flush();
      git.supervisor.driver('w9:p72').queue.push(toolCall);
      await flush();
      git.clock.value = 62_000;
      git.manager.transcript(id);
      git.change([desktop]);
      await flush();
      expect(git.dirs).toEqual([outside]);
      expect(git.calls).toEqual([`watch:${outside}`]);

      // Hiding the card releases nothing it never registered.
      await git.manager.close(id);
      expect(git.calls).toEqual([`watch:${outside}`]);
    });

    it('a card replaced under the same id (cd, then a new conversation in the pane) keeps watch and unwatch paired',
      async () => {
        const git = await withGit();
        git.supervisor.appear(makeAgent({ cwd: desktop, inScope: false }));
        await flush();
        git.supervisor.emit({ type: 'gone', key: 'w9:p72' });
        await flush();
        git.supervisor.appear(makeAgent({ agentSessionId: '33333333-3333-4333-8333-333333333333' }));
        await flush();
        expect(git.calls).toEqual([`watch:${PROJECT}`]);
        git.supervisor.emit({ type: 'gone', key: 'w9:p72' });
        await flush();
        git.supervisor.appear(makeAgent({
          cwd: desktop, inScope: false, agentSessionId: '44444444-4444-4444-8444-444444444444',
        }));
        await flush();
        expect(git.calls).toEqual([`watch:${PROJECT}`, `unwatch:${PROJECT}`]);
        expect(git.dirs).toEqual([PROJECT]);
      });
  });
});
