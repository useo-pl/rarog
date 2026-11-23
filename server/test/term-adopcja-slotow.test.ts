/**
 * Terminal PTY — ADOPCJA powłok po restarcie Raroga, ze SLOTAMI.
 *
 * Rejestr terminali żyje w RAM, więc po restarcie serwera jedynym śladem po otwartym tabie
 * jest panel herdr z tokenem `rarog-term = <id>`. Adopcja musi z tego tokenu wyprowadzić NIE
 * TYLKO „to nasz panel", ale też NUMER TABA — hash jest jednokierunkowy, więc jedyną drogą
 * jest sprawdzenie `termIdFor(realpath(cwd), s)` dla `s = 1…TERM_SLOTS_MAX`.
 *
 * Ten plik istnieje, bo bez tej pętli KAŻDY tab o numerze ≥ 2 przeżywał restart Raroga
 * w herdr, ale znikał z Raroga: żywy panel, którego nie widać w PWA i do którego upgrade WS
 * odbija się od pustego rejestru. To jest warunek poprawności całych tabów, nie detal.
 *
 * Gniazdo herdr i proces kontrolera są atrapami — tu chodzi wyłącznie o `adoptSurvivors`
 * w `term/index.ts`, czyli o to, co Rarog robi z listą paneli przy starcie.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { TERM_SLOTS_MAX } from '@rarog/shared';
import { loadConfig } from '../src/config.ts';
import type { HerdrLaunchClient, HerdrPaneInfo, HerdrPaneProcessInfo } from '../src/herdr/types.ts';
import type { Logger } from '../src/router.ts';
import { RAROG_TERM_TOKEN } from '../src/term/herdr-backend.ts';
import type { TermHerdrChild } from '../src/term/herdr-backend.ts';
import { createTermFeature } from '../src/term/index.ts';
import type { TermFeature } from '../src/term/index.ts';
import { termIdFor } from '../src/term/lifecycle.ts';

/** Atrapa procesu kontrolera — adopcja go nie dotyka, ale ficzer musi mieć co spawnować. */
class FakeController extends EventEmitter implements TermHerdrChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  kill(): void { this.emit('exit', 0, null); }
}

/** Fałszywe gniazdo herdr: oddaje z góry ustawioną listę paneli i nic więcej nie umie. */
class FakeHerdr implements HerdrLaunchClient {
  constructor(public panes: HerdrPaneInfo[] = []) {}

  listPanes(): Promise<HerdrPaneInfo[]> {
    return Promise.resolve(this.panes.map((pane) => ({ ...pane, tokens: { ...pane.tokens } })));
  }

  listPaneIds(): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set(this.panes.map((pane) => pane.paneId)));
  }

  /** Workspace'y czyta wyłącznie zakładanie (resolver workspace'u) — adopcja niczego nie zakłada. */
  listWorkspaces(): Promise<never> {
    return Promise.reject(new Error('adopcja nie wybiera workspace’u'));
  }

  readPaneHistory(): Promise<{ text: string; truncated: boolean }> {
    return Promise.resolve({ text: '', truncated: false });
  }

  readPaneProcess(): Promise<HerdrPaneProcessInfo> {
    return Promise.resolve({ processes: [{ pid: 1, name: 'zsh', argv0: 'zsh' }] });
  }

  /** Adopcja NIE MA prawa zakładać paneli — każde wywołanie jest tu błędem testu. */
  createWorkspace(): Promise<never> {
    return Promise.reject(new Error('adopcja nie zakłada workspace’ów'));
  }

  createTab(): Promise<never> {
    return Promise.reject(new Error('adopcja nie zakłada tabów'));
  }

  startAgent(): Promise<never> {
    return Promise.reject(new Error('terminal nie uruchamia agentów'));
  }

  probeAgent(): Promise<never> {
    return Promise.reject(new Error('terminal nie sonduje agentów'));
  }

  readonly stamped: string[] = [];
  reportPaneMetadata(params: { paneId: string }): Promise<void> {
    this.stamped.push(params.paneId);
    return Promise.resolve();
  }

  /**
   * Etykiety paneli nadaje start ODZYSKIWANIA przed adopcją (panel z tokenem bez etykiety
   * dostaje `rarog-term <token>`) — atrapa je notuje, adopcja sama nie.
   */
  readonly renamedPanes: { paneId: string; label: string | null }[] = [];
  renamePane(paneId: string, label: string | null): Promise<void> {
    this.renamedPanes.push({ paneId, label });
    return Promise.resolve();
  }

  /** Taby nazywa wyłącznie zakładanie panelu, a adopcja niczego nie zakłada. */
  renameTab(): Promise<never> {
    return Promise.reject(new Error('adopcja nie nadaje etykiet tabów'));
  }

  /**
   * `tab.get` (migracja etykiet tabów w odzyskiwaniu) — taby tej atrapy mają etykiety
   * nadane ręcznie, więc migracja niczego tu nie przemianowuje.
   */
  getTab(tabId: string): Promise<{
    tabId: string; label: string; paneCount: number; workspaceId: string;
  }> {
    const inTab = this.panes.filter((pane) => pane.tabId === tabId);
    return Promise.resolve({
      tabId, label: 'nazwany ręcznie', paneCount: inTab.length, workspaceId: inTab[0]?.workspaceId ?? '',
    });
  }

  readonly closedPanes: string[] = [];
  closePane(paneId: string): Promise<void> {
    this.closedPanes.push(paneId);
    return Promise.resolve();
  }

  closeTab(): Promise<void> { return Promise.resolve(); }
}

