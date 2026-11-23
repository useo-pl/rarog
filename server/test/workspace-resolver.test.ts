/**
 * Workspace projektu — resolver, zamek projektu i ich styk
 * z launcherem agentów oraz backendem terminala.
 *
 * Choosing the first panel with the same `cwd` lands sessions in a foreign workspace, because `cwd`
 * drifts with every `cd`. Cases here: `cd` of a foreign
 * panel, znane błędne położenie (fjord-ios w „fleet-ops"), dwa projekty o tej samej
 * nazwie, wielkość liter, dowiązanie, worktree i pierwsze równoczesne założenie.
 */
import {
  existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createHerdrLauncher } from '../src/herdr/launcher.ts';
import {
  createProjectPlacement, decideProjectWorkspace,
} from '../src/herdr/project-workspace.ts';
import { HERDR_NAME_PREFIX, claudePaneLabel, labelTrace, projectKey, termPaneLabel } from '../src/herdr/provenance.ts';
import type { HerdrPaneInfo, HerdrWorkspaceInfo } from '../src/herdr/types.ts';
import {
  isWithin, newProjectWorkspaceLabel, resolveProjectWorkspace, scoreProjectWorkspaces,
} from '../src/herdr/workspace-resolver.ts';
import type { ResolverPane } from '../src/herdr/workspace-resolver.ts';
import { RAROG_TERM_TOKEN, TERM_HERDR_STATE_FILENAME, createHerdrBackend } from '../src/term/herdr-backend.ts';
import { termIdFor } from '../src/term/lifecycle.ts';
import { TermRegistry } from '../src/term/registry.ts';
import { FakeHerdr } from './fake-term-herdr.ts';

const ACME_API = '/Users/u/Projects/ACME/api';
const ATLAS_API = '/Users/u/Projects/Atlas/api';
const GROVE = '/Users/u/Projects/Atlas/grove';
const FJORD = '/Users/u/Projects/fjord-ios';

let paneSeq = 0;
function pane(workspaceId: string, cwd: string, label: string | null = null): ResolverPane {
  paneSeq += 1;
  return { paneId: `${workspaceId}:p${String(paneSeq)}`, workspaceId, cwd, label };
}

/** Etykieta panelu Claude założonego przez Raroga w katalogu `dir`. */
const claudeOf = (dir: string): string => claudePaneLabel(projectKey(dir), labelTrace('x'));

