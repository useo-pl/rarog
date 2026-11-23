/**
 * Atrapy backendu terminala: fałszywe gniazdo herdr i fałszywy proces kontrolera.
 *
 * Nie jest to plik testowy (nie pasuje do wzorca `*.test.ts`), tylko wspólny helper:
 * `term-integration.test.ts` (transport WS na całej drodze), `term-index.test.ts` (start i takt
 * odzyskiwania paneli) i producenci złotych ramek terminala
 * (`rest-fixtures-producenci.test.ts`, `term-fixtures-producenci.test.ts`). Atrapy
 * stoją ZA prawdziwym rejestrem, `ws.ts` i routerem — odmowy, ramki i odpowiedzi produkuje kod
 * serwera, a nie test.
 */
import { EventEmitter } from 'node:events';
import { basename } from 'node:path';
import { PassThrough } from 'node:stream';
import type { HerdrLaunchClient, HerdrPaneInfo, HerdrWorkspaceInfo } from '../src/herdr/types.ts';
import type { TermHerdrChild } from '../src/term/herdr-backend.ts';

/** Atrapa procesu `herdr terminal session control` — strumienie prawdziwe, proces nie. */
export class FakeController extends EventEmitter implements TermHerdrChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Wszystko, co backend wpisał na stdin kontrolera (NDJSON) — do asercji wklejki. */
  private written = '';

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => { this.written += chunk.toString('utf8'); });
  }

  kill(): void { this.emit('exit', 0, null); }

  /** Treści `terminal.input` w kolejności — dokładnie to, co dostałby herdr. */
  inputs(): string[] {
    return this.written.split('\n').filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { type: string; text?: string })
      .filter((frame) => frame.type === 'terminal.input')
      .map((frame) => frame.text ?? '');
  }
}

/**
 * Fałszywe gniazdo herdr: zna dokładnie tyle, ile backend potrzebuje, żeby założyć panel
 * i przyznać mu token. Sprawdzaniem tego, co Rarog mówi do herdr, zajmuje się
 * `term-herdr-backend.test.ts` — tutaj gniazdo ma tylko nie stać na drodze transportowi.
 */
export class FakeHerdr implements HerdrLaunchClient {
  private readonly panes: HerdrPaneInfo[] = [];
  /**
   * Procesy pierwszego planu KAŻDEGO panelu (etykieta pigułki, np. przy lazygicie). Domyślnie
   * goła powłoka — dokładnie to, co herdr odtwarza w panelu po swoim restarcie.
   */
  processes: readonly { pid: number; name: string; argv0: string }[] = [{ pid: 1, name: 'zsh', argv0: 'zsh' }];
  /** Wywołania `pane.report_metadata` z tokenami — do sprawdzania, że stempel nie niesie TTL. */
  readonly stamps: { paneId: string; tokens?: Readonly<Record<string, string | null>>; ttlMs?: number }[] = [];

  /**
   * @param history — historia każdego panelu dla `GET /api/term/:id/history` (tekst
   *   SYNTETYCZNY, nigdy zrzut cudzej powłoki).
   */
  constructor(private readonly history: { text: string; truncated: boolean } = { text: '', truncated: false }) {}

  /**
   * Panel „zastany" — np. sierota po restarcie serwera herdr: etykieta panelu przeżyła
   * (snapshot), token zginął. Test buduje nim stan sprzed startu Raroga.
   */
  addPane(pane: HerdrPaneInfo): void {
    this.panes.push({ ...pane, tokens: { ...pane.tokens } });
  }

  /** Bieżący stan panelu (kopia) — do asercji po przebiegu odzyskiwania. */
  pane(paneId: string): HerdrPaneInfo | undefined {
    const pane = this.panes.find((candidate) => candidate.paneId === paneId);
    return pane === undefined ? undefined : { ...pane, tokens: { ...pane.tokens } };
  }

  listPanes(): Promise<HerdrPaneInfo[]> {
    return Promise.resolve(this.panes.map((pane) => ({ ...pane, tokens: { ...pane.tokens } })));
  }

