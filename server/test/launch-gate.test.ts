/**
 * Launch gate (`server/src/sessions/launch-gate.ts`) through the manager, on supervisor and driver fakes: start options
 * of a resume taken from the conversation file and ultracode of a resume.
 *
 * The tests moved here from `manager-herdr.test.ts` together with the module; the fakes are shared in
 * `helpers/manager-herdr-atrapy.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { say } from '@rarog/shared/sentences';
import { BadRequestError, createManager } from '../src/sessions/manager.ts';
import type { HerdrManagerDeps, Manager, ManagerConfig } from '../src/sessions/manager.ts';
import { RESUME_WITHOUT_ULTRACODE_MESSAGE } from '../src/sessions/state-sentences.ts';
import type { ResumeSettings } from '../src/herdr/jsonl-pending.ts';
import type { CliVersionSnapshot } from '../src/cli-version.ts';
import {
  ENGINE_SESSION, FakeSupervisor, PROJECT, flush, makeAgent, makeDeps,
} from './helpers/manager-herdr-atrapy.ts';

describe('manager — bramka startu sesji herdr', () => {
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

  describe('wznowienie z ultracode (pytanie 3 planu: poziom rozmowy wygrywa)', () => {
    const versionReader = (installed: string | null) => (): Promise<CliVersionSnapshot> =>
      Promise.resolve({ installed, registry: null });
    const systemTexts = (manager: Manager, id: string): string[] => manager.transcript(id).messages
      .filter((m) => m.role === 'system').flatMap((m) => m.blocks)
      .flatMap((b) => (b.type === 'text' ? [b.text] : []));

    async function fromFile(
      settings: ResumeSettings, request: { model?: string; ultracode?: boolean } = {}, installed: string | null = '2.1.317',
    ): Promise<{ manager: Manager; supervisor: FakeSupervisor; id: string }> {
      const supervisor = makeSupervisor();
      const deps = makeDeps();
      deps.settingsByFile.set('/store/atlas.jsonl', settings);
      const manager = await build(supervisor, deps, { cliVersionReader: versionReader(installed) });
      await flush(8);
      const created = await manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION, ...request });
      return { manager, supervisor, id: created.sessionId };
    }

    it('plik: ostatni znacznik „on” i xhigh → `--effort ultracode` bez osobnego poziomu, karta z żądanym ultracode', async () => {
      /*
       * Granica przywracania effortu obejmuje i ten przypadek: `/effort low` wpisane przy biurku PO ostatniej
       * odpowiedzi nie stoi w pliku (wpis effortu niesie dopiero następna tura), więc plik mówi xhigh i wznowienie
       * wraca z ultracode na xhigh.
       */
      const { manager, supervisor, id } = await fromFile({ effort: 'xhigh', ultracode: true, permissionMode: 'auto' });
      expect(supervisor.launches[0]).toEqual({
        cwd: PROJECT, resumeFrom: ENGINE_SESSION, ultracode: true, permissionMode: 'auto',
      });
      expect(manager.get(id)).toMatchObject({ effort: 'xhigh', ultracode: true });
      // Sama chwila żądania, bez reguły pierwszej tury: po `--resume` z flagą pierwsza tura nie ma załącznika
      // (`wznowienie-z-flaga.jsonl`).
      expect(supervisor.driver('w0:new1').ultracodeRequests.map(({ firstTurn }) => firstTurn)).toEqual([false]);
      expect(systemTexts(manager, id)).not.toContain(RESUME_WITHOUT_ULTRACODE_MESSAGE.text);
    });

    it('plik: „on” na innym poziomie → wznowienie na tym poziomie, bez ultracode, ze zdaniem systemowym', async () => {
      const { manager, supervisor, id } = await fromFile({ effort: 'high', ultracode: true });
      expect(supervisor.launches[0]).toEqual({ cwd: PROJECT, resumeFrom: ENGINE_SESSION, effort: 'high' });
      expect('ultracode' in (manager.get(id) ?? {})).toBe(false);
      expect(systemTexts(manager, id)).toContain(RESUME_WITHOUT_ULTRACODE_MESSAGE.text);
    });

    it('plik: „on” i xhigh, ale wersja zainstalowana nieznana → `--effort xhigh` bez ultracode i zdanie', async () => {
      const { manager, supervisor, id } = await fromFile({ effort: 'xhigh', ultracode: true }, {}, null);
      expect(supervisor.launches[0]).toEqual({ cwd: PROJECT, resumeFrom: ENGINE_SESSION, effort: 'xhigh' });
      expect(systemTexts(manager, id)).toContain(RESUME_WITHOUT_ULTRACODE_MESSAGE.text);
    });

    it('plik: ostatni znacznik „off” albo brak → zwykłe wznowienie bez zdania', async () => {
      for (const settings of [{ effort: 'xhigh', ultracode: false }, { effort: 'xhigh' }] as const) {
        const { manager, supervisor, id } = await fromFile(settings);
        expect(supervisor.launches[0]).toEqual({ cwd: PROJECT, resumeFrom: ENGINE_SESSION, effort: 'xhigh' });
        expect(systemTexts(manager, id)).not.toContain(RESUME_WITHOUT_ULTRACODE_MESSAGE.text);
      }
    });

    it('żądanie z własnym modelem nie dziedziczy ultracode (ani effortu) z pliku', async () => {
      const { supervisor } = await fromFile({ effort: 'xhigh', ultracode: true }, { model: 'sonnet' });
      expect(supervisor.launches[0]).toEqual({ cwd: PROJECT, resumeFrom: ENGINE_SESSION, model: 'sonnet' });
    });

    it('żądanie wprost z ultracode nie bierze poziomu z pliku: flaga sama ustawia xhigh', async () => {
      const { manager, supervisor, id } = await fromFile({ effort: 'high' }, { ultracode: true });
      expect(supervisor.launches[0]).toEqual({ cwd: PROJECT, resumeFrom: ENGINE_SESSION, ultracode: true });
      expect(manager.get(id)).toMatchObject({ effort: 'xhigh', ultracode: true });
    });

    it('„Wznów” karty: jej ultracode wygrywa z plikiem; `false` blokuje dziedziczenie, `true` bez xhigh nie wraca', async () => {
      for (const [card, expected, sentence] of [
        [{ effort: 'xhigh', ultracode: true }, { effort: 'xhigh', ultracode: true }, false],
        [{ effort: 'medium', ultracode: true }, { effort: 'medium' }, true],
        [{ effort: 'xhigh', ultracode: false }, { effort: 'xhigh' }, false],
      ] as const) {
        const supervisor = makeSupervisor();
        const deps = makeDeps();
        deps.transcripts.set('aaaaaaaa-aaaa-4aaa-8aaa-000000000001', '/store/atlas.jsonl');
        // Plik mówi „on” na xhigh: bez wiedzy karty wznowienie by je odziedziczyło.
        deps.settingsByFile.set('/store/atlas.jsonl', { effort: 'xhigh', ultracode: true });
        let clock = 1_000_000;
        const manager = await build(supervisor, deps, { now: () => clock, cliVersionReader: versionReader('2.1.317') });
        await flush(8);
        const created = await manager.create({ cwd: PROJECT });
        supervisor.settleLaunch();
        await flush();
        supervisor.driver('w0:new1').queue.push({
          type: 'init', engineSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', model: 'claude-opus-5-5', ...card,
        });
        await flush();
        supervisor.emit({ type: 'gone', key: 'w0:new1' });
        await flush();
        clock += 60_000;

        await manager.resume(created.sessionId);

        expect(supervisor.launches[1], JSON.stringify(card)).toEqual({
          cwd: PROJECT, resumeFrom: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', ...expected,
        });
        expect(systemTexts(manager, created.sessionId).includes(RESUME_WITHOUT_ULTRACODE_MESSAGE.text)).toBe(sentence);
      }
    });
  });

  /*
   * `--resume` przywraca model sam, ale tryb Manual zamienia na `defaultMode` z ustawień,
   * a rozwidlenie gubi plan. Rarog podaje więc tryb i effort z pliku rozmowy — modelu nigdy.
   */
  describe('wznowienie na ustawieniach rozmowy', () => {
    it('effort i tryb z pliku idą do argv, model NIE — model zasiewa tylko kartę', async () => {
      const supervisor = makeSupervisor();
      const deps = makeDeps();
      deps.settingsByFile.set('/store/atlas.jsonl', {
        model: 'claude-opus-4-7', effort: 'high', permissionMode: 'default',
      });
      const manager = await build(supervisor, deps, { accountDefaultModel: () => 'claude-fable-5' });

      const created = await manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION });

      expect(supervisor.launches[0]).toEqual({
        cwd: PROJECT, resumeFrom: ENGINE_SESSION, effort: 'high', permissionMode: 'manual',
      });
      // Model wraca z rozmowy, nie z konta: wznowiona sesja zostaje przy swoim modelu (docs `sessions.md`,
      // „What a resumed session restores”).
      expect(manager.get(created.sessionId)?.model).toBe('claude-opus-4-7');
    });

    it('rozwidlenie rozmowy w planie wstaje w planie', async () => {
      const supervisor = makeSupervisor();
      const deps = makeDeps();
      deps.settingsByFile.set('/store/atlas.jsonl', { permissionMode: 'plan' });
      supervisor.liveEngines = new Set([ENGINE_SESSION]);
      const manager = await build(supervisor, deps);

      await manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION, fork: true });

      expect(supervisor.launches[0]).toEqual({
        cwd: PROJECT, resumeFrom: ENGINE_SESSION, fork: true, permissionMode: 'plan',
      });
    });

    it('acceptEdits zostaje acceptEdits (nie zwija się do auto jak chip)', async () => {
      const supervisor = makeSupervisor();
      const deps = makeDeps();
      deps.settingsByFile.set('/store/atlas.jsonl', { permissionMode: 'acceptEdits' });
      const manager = await build(supervisor, deps);

      await manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION });

      expect(supervisor.launches[0]?.permissionMode).toBe('acceptEdits');
    });

    it('bypassPermissions, dontAsk i nieznany tryb z pliku dają JAWNE manual, nie pustą flagę', async () => {
      // Pusta flaga oddałaby tryb ustawieniom CLI, a `defaultMode` bywa tam `bypassPermissions`.
      // A raw `manual` from the file must not loosen to a mode that asks less.
      for (const mode of ['bypassPermissions', 'dontAsk', 'cośNowego', 'manual']) {
        const supervisor = makeSupervisor();
        const deps = makeDeps();
        deps.settingsByFile.set('/store/atlas.jsonl', { permissionMode: mode, effort: 'low' });
        const manager = await build(supervisor, deps);

        await manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION });

        expect(supervisor.launches[0]).toEqual({
          cwd: PROJECT, resumeFrom: ENGINE_SESSION, effort: 'low', permissionMode: 'manual',
        });
      }
    });

    it('plik bez trybu = bez flagi trybu', async () => {
      const supervisor = makeSupervisor();
      const deps = makeDeps();
      deps.settingsByFile.set('/store/atlas.jsonl', { effort: 'max' });
      const manager = await build(supervisor, deps);

      await manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION });

      expect(supervisor.launches[0]).toEqual({ cwd: PROJECT, resumeFrom: ENGINE_SESSION, effort: 'max' });
    });

    it('żądanie z własnym modelem nie dziedziczy effortu z pliku', async () => {
      const supervisor = makeSupervisor();
      const deps = makeDeps();
      deps.settingsByFile.set('/store/atlas.jsonl', { effort: 'xhigh', permissionMode: 'auto' });
      const manager = await build(supervisor, deps);

      await manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION, model: 'haiku' });

      expect(supervisor.launches[0]).toEqual({
        cwd: PROJECT, resumeFrom: ENGINE_SESSION, model: 'haiku', permissionMode: 'auto',
      });
    });

    it('pole z żądania wygrywa z plikiem', async () => {
      const supervisor = makeSupervisor();
      const deps = makeDeps();
      deps.settingsByFile.set('/store/atlas.jsonl', { effort: 'high', permissionMode: 'default' });
      const manager = await build(supervisor, deps);

      await manager.create({
        cwd: PROJECT, resumeFrom: ENGINE_SESSION, permissionMode: 'plan', effort: 'low',
      });

      expect(supervisor.launches[0]).toMatchObject({ permissionMode: 'plan', effort: 'low' });
    });

    it('plik spoza katalogu odbija jak dotąd — ustawień nikt nie czyta', async () => {
      const supervisor = makeSupervisor();
      const deps = makeDeps();
      deps.cwdByFile.set('/store/atlas.jsonl', '/Users/u/Projects/cudze');
      const read: string[] = [];
      const source = deps.resumeSource;
      const manager = await build(supervisor, {
        ...deps,
        resumeSource: source === undefined ? undefined : {
          ...source,
          settingsOf: (file) => { read.push(file); return Promise.resolve({}); },
        },
      });

      await expect(manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION }))
        .rejects.toBeInstanceOf(BadRequestError);
      expect(read).toEqual([]);
      expect(supervisor.launches).toHaveLength(0);
    });

    it('błąd odczytu ustawień odbija wznowienie, zanim powstanie panel', async () => {
      // Bez odczytu nie wiadomo, czy potrzebna jest flaga trybu — a jej brak oddaje tryb CLI.
      const supervisor = makeSupervisor();
      const deps = makeDeps();
      const source = deps.resumeSource;
      const manager = await build(supervisor, {
        ...deps,
        resumeSource: source === undefined ? undefined : {
          ...source,
          settingsOf: () => Promise.reject(new BadRequestError(say('session.resume-unreadable'))),
        },
      });

      await expect(manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION }))
        .rejects.toBeInstanceOf(BadRequestError);
      expect(supervisor.launches).toHaveLength(0);
    });

    it('nazwy z prototypu obiektu (constructor, toString, __proto__) też dają jawne manual', async () => {
      for (const mode of ['constructor', 'toString', '__proto__']) {
        const supervisor = makeSupervisor();
        const deps = makeDeps();
        deps.settingsByFile.set('/store/atlas.jsonl', { permissionMode: mode });
        const manager = await build(supervisor, deps);

        await manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION });

        expect(supervisor.launches[0]).toEqual({ cwd: PROJECT, resumeFrom: ENGINE_SESSION, permissionMode: 'manual' });
      }
    });

    it('wznowienie KARTY bierze tryb z pliku, a nie zapamiętany przy jej starcie; modelu nie podaje', async () => {
      // Karta wstała w auto, człowiek przełączył panel na plan i zamknął go: plik mówi „plan”.
      const supervisor = makeSupervisor();
      const deps = makeDeps();
      deps.transcripts.set('aaaaaaaa-aaaa-4aaa-8aaa-000000000001', '/store/atlas.jsonl');
      let clock = 1_000_000;
      const manager = await build(supervisor, deps, { now: () => clock });
      const created = await manager.create({ cwd: PROJECT, permissionMode: 'auto', model: 'opus[1m]' });
      supervisor.settleLaunch();
      await flush();
      supervisor.emit({ type: 'gone', key: 'w0:new1' });
      await flush();
      deps.settingsByFile.set('/store/atlas.jsonl', { permissionMode: 'plan', model: 'claude-opus-4-7' });
      clock += 60_000; // throttle startów: jeden na kilka sekund

      await manager.resume(created.sessionId);

      expect(supervisor.launches[1]).toMatchObject({ resumeFrom: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', permissionMode: 'plan' });
      expect(supervisor.launches[1]).not.toHaveProperty('model');
    });

    it('wznowienie karty: plik bez trybu → tryb karty jako zapas; bypass z yolo idzie jawnie mimo pliku', async () => {
      for (const [start, fromFile, expected] of [
        ['plan', {}, 'plan'],
        ['bypassPermissions', { permissionMode: 'auto' }, 'bypassPermissions'],
      ] as const) {
        const supervisor = makeSupervisor();
        const deps = makeDeps();
        deps.transcripts.set('aaaaaaaa-aaaa-4aaa-8aaa-000000000001', '/store/atlas.jsonl');
        let clock = 1_000_000;
        const manager = await build(supervisor, deps, {
          now: () => clock, yoloRoots: [PROJECT], realPath: (path: string) => path,
        });
        const created = await manager.create({ cwd: PROJECT, permissionMode: start });
        supervisor.settleLaunch();
        await flush();
        supervisor.emit({ type: 'gone', key: 'w0:new1' });
        await flush();
        deps.settingsByFile.set('/store/atlas.jsonl', fromFile);
        clock += 60_000;

        await manager.resume(created.sessionId);

        expect(supervisor.launches[1]?.permissionMode).toBe(expected);
      }
    });

    it('lista „Wznów istniejącą” podaje kartę żywej rozmowy (cel „przejdź”)', async () => {
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps(), {
        resumableReader: async () => [
          {
            engineSessionId: ENGINE_SESSION, cwd: PROJECT, mtime: '2026-10-13T10:00:00.000Z',
            firstPrompt: 'żywa', liveInHerdr: false,
          },
          {
            engineSessionId: 'zamknieta', cwd: PROJECT, mtime: '2026-10-12T10:00:00.000Z',
            firstPrompt: 'zamknięta', liveInHerdr: false,
          },
        ],
      });
      supervisor.appear(makeAgent());
      await flush();
      const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';

      const list = await manager.resumable(PROJECT);

      expect(list.find((item) => item.engineSessionId === ENGINE_SESSION)?.sessionId).toBe(id);
      expect(list.find((item) => item.engineSessionId === 'zamknieta')).not.toHaveProperty('sessionId');
    });
  });
});