describe('resolveProjectWorkspace — kandydat i dowód ścieżki', () => {
  it('`cd` obcego panelu nie wybiera workspace\'u: „atlas" nie jest kandydatem grove', () => {
    const workspaces = [{ workspaceId: 'w9', label: 'atlas' }];
    const panes = [pane('w9', '/Users/u/Projects/Atlas'), pane('w9', GROVE)];
    expect(resolveProjectWorkspace({ workspaces, panes, realCwd: GROVE })).toBeNull();
    expect(newProjectWorkspaceLabel(workspaces, GROVE)).toBe('grove');
  });

  it('`cd` obcego panelu w workspace\'ie innego `api` — dowód przeciw bije sam `cwd`', () => {
    // Workspace „api" jest kandydatem po nazwie, panel człowieka zrobił w nim `cd` do Atlas/api
    // (słaby dowód za), ale stoi tam sesja Raroga ACME/api (dowód przeciw).
    const workspaces = [{ workspaceId: 'wA', label: 'api' }];
    const panes = [pane('wA', ACME_API, claudeOf(ACME_API)), pane('wA', ATLAS_API)];
    expect(scoreProjectWorkspaces({ workspaces, panes, realCwd: ATLAS_API })).toEqual([
      { workspaceId: 'wA', checkout: false, strong: 0, weak: 1, against: 1 },
    ]);
    expect(resolveProjectWorkspace({ workspaces, panes, realCwd: ATLAS_API })).toBeNull();
    // Dla ACME/api ten sam workspace jest właściwy — własna etykieta to dowód mocny.
    expect(resolveProjectWorkspace({ workspaces, panes, realCwd: ACME_API }))
      .toEqual({ workspaceId: 'wA', via: 'evidence' });
  });

  it('zmigrowany panel fjord-ios w „fleet-ops" nie ściąga tam nowej sesji', () => {
    const workspaces = [{ workspaceId: 'wJ', label: 'fleet-ops' }];
    const panes = [pane('wJ', '/Users/u/Projects/fleet-ops'), pane('wJ', FJORD, claudeOf(FJORD))];
    expect(resolveProjectWorkspace({ workspaces, panes, realCwd: FJORD })).toBeNull();
    expect(newProjectWorkspaceLabel(workspaces, FJORD)).toBe('fjord-ios');
    // A „fleet-ops" dla własnego projektu dalej działa: cudzy panel Raroga go nie odbiera.
    expect(resolveProjectWorkspace({ workspaces, panes, realCwd: '/Users/u/Projects/fleet-ops' }))
      .toEqual({ workspaceId: 'wJ', via: 'evidence' });
  });

  it('dwa projekty `api` w różnych korzeniach → osobne workspace\'y, drugi `api (Atlas)`', () => {
    const before = [{ workspaceId: 'wA', label: 'api' }];
    const panesBefore = [pane('wA', ACME_API, claudeOf(ACME_API))];
    expect(resolveProjectWorkspace({ workspaces: before, panes: panesBefore, realCwd: ATLAS_API }))
      .toBeNull();
    expect(newProjectWorkspaceLabel(before, ATLAS_API)).toBe('api (Atlas)');

    // Po założeniu: każdy projekt znajduje SWÓJ, także drugi po nazwie z kolizji.
    const after = [...before, { workspaceId: 'wB', label: 'api (Atlas)' }];
    const panesAfter = [...panesBefore, pane('wB', ATLAS_API, claudeOf(ATLAS_API))];
    expect(resolveProjectWorkspace({ workspaces: after, panes: panesAfter, realCwd: ATLAS_API }))
      .toEqual({ workspaceId: 'wB', via: 'evidence' });
    expect(resolveProjectWorkspace({ workspaces: after, panes: panesAfter, realCwd: ACME_API }))
      .toEqual({ workspaceId: 'wA', via: 'evidence' });
  });

  it('jedyny workspace „api" bez dowodu dla drugiego `api` → nowy', () => {
    const workspaces = [{ workspaceId: 'wA', label: 'api' }];
    expect(resolveProjectWorkspace({ workspaces, panes: [], realCwd: ATLAS_API })).toBeNull();
    expect(resolveProjectWorkspace({
      workspaces, panes: [pane('wA', '/Users/u/Projects/inne')], realCwd: ATLAS_API,
    })).toBeNull();
    expect(newProjectWorkspaceLabel(workspaces, ATLAS_API)).toBe('api (Atlas)');
  });

  it('wielkość liter: etykieta „API" jest kandydatem `api`, „API (atlas)" — nazwą z kolizji', () => {
    const panes = [pane('wA', ATLAS_API)];
    expect(resolveProjectWorkspace({
      workspaces: [{ workspaceId: 'wA', label: 'API' }], panes, realCwd: ATLAS_API,
    })).toEqual({ workspaceId: 'wA', via: 'evidence' });
    expect(resolveProjectWorkspace({
      workspaces: [{ workspaceId: 'wA', label: 'API (atlas)' }], panes, realCwd: ATLAS_API,
    })).toEqual({ workspaceId: 'wA', via: 'evidence' });
    expect(newProjectWorkspaceLabel([{ workspaceId: 'w1', label: 'Api' }], ATLAS_API))
      .toBe('api (Atlas)');
  });

  it('worktree: workspace ze ścieżką checkoutu wygrywa, choć nazywa się inaczej', () => {
    const tree = '/Users/u/Projects/rarog/.claude/worktrees/taby';
    const workspaces: HerdrWorkspaceInfo[] = [
      { workspaceId: 'wQ', label: 'rarog', checkoutPath: '/Users/u/Projects/rarog',
        repoRoot: '/Users/u/Projects/rarog' },
      { workspaceId: 'wT', label: 'feat/taby', checkoutPath: tree, repoRoot: '/Users/u/Projects/rarog' },
    ];
    expect(resolveProjectWorkspace({ workspaces, panes: [], realCwd: tree }))
      .toEqual({ workspaceId: 'wT', via: 'checkout' });
  });

  it('worktree: workspace dowiązanego worktree NIE jest kandydatem repo głównego', () => {
    // `repoRoot` worktree to repo główne, a jego panele leżą W repo (`.claude/worktrees/…`) —
    // gdyby był kandydatem, sesje repo głównego lądowałyby w workspace'ie gałęzi.
    const repo = '/Users/u/Projects/rarog';
    const tree = `${repo}/.claude/worktrees/taby`;
    const workspaces: HerdrWorkspaceInfo[] = [
      { workspaceId: 'wT', label: 'rarog', checkoutPath: tree, repoRoot: repo },
    ];
    expect(resolveProjectWorkspace({ workspaces, panes: [pane('wT', tree)], realCwd: repo })).toBeNull();
  });

  it('panel Raroga z `cd` do cudzego projektu nie jest dowodem — mówi wyłącznie etykieta', () => {
    // Terminal ACME/api zrobił `cd` do Atlas/api: etykieta jest innej ścieżki, a jej katalogu
    // nie da się odtworzyć z bieżącego `cwd` (neutralny — ani za, ani przeciw).
    const id = termIdFor(ACME_API);
    const workspaces = [{ workspaceId: 'wA', label: 'api' }];
    const panes = [pane('wA', ATLAS_API, termPaneLabel(id))];
    expect(scoreProjectWorkspaces({ workspaces, panes, realCwd: ATLAS_API })).toEqual([
      { workspaceId: 'wA', checkout: false, strong: 0, weak: 0, against: 0 },
    ]);
    expect(resolveProjectWorkspace({ workspaces, panes, realCwd: ATLAS_API })).toBeNull();
  });

  it('etykieta terminala tej ścieżki to dowód mocny także po `cd` poza projekt (slot 2 do slotu 1)', () => {
    const workspaces = [{ workspaceId: 'w5', label: 'api' }];
    const panes = [pane('w5', '/tmp', termPaneLabel(termIdFor(ATLAS_API, 1)))];
    expect(resolveProjectWorkspace({ workspaces, panes, realCwd: ATLAS_API }))
      .toEqual({ workspaceId: 'w5', via: 'evidence' });
  });

  it('etykiety `rarog-claude` i `rarog-term` tej ścieżki to dowody mocne', () => {
    const workspaces = [{ workspaceId: 'w5', label: 'api' }];
    const panes = [
      pane('w5', '/tmp', `${HERDR_NAME_PREFIX}-term ${termIdFor(ATLAS_API, 1)}`),
      pane('w5', '/tmp', `${HERDR_NAME_PREFIX}-claude ${projectKey(ATLAS_API)} ${labelTrace('x')}`),
    ];
    expect(scoreProjectWorkspaces({ workspaces, panes, realCwd: ATLAS_API })[0]?.strong).toBe(2);
    expect(resolveProjectWorkspace({ workspaces, panes, realCwd: ATLAS_API }))
      .toEqual({ workspaceId: 'w5', via: 'evidence' });
  });

  it('etykieta Raroga podkatalogu projektu (sesja w `api/web`) to dowód za', () => {
    const web = `${ATLAS_API}/web`;
    const workspaces = [{ workspaceId: 'wB', label: 'api' }];
    const panes = [pane('wB', web, claudeOf(web))];
    expect(scoreProjectWorkspaces({ workspaces, panes, realCwd: ATLAS_API })[0]?.strong).toBe(1);
  });

  it('kilku kandydatów: wygrywa ten z największą liczbą dowodów, remis = brak wyboru', () => {
    const workspaces = [{ workspaceId: 'w1', label: 'api' }, { workspaceId: 'w2', label: 'api' }];
    const two = [pane('w1', ATLAS_API), pane('w1', ATLAS_API), pane('w2', ATLAS_API)];
    expect(resolveProjectWorkspace({ workspaces, panes: two, realCwd: ATLAS_API }))
      .toEqual({ workspaceId: 'w1', via: 'evidence' });
    const tie = [pane('w1', ATLAS_API), pane('w2', ATLAS_API)];
    expect(resolveProjectWorkspace({ workspaces, panes: tie, realCwd: ATLAS_API })).toBeNull();
  });

  it('pamięć „założyłem" liczy się jak dowód mocny, ale tylko u kandydata', () => {
    const createdHere = ['wZ', 'wX'];
    expect(resolveProjectWorkspace({
      workspaces: [{ workspaceId: 'wZ', label: 'api' }], panes: [], realCwd: ATLAS_API, createdHere,
    })).toEqual({ workspaceId: 'wZ', via: 'evidence' });
    // Przemianowany przez człowieka — kandydatem już nie jest, pamięć go nie wskrzesza.
    expect(resolveProjectWorkspace({
      workspaces: [{ workspaceId: 'wX', label: 'moje' }], panes: [], realCwd: ATLAS_API, createdHere,
    })).toBeNull();
  });

  it('`isWithin` patrzy na separator: `api2` nie leży w `api`', () => {
    expect(isWithin('/a/api', '/a/api')).toBe(true);
    expect(isWithin('/a/api/src', '/a/api')).toBe(true);
    expect(isWithin('/a/api2', '/a/api')).toBe(false);
    expect(isWithin('/a', '/')).toBe(true);
  });
});