  listPaneIds(): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set(this.panes.map((pane) => pane.paneId)));
  }

  /** Etykiety workspace'ów założonych przez `workspace.create` (resolver workspace'u). */
  private readonly workspaceLabels = new Map<string, string>();

  /**
   * `workspace.list` — workspace'y z `workspace.create` z ich etykietą, a workspace panelu
   * zastanego (`addPane`) z etykietą = nazwa katalogu jego pierwszego panelu: tak nazywa projekt
   * herdr i tak szuka go resolver. Ścieżek checkoutu atrapa nie zna.
   */
  listWorkspaces(): Promise<HerdrWorkspaceInfo[]> {
    const out = new Map<string, HerdrWorkspaceInfo>();
    for (const [workspaceId, label] of this.workspaceLabels) out.set(workspaceId, { workspaceId, label });
    for (const pane of this.panes) {
      if (!out.has(pane.workspaceId)) {
        out.set(pane.workspaceId, { workspaceId: pane.workspaceId, label: basename(pane.cwd) });
      }
    }
    return Promise.resolve([...out.values()]);
  }

  readPaneHistory(): Promise<{ text: string; truncated: boolean }> {
    return Promise.resolve({ ...this.history });
  }

  /** Nazwa procesu panelu — etykieta pigułki; transportu nie dotyczy. */
  readPaneProcess(): Promise<{ processes: readonly { pid: number; name: string; argv0: string }[] }> {
    return Promise.resolve({ processes: this.processes });
  }

  createWorkspace(params: { cwd: string; label?: string }): Promise<{
    workspaceId: string; tabId: string; paneId: string;
  }> {
    const paneId = `w${String(this.panes.length + 1)}:p1`;
    this.workspaceLabels.set(paneId.split(':')[0] ?? '', params.label ?? basename(params.cwd));
    this.panes.push({
      paneId, tabId: `${paneId}t`, workspaceId: `w${String(this.panes.length + 1)}`,
      cwd: params.cwd, tokens: {}, label: null,
    });
    // Jak herdr: pierwszy tab nowego workspace'u dostaje „1" (etykieta z parametrów nazywa workspace).
    this.tabLabelNow.set(`${paneId}t`, '1');
    return Promise.resolve({ workspaceId: paneId.split(':')[0] ?? '', tabId: `${paneId}t`, paneId });
  }

  createTab(params: { workspaceId: string; cwd: string; label?: string }): Promise<{
    tabId: string; paneId: string;
  }> {
    const paneId = `${params.workspaceId}:p${String(this.panes.length + 1)}`;
    this.panes.push({
      paneId, tabId: `${paneId}t`, workspaceId: params.workspaceId, cwd: params.cwd, tokens: {},
      label: null,
    });
    if (params.label !== undefined) this.tabLabelNow.set(`${paneId}t`, params.label);
    return Promise.resolve({ tabId: `${paneId}t`, paneId });
  }

  startAgent(): Promise<{ argv: readonly string[] }> {
    return Promise.reject(new Error('terminal nie uruchamia agentów'));
  }

  probeAgent(): Promise<never> {
    return Promise.reject(new Error('terminal nie sonduje agentów'));
  }

  reportPaneMetadata(params: {
    paneId: string; tokens?: Readonly<Record<string, string | null>>; ttlMs?: number;
  }): Promise<void> {
    this.stamps.push({
      paneId: params.paneId,
      ...(params.tokens === undefined ? {} : { tokens: { ...params.tokens } }),
      ...(params.ttlMs === undefined ? {} : { ttlMs: params.ttlMs }),
    });
    const pane = this.panes.find((candidate) => candidate.paneId === params.paneId);
    if (pane !== undefined) {
      // Jak herdr: `null` zdejmuje token, napis go stawia.
      const tokens: Record<string, string> = { ...pane.tokens };
      for (const [key, value] of Object.entries(params.tokens ?? {})) {
        if (value === null) delete tokens[key];
        else tokens[key] = value;
      }
      pane.tokens = tokens;
    }
    return Promise.resolve();
  }

  /** Etykieta panelu — trzymana jak w herdr, `null` ją zdejmuje. */
  renamePane(paneId: string, label: string | null): Promise<void> {
    const pane = this.panes.find((candidate) => candidate.paneId === paneId);
    if (pane !== undefined) pane.label = label;
    return Promise.resolve();
  }

  /** Etykiety tabów — każde `tab.rename` w kolejności. */
  readonly tabLabels: { tabId: string; label: string }[] = [];
  /**
   * Bieżąca etykieta taba (`tab.get`). Tab, którego atrapa nie zna z `tab.create`/`tab.rename`
   * ani z {@link setTabLabel}, ma etykietę „nazwaną ręcznie" — migracja etykiet tabów go nie rusza.
   */
  private readonly tabLabelNow = new Map<string, string>();

  /** Etykieta taba zastana przed startem Raroga (np. „1” z `workspace.create`). */
  setTabLabel(tabId: string, label: string): void {
    this.tabLabelNow.set(tabId, label);
  }

  renameTab(tabId: string, label: string): Promise<void> {
    this.tabLabels.push({ tabId, label });
    this.tabLabelNow.set(tabId, label);
    return Promise.resolve();
  }

  /** `tab.get` — liczba paneli z bieżących paneli atrapy, etykieta z mapy wyżej. */
  getTab(tabId: string): Promise<{
    tabId: string; label: string; paneCount: number; workspaceId: string;
  }> {
    const inTab = this.panes.filter((pane) => pane.tabId === tabId);
    return Promise.resolve({
      tabId,
      label: this.tabLabelNow.get(tabId) ?? 'nazwany ręcznie',
      paneCount: inTab.length,
      workspaceId: inTab[0]?.workspaceId ?? '',
    });
  }

  closePane(paneId: string): Promise<void> {
    const index = this.panes.findIndex((pane) => pane.paneId === paneId);
    if (index >= 0) this.panes.splice(index, 1);
    return Promise.resolve();
  }

  closeTab(): Promise<void> { return Promise.resolve(); }
}