const silent: Logger = { info: () => {}, error: () => {} };

interface Harness {
  term: TermFeature;
  cwd: string;
  herdr: FakeHerdr;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/**
 * Startuje ficzer terminala z GOTOWĄ listą paneli — czyli dokładnie w sytuacji „Rarog właśnie
 * wstał, a powłoki w herdr żyją od wczoraj".
 */
async function startWithPanes(
  makePanes: (cwd: string) => HerdrPaneInfo[],
): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rarog-term-adopcja-')));
  const config = loadConfig({
    RAROG_ORIGINS: 'https://rarog.example',
    RAROG_PROJECT_ROOTS: root,
    RAROG_TERM: '1',
    RAROG_HERDR_LAUNCH: '1',
    RAROG_HERDR_BIN: '/usr/bin/true',
    RAROG_DATA_DIR: join(root, '.dane'),
    HOME: root,
    PATH: '/usr/bin:/bin',
    TMPDIR: '/tmp',
  });
  const herdr = new FakeHerdr(makePanes(root));
  const term = await createTermFeature(config, silent, {
    herdrLaunchClient: () => herdr,
    herdrSpawn: () => new FakeController(),
  });
  if (term === null) throw new Error('createTermFeature oddało null mimo RAROG_TERM=1');
  await term.ready;
  cleanups.push(async () => {
    term.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { term, cwd: root, herdr };
}

/** Panel herdr z tokenem terminala Raroga o podanej tożsamości. */
function ownPane(index: number, cwd: string, id: string): HerdrPaneInfo {
  return {
    paneId: `w1:p${String(index)}`,
    tabId: `w1:t${String(index)}`,
    workspaceId: 'w1',
    cwd,
    tokens: { [RAROG_TERM_TOKEN]: id },
    label: null,
  };
}

describe('adopcja po restarcie Raroga wyprowadza SLOT z tokenu panelu', () => {
  it('panel slotu 1 wraca jako slot 1 (zgodność wstecz — token bez sufiksu)', async () => {
    const h = await startWithPanes((cwd) => [ownPane(1, cwd, termIdFor(cwd))]);

    expect(h.term.list()).toEqual([
      { id: termIdFor(h.cwd), cwd: h.cwd, live: false, slot: 1, proc: '', role: 'shell' },
    ]);
  });

  /*
   * BEZ pętli po slotach ten test padał na pustej liście: `adoptSurvivors` liczyło id wyłącznie
   * z `cwd`, więc token slotu 2 nie zgadzał się z niczym i panel wypadał jako „cudzy".
   */
  it('panel slotu 2 wraca jako slot 2, a nie znika', async () => {
    const h = await startWithPanes((cwd) => [ownPane(2, cwd, termIdFor(cwd, 2))]);

    expect(h.term.list()).toEqual([
      { id: termIdFor(h.cwd, 2), cwd: h.cwd, live: false, slot: 2, proc: '', role: 'shell' },
    ]);
  });

  it('komplet tabów projektu przeżywa restart co do numeru', async () => {
    const h = await startWithPanes((cwd) => Array.from(
      { length: TERM_SLOTS_MAX },
      (_unused, index) => ownPane(index + 1, cwd, termIdFor(cwd, index + 1)),
    ));

    expect(h.term.list().map((entry) => entry.slot).sort()).toEqual(
      Array.from({ length: TERM_SLOTS_MAX }, (_unused, index) => index + 1),
    );
    // Każdy wpis niesie WŁASNE id — inaczej cztery panele wpadłyby na jeden terminal.
    expect(new Set(h.term.list().map((entry) => entry.id)).size).toBe(TERM_SLOTS_MAX);
  });

  /*
   * DOWÓD WŁASNOŚCI zostaje w pełnej mocy: pętla po slotach nie ma prawa zamienić bramki
   * „token musi być hashem WŁASNEJ ścieżki" w „jakikolwiek token nas przekona".
   */
  it('token z cudzego katalogu NIE jest adoptowany przy żadnym slocie', async () => {
    const h = await startWithPanes((cwd) => [
      ownPane(1, cwd, termIdFor('/Users/testowy/Projects/cudzy')),
      ownPane(2, cwd, termIdFor('/Users/testowy/Projects/cudzy', 2)),
    ]);

    expect(h.term.list()).toEqual([]);
  });

  it('numer ponad sufit slotów nie jest adoptowany — token nie pasuje do żadnego slotu', async () => {
    const h = await startWithPanes(
      (cwd) => [ownPane(9, cwd, termIdFor(cwd, TERM_SLOTS_MAX + 1))],
    );

    expect(h.term.list()).toEqual([]);
  });

  it('panel bez tokenu (tab człowieka) nie jest adoptowany', async () => {
    const h = await startWithPanes((cwd) => [{
      paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', cwd, tokens: {}, label: null,
    }]);

    expect(h.term.list()).toEqual([]);
  });

  /*
   * Adoptowany terminal ma być NORMALNYM wpisem: `POST /api/term` na jego slot musi trafić
   * w niego, a nie założyć drugiego panelu na ten sam tab.
   */
  /*
   * PANEL LAZYGIT ma tożsamość POZA slotami, więc pętla po slotach go nie znajdzie
   * — adopcja pyta o niego osobno. Bez tego żywy lazygit przeżywał restart Raroga w herdr, ale
   * znikał z Raroga: popup nie miałby się do czego podłączyć, a następny `POST` zakładałby
   * DRUGI panel obok chodzącego.
   */
  it('panel lazygita wraca jako wpis roli `lazygit` ze `slot: 0`', async () => {
    const h = await startWithPanes((cwd) => [ownPane(5, cwd, termIdFor(cwd, 0, 'lazygit'))]);

    expect(h.term.list()).toEqual([{
      id: termIdFor(h.cwd, 0, 'lazygit'),
      cwd: h.cwd,
      live: false,
      slot: 0,
      proc: '',
      role: 'lazygit',
    }]);
  });

  it('adoptowany lazygit jest idempotentny dla `POST /api/term` i nie zabiera slotu', async () => {
    const h = await startWithPanes((cwd) => [ownPane(5, cwd, termIdFor(cwd, 0, 'lazygit'))]);

    expect(h.term.open(h.cwd, 1, 'lazygit'))
      .toEqual({ ok: true, id: termIdFor(h.cwd, 0, 'lazygit'), slot: 0, role: 'lazygit' });
    expect(h.term.list()).toHaveLength(1);
    // Pierwszy tab projektu dalej jest wolny — lazygit stoi poza numeracją.
    expect(h.term.open(h.cwd, 'next')).toMatchObject({ ok: true, slot: 1, role: 'shell' });
  });

  it('token lazygita z CUDZEGO katalogu nie jest adoptowany', async () => {
    const h = await startWithPanes((cwd) => [
      ownPane(5, cwd, termIdFor('/Users/testowy/Projects/cudzy', 0, 'lazygit')),
    ]);

    expect(h.term.list()).toEqual([]);
  });

  /*
   * Ról popupowych są DWIE, a adopcja próbuje KAŻDEJ z nich. Gdyby
   * pytała tylko o `lazygit`, żywy panel Cmd+F przeżywałby restart Raroga w herdr, ale znikałby
   * z Raroga — a następny `POST` zakładałby drugi panel obok chodzącego.
   */
  it('panel roli `popup` wraca jako wpis `popup` ze `slot: 0`', async () => {
    const h = await startWithPanes((cwd) => [ownPane(6, cwd, termIdFor(cwd, 0, 'popup'))]);

    expect(h.term.list()).toEqual([{
      id: termIdFor(h.cwd, 0, 'popup'),
      cwd: h.cwd,
      live: false,
      slot: 0,
      proc: '',
      role: 'popup',
    }]);
    expect(h.term.open(h.cwd, 1, 'popup'))
      .toEqual({ ok: true, id: termIdFor(h.cwd, 0, 'popup'), slot: 0, role: 'popup' });
  });

  it('lazygit i popup tego samego katalogu wracają jako DWA osobne wpisy', async () => {
    const h = await startWithPanes((cwd) => [
      ownPane(5, cwd, termIdFor(cwd, 0, 'lazygit')),
      ownPane(6, cwd, termIdFor(cwd, 0, 'popup')),
    ]);

    expect(h.term.list().map((e) => [e.role, e.slot]).sort())
      .toEqual([['lazygit', 0], ['popup', 0]]);
  });

  it('adoptowany slot ≥ 2 jest idempotentny dla `POST /api/term`', async () => {
    const h = await startWithPanes((cwd) => [ownPane(3, cwd, termIdFor(cwd, 3))]);

    expect(h.term.open(h.cwd, 3))
      .toEqual({ ok: true, id: termIdFor(h.cwd, 3), slot: 3, role: 'shell' });
    expect(h.term.list()).toHaveLength(1);
    // `'next'` widzi zajęty slot 3 i schodzi do najniższego wolnego, czyli 1.
    expect(h.term.open(h.cwd, 'next')).toMatchObject({ ok: true, slot: 1 });
  });
});