/*
 * Tie among duplicate workspaces: counting "I created it" as just one point would give a newly created
 * workspace as much evidence as the old ones (2:2:2), so every next start would create ANOTHER
 * `rarog (ACME)`. Przy remisie rozstrzyga ostatni workspace założony dla
 * projektu przez ten proces, o ile nadal jest kandydatem z dowodem.
 */
describe('resolveProjectWorkspace — remis rozstrzyga ostatni workspace założony przez proces', () => {
  const RAROG = '/Users/u/Projects/ACME/rarog';
  const OLD: HerdrWorkspaceInfo[] = [
    { workspaceId: 'w1', label: 'rarog' }, { workspaceId: 'w2', label: 'rarog' },
  ];
  const oldPanes = (): ResolverPane[] => [
    pane('w1', RAROG), pane('w1', RAROG), pane('w2', RAROG), pane('w2', RAROG),
  ];

  it('nowy workspace z panelem remisuje ze starymi (2:2:2) — wygrywa on, nie brak wyboru', () => {
    const workspaces = [...OLD, { workspaceId: 'w3', label: 'rarog (ACME)' }];
    const panes = [...oldPanes(), pane('w3', RAROG)];
    expect(resolveProjectWorkspace({ workspaces, panes, realCwd: RAROG, createdHere: ['w3'] }))
      .toEqual({ workspaceId: 'w3', via: 'evidence' });
  });

  it('nowy workspace, którego panelu herdr jeszcze nie pokazał (1 dowód), też rozstrzyga remis 2:2', () => {
    const workspaces = [...OLD, { workspaceId: 'w3', label: 'rarog (ACME)' }];
    expect(resolveProjectWorkspace({
      workspaces, panes: oldPanes(), realCwd: RAROG, createdHere: ['w3'],
    })).toEqual({ workspaceId: 'w3', via: 'evidence' });
  });

  it('wyraźny lider wygrywa z pamięcią; przemianowany workspace z pamięci remisu nie rozstrzyga', () => {
    const workspaces = [...OLD, { workspaceId: 'w3', label: 'rarog (ACME)' }];
    const panes = [...oldPanes(), pane('w1', RAROG)];
    expect(resolveProjectWorkspace({ workspaces, panes, realCwd: RAROG, createdHere: ['w3'] }))
      .toEqual({ workspaceId: 'w1', via: 'evidence' });
    const renamed = [...OLD, { workspaceId: 'w3', label: 'moje' }];
    expect(resolveProjectWorkspace({
      workspaces: renamed, panes: oldPanes(), realCwd: RAROG, createdHere: ['w3'],
    })).toBeNull();
  });

  it('kilka założonych — rozstrzyga NAJNOWSZY, który nadal jest kandydatem', () => {
    const workspaces = [
      ...OLD, { workspaceId: 'w3', label: 'rarog (ACME)' }, { workspaceId: 'w4', label: 'inne' },
    ];
    expect(resolveProjectWorkspace({
      workspaces, panes: oldPanes(), realCwd: RAROG, createdHere: ['w3', 'w4'],
    })).toEqual({ workspaceId: 'w3', via: 'evidence' });
  });
});

// ---------------------------------------------------------------------------
// `realpath` przed resolverem — prawdziwe dowiązanie na dysku
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() ?? '', { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function herdrPane(paneId: string, workspaceId: string, cwd: string): HerdrPaneInfo {
  return { paneId, tabId: `${paneId}t`, workspaceId, cwd, tokens: {}, label: null };
}

describe('decideProjectWorkspace — `realpath` ścieżek z herdr', () => {
  it('symlink: panel i checkout zgłoszone przez dowiązanie wskazują ten sam projekt', async () => {
    const root = tempDir('rarog-ws-resolver-');
    mkdirSync(join(root, 'real', 'api'), { recursive: true });
    symlinkSync(join(root, 'real'), join(root, 'link'));
    const realCwd = realpathSync(join(root, 'real', 'api'));

    const viaPane = await decideProjectWorkspace({
      client: {
        listWorkspaces: async () => [{ workspaceId: 'wA', label: 'api' }],
        listPanes: async () => [herdrPane('wA:p1', 'wA', join(root, 'link', 'api'))],
      },
      realCwd, placement: createProjectPlacement(),
    });
    expect(viaPane).toEqual({ kind: 'existing', workspaceId: 'wA', via: 'evidence' });

    const viaCheckout = await decideProjectWorkspace({
      client: {
        listWorkspaces: async () => [
          { workspaceId: 'wT', label: 'gałąź', checkoutPath: join(root, 'link', 'api') },
        ],
        listPanes: async () => [],
      },
      realCwd, placement: createProjectPlacement(),
    });
    expect(viaCheckout).toEqual({ kind: 'existing', workspaceId: 'wT', via: 'checkout' });
  });

  it('brak wyboru → etykieta nowego workspace\'u; przy kolizji nazwy — z katalogiem nadrzędnym', async () => {
    const decision = await decideProjectWorkspace({
      client: {
        listWorkspaces: async () => [{ workspaceId: 'wA', label: 'api' }],
        listPanes: async () => [],
      },
      realCwd: ATLAS_API, placement: createProjectPlacement(),
    });
    expect(decision).toEqual({ kind: 'new', label: 'api (Atlas)' });
  });

  it('`panes` podane przez wołającego — bez drugiego `pane.list`', async () => {
    let listed = 0;
    await decideProjectWorkspace({
      client: {
        listWorkspaces: async () => [],
        listPanes: async () => { listed += 1; return []; },
      },
      realCwd: ATLAS_API, placement: createProjectPlacement(), panes: [],
    });
    expect(listed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Zamek projektu
// ---------------------------------------------------------------------------

describe('withProjectLock — jeden katalog naraz, różne katalogi bez czekania', () => {
  it('zadania jednego katalogu idą jedno po drugim; inny katalog nie czeka', async () => {
    const placement = createProjectPlacement();
    const events: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const first = placement.withProjectLock('/p/a', async () => {
      events.push('a1:start');
      await gate;
      events.push('a1:end');
    });
    const second = placement.withProjectLock('/p/a', async () => { events.push('a2'); });
    const other = placement.withProjectLock('/p/b', async () => { events.push('b'); });

    await other;
    expect(events).toEqual(['a1:start', 'b']);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['a1:start', 'b', 'a1:end', 'a2']);
  });

  it('zadanie, które rzuca, zwalnia zamek — błąd wraca do wołającego', async () => {
    const placement = createProjectPlacement();
    await expect(placement.withProjectLock('/p/a', async () => { throw new Error('padło'); }))
      .rejects.toThrow('padło');
    await expect(placement.withProjectLock('/p/a', async () => 'dalej')).resolves.toBe('dalej');
  });
});

// ---------------------------------------------------------------------------
// Claude + terminal tego samego projektu naraz → jeden workspace
// ---------------------------------------------------------------------------

/**
 * Wspólna atrapa herdr dla launchera i terminala: agent wstaje od razu, zakładanie liczone.
 *
 * Zakładanie trwa (`CREATE_MS`), jak w herdr — bez tego obie strony rozstrzygały się w jednej
 * turze mikrozadań i test przechodziłby także BEZ zamka projektu (sprawdzone mutacją):
 * pierwszy zdążyłby założyć, zanim drugi przeczyta listę.
 */
const CREATE_MS = 20;
const later = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, CREATE_MS); });

class SharedHerdr extends FakeHerdr {
  readonly createdWorkspaces: string[] = [];
  readonly createdTabs: string[] = [];

  /** @param kernelCwd — jak herdr zapisze `cwd` nowego panelu (domyślnie: tak, jak go dostał). */
  constructor(private readonly kernelCwd: (cwd: string) => string = (cwd) => cwd) {
    super();
  }

  override async createWorkspace(params: { cwd: string; label?: string }): Promise<{
    workspaceId: string; tabId: string; paneId: string;
  }> {
    this.createdWorkspaces.push(params.label ?? '');
    await later();
    return await super.createWorkspace({ ...params, cwd: this.kernelCwd(params.cwd) });
  }

  override async createTab(params: { workspaceId: string; cwd: string; label?: string }): Promise<{
    tabId: string; paneId: string;
  }> {
    this.createdTabs.push(params.workspaceId);
    await later();
    return await super.createTab({ ...params, cwd: this.kernelCwd(params.cwd) });
  }

  override startAgent(): Promise<{ argv: readonly string[] }> {
    return Promise.resolve({ argv: ['claude'] });
  }
}

describe('pierwsze równoczesne założenie Claude i terminala jednego projektu', () => {
  const CWD = '/Users/testowy/Projects/wspolny';

  /*
   * `shared` składa launcher i backend BEZ jawnego zamka — tak jak `index.ts` i `term/index.ts`
   * w produkcji: oba muszą wtedy dostać TEN SAM zamek procesu (`sharedProjectPlacement`).
   */
  for (const order of ['claude-first', 'term-first', 'shared'] as const) {
    it(`daje JEDEN workspace (${order})`, async () => {
      const herdr = new SharedHerdr();
      const placement = order === 'shared' ? undefined : createProjectPlacement();
      const config = loadConfig({
        RAROG_ORIGINS: 'https://rarog.example',
        RAROG_TERM: '1',
        RAROG_HERDR_BIN: '/usr/bin/true',
        RAROG_HERDR_LAUNCH: '1',
        RAROG_PROJECT_ROOTS: '/Users/testowy/Projects',
        RAROG_DATA_DIR: tempDir('rarog-ws-resolver-data-'),
        HOME: '/Users/testowy',
        PATH: '/usr/bin:/bin',
        TMPDIR: '/tmp',
      });
      const backend = createHerdrBackend({
        config, logger: { info: () => {}, error: () => {} }, launchClient: () => herdr,
        ...(placement === undefined ? {} : { placement }),
      });
      const launcher = createHerdrLauncher({
        client: herdr,
        ...(placement === undefined ? {} : { placement }),
        trust: { isTrusted: async () => true },
        registerLaunch: () => 'key-1',
        probeAgent: async () => ({
          agentSessionId: '11111111-2222-4333-8444-555555555555', status: 'idle', interactiveReady: true,
        }),
        newSessionId: () => '11111111-2222-4333-8444-555555555555',
        sleep: async () => {},
      });

      const claude = (): Promise<unknown> => launcher.launch({ cwd: CWD }).then((handle) => handle.ready);
      const term = (): Promise<unknown> => backend.ensureSession(termIdFor(CWD), CWD, 'shell');
      await Promise.all(order === 'term-first' ? [term(), claude()] : [claude(), term()]);

      expect(herdr.createdWorkspaces).toEqual(['wspolny']);
      expect(herdr.createdTabs).toHaveLength(1);
      backend.dispose();
    });
  }
});

// ---------------------------------------------------------------------------
// Wielkość liter na macOS
// ---------------------------------------------------------------------------

/**
 * Katalog `Projekt` na dysku i jego ścieżka w innej wielkości liter (`PROJEKT`); `null`, gdy system
 * plików jest czuły na wielkość liter (wtedy przypadek nie istnieje).
 */
function caseDir(): { disk: string; other: string } | null {
  const root = realpathSync.native(tempDir('rarog-ws-case-'));
  mkdirSync(join(root, 'Projekt'));
  const other = join(root, 'PROJEKT');
  return existsSync(other) ? { disk: join(root, 'Projekt'), other } : null;
}

function termConfig(dataDir: string): ReturnType<typeof loadConfig> {
  return loadConfig({
    RAROG_ORIGINS: 'https://rarog.example',
    RAROG_TERM: '1',
    RAROG_HERDR_BIN: '/usr/bin/true',
    RAROG_HERDR_LAUNCH: '1',
    RAROG_PROJECT_ROOTS: '/Users/testowy/Projects',
    RAROG_DATA_DIR: dataDir,
    HOME: '/Users/testowy',
    PATH: '/usr/bin:/bin',
    TMPDIR: '/tmp',
  });
}

const quiet = { info: (): void => {}, error: (): void => {} };

function launcherOn(herdr: FakeHerdr, placement: ReturnType<typeof createProjectPlacement>) {
  return createHerdrLauncher({
    client: herdr,
    placement,
    trust: { isTrusted: async () => true },
    registerLaunch: () => 'key-1',
    probeAgent: async () => ({
      agentSessionId: '11111111-2222-4333-8444-555555555555', status: 'idle', interactiveReady: true,
    }),
    newSessionId: () => '11111111-2222-4333-8444-555555555555',
    sleep: async () => {},
  });
}

async function waitFor(what: string, predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
  throw new Error(`nie doczekano: ${what}`);
}

describe('wielkość liter: etykieta terminala liczona z innej pisowni niż katalog', () => {
  it('terminal otwarty `…/PROJEKT`, restart Raroga → nowa sesja i drugi slot trafiają do jego workspace\'u',
    async () => {
      const dir = caseDir();
      if (dir === null) return;
      // herdr podaje `cwd` panelu tak, jak widzi go jądro — pisownią z dysku.
      const herdr = new SharedHerdr((cwd) => realpathSync.native(cwd));
      const dataDir = tempDir('rarog-ws-case-data-');
      const backendA = createHerdrBackend({
        config: termConfig(dataDir), logger: quiet, launchClient: () => herdr,
        placement: createProjectPlacement(),
      });
      const registryA = new TermRegistry({ config: termConfig(dataDir), logger: quiet, backend: backendA });
      const first = registryA.open(dir.other);
      if (!first.ok) throw new Error(first.sentence.text);
      await waitFor('panel z etykietą', () => herdr.createdWorkspaces.length === 1
        && herdr.createdTabs.length === 0
        && (herdr.pane('w1:p1')?.label ?? null) !== null);
      registryA.dispose();
      backendA.dispose();

      // Restart Raroga: pamięć „założyłem" przepada (nowe zamki), herdr i plik stanu zostają.
      await (await launcherOn(herdr, createProjectPlacement()).launch({ cwd: dir.disk })).ready;
      const backendB = createHerdrBackend({
        config: termConfig(dataDir), logger: quiet, launchClient: () => herdr,
        placement: createProjectPlacement(),
      });
      const registryB = new TermRegistry({ config: termConfig(dataDir), logger: quiet, backend: backendB });
      const second = registryB.open(dir.other, 2);
      if (!second.ok) throw new Error(second.sentence.text);
      // Trzecie założenie (tab albo workspace) — porażka ma być asercją niżej, nie timeoutem.
      await waitFor('drugi slot', () => herdr.createdTabs.length + herdr.createdWorkspaces.length === 3);

      expect(herdr.createdWorkspaces).toHaveLength(1);
      expect(herdr.createdTabs).toEqual(['w1', 'w1']);
      registryB.dispose();
      backendB.dispose();
    });

  it('terminal sprzed poprawki (tożsamość z `…/PROJEKT`): drugi slot znajduje go po pliku stanu', async () => {
    const dir = caseDir();
    if (dir === null) return;
    const legacy = termIdFor(dir.other);
    const herdr = new SharedHerdr();
    herdr.addPane({
      paneId: 'w1:p1', tabId: 'w1:p1t', workspaceId: 'w1', cwd: dir.disk,
      tokens: { [RAROG_TERM_TOKEN]: legacy }, label: termPaneLabel(legacy),
    });
    const dataDir = tempDir('rarog-ws-case-data-');
    writeFileSync(join(dataDir, TERM_HERDR_STATE_FILENAME), `${JSON.stringify({
      'w1:p1': { seen: Date.now(), cwd: dir.other },
    })}\n`);
    const backend = createHerdrBackend({
      config: termConfig(dataDir), logger: quiet, launchClient: () => herdr,
      placement: createProjectPlacement(),
    });

    await backend.ensureSession(termIdFor(dir.disk, 2), dir.disk, 'shell');

    expect(herdr.createdWorkspaces).toEqual([]);
    expect(herdr.createdTabs).toEqual(['w1']);
    backend.dispose();
  });

  it('terminal sprzed poprawki, herdr podaje `cwd` pisownią wejścia: nowa sesja Claude trafia do niego',
    async () => {
      const dir = caseDir();
      if (dir === null) return;
      const legacy = termIdFor(dir.other);
      const herdr = new SharedHerdr();
      herdr.addPane({
        paneId: 'w1:p1', tabId: 'w1:p1t', workspaceId: 'w1', cwd: dir.other,
        tokens: { [RAROG_TERM_TOKEN]: legacy }, label: termPaneLabel(legacy),
      });

      await (await launcherOn(herdr, createProjectPlacement()).launch({ cwd: dir.disk })).ready;

      expect(herdr.createdWorkspaces).toEqual([]);
      expect(herdr.createdTabs).toEqual(['w1']);
    });
});
