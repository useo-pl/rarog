/**
 * Fakes for the manager × herdr session tests: supervisor, driver, herdr dependencies and a pane entry.
 *
 * Shared by `manager-herdr.test.ts` and the tests of modules split out of the manager (`seen-marks.test.ts`),
 * so that a test moved together with its module runs on the same fakes.
 */
import { expect } from 'vitest';
import type { FileAttachment, HerdrMode, HerdrStatus } from '@rarog/shared';
import { foreign, say } from '@rarog/shared/sentences';
import { BadRequestError } from '../../src/sessions/manager.ts';
import type { HerdrManagerDeps } from '../../src/sessions/manager.ts';
import type { ResumeSettings } from '../../src/herdr/jsonl-pending.ts';
import type { SendOptions } from '../../src/drivers/types.ts';
import type { HerdrAgent, HerdrLaunchHandle, HerdrLaunchRequest } from '../../src/herdr/types.ts';
import { HerdrGoneError } from '../../src/herdr/types.ts';
import { HerdrUnavailableError } from '../../src/herdr/socket.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './atrapa-sesji.ts';

export const PROJECT = '/Users/u/Projects/atlas';
export const ENGINE_SESSION = '11111111-1111-4111-8111-111111111111';
// ---------------------------------------------------------------------------
// Atrapy
// ---------------------------------------------------------------------------

/*
 * Wszystko, co manager każe driverom, ląduje w JEDNYM dzienniku nadzorcy (`supervisor.log`, wspólna atrapa
 * `helpers/atrapa-sesji.ts`). Jeden dziennik dla wszystkich driverów jest celowy: najważniejszy test w tym pliku
 * brzmi „po `dispose()` managera ta lista jest PUSTA", a to musi być prawdą dla 3 paneli naraz, nie dla jednego
 * wybranego. Dziennik zapisuje wywołania (`send`, `respondPermission` z decyzją, `interrupt`), nie klawisze.
 */

/** Driver przypięty do cudzego panelu: nie jest właścicielem procesu i nigdy nim nie będzie. */
export class FakeHerdrDriver extends AtrapaDrivera {
  override send(text: string, images?: readonly string[], files?: readonly FileAttachment[], opts?: SendOptions): void {
    // Manager ma wykonać uploady SAM i przekazać gotowy tekst — driver nie dostaje obrazków.
    expect(images).toBeUndefined();
    super.send(text, images, files, opts);
  }

  /** Żądania ultracode, które manager podał driverowi: chwila i czy uzbraja regułę pierwszej tury. */
  readonly ultracodeRequests: { atMs: number; firstTurn: boolean | undefined }[] = [];

  noteUltracodeRequest(atMs: number, firstTurn?: boolean): void {
    this.ultracodeRequests.push({ atMs, firstTurn });
  }
}

/** Status panelu i gotowość, które launcher oddaje w `ready` (`HerdrLaunchResult`). */
export interface LaunchSeen {
  status: 'idle' | 'working' | 'blocked';
  interactiveReady: boolean;
}

export class FakeSupervisor extends AtrapaNadzorcy<FakeHerdrDriver> {
  readonly marked: string[] = [];
  attachCount = 0;
  disposed = false;
  /** Rzuca przy `attach()` — panel zniknął między resyncem a podpięciem. */
  attachThrows = false;
  /**
   * Czy świeżo podpięty driver od razu melduje stan.
   *
   * Realny driver robi to zawsze (historia albo `agent-state`), a manager zwalnia na tym
   * slot podpięcia. Testy liczące zdarzenia wyłączają to i emitują same, co chcą.
   */
  autoSettle = true;

  #status: HerdrStatus = { available: true, agentCount: 0, readOnly: false, canLaunch: true };
  /** Tryb zwracany przez bramkę świeżości; test podmienia go na `unknown`. */
  freshMode: HerdrMode = 'auto';
  /** Ile razy manager pytał o świeży tryb — asercja „odczyt przed wysyłką". */
  modeReads = 0;
  /** Wpisy odmów komend: `[klucz panelu, katalog, nazwa]`. */
  readonly commandRefusals: [string | null, string, string][] = [];

  logCommandRefusal(key: string | null, cwd: string, command: string): void {
    this.commandRefusals.push([key, cwd, command]);
  }

  protected nowyDriver(key: string): FakeHerdrDriver {
    return new FakeHerdrDriver(key, { dziennik: this.log });
  }

  override status(): HerdrStatus {
    return this.#status;
  }

  setStatus(patch: Partial<HerdrStatus>): void {
    this.#status = { ...this.#status, ...patch };
  }

  override attach(key: string): FakeHerdrDriver {
    if (this.attachThrows) throw new Error(`panel ${key} zniknął`);
    this.attachCount += 1;
    const driver = super.attach(key);
    if (this.autoSettle) {
      driver.queue.push({ type: 'agent-state', state: 'idle', seen: true });
    }
    return driver;
  }

  override markSent(key: string): void {
    this.marked.push(key);
  }

  override async ensureFreshMode(): Promise<HerdrMode> {
    this.modeReads += 1;
    return this.freshMode;
  }

  /** Panele, którym Rarog kazał wyjść na wierzch. Pusta lista = „`agent.focus` NIE poszedł". */
  readonly focusCalls: string[] = [];
  /** Awaria SAMEGO wywołania przy zdrowym statusie (gniazdo padło po pre-checku). */
  focusFails: Error | null = null;

  override async focus(key: string): Promise<void> {
    // Wierność produkcji: RPC w padnięte gniazdo rzuca `HerdrUnavailableError`
    // (socket.ts), a nie wraca cicho — bez tego test bramki przechodziłby także bez bramki.
    if (!this.#status.available) {
      throw new HerdrUnavailableError(foreign('Przekroczony czas odpowiedzi herdr (agent.focus).'));
    }
    if (this.focusFails !== null) throw this.focusFails;
    this.focusCalls.push(key);
  }

  // --- kanał TWORZENIA ---

  /** Zlecenia, które doszły do launchera. Pusta lista = „panel NIE powstał". */
  readonly launches: HerdrLaunchRequest[] = [];
  readonly closeTabCalls: string[] = [];
  /** Panele „Raroga" — `closeTab` na czymkolwiek innym rzuca. */
  readonly owned = new Set<string>();
  /** `ready` rozstrzyga się dopiero po `settleLaunch()` — test steruje kolejnością. */
  #pendingReady: { resolve: (seen?: LaunchSeen) => void; reject: (err: Error) => void }[] = [];
  launchFails: Error | null = null;
  paneCount = 0;

  override async launch(req: HerdrLaunchRequest): Promise<HerdrLaunchHandle> {
    if (this.launchFails !== null) throw this.launchFails;
    this.launches.push(req);
    const n = this.launches.length;
    const key = `w0:new${String(n)}`;
    const agentSessionId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
    this.owned.add(key);
    this.paneCount += 1;
    const result = {
      key,
      paneId: key,
      tabId: `${key}:tab`,
      agentSessionId,
      createdWorkspace: false,
      argv: ['--session-id', agentSessionId],
      status: 'idle' as LaunchSeen['status'],
      interactiveReady: true,
    };
    const ready = new Promise<typeof result>((resolve, reject) => {
      this.#pendingReady.push({
        resolve: (seen?: LaunchSeen) => { resolve({ ...result, ...seen }); },
        reject: (err: Error) => { reject(err); },
      });
    });
    return { key, paneId: result.paneId, tabId: result.tabId, agentSessionId, ready };
  }

  /**
   * Domyka ostatnie `launch()` — sukcesem albo błędem (start panelu się nie udał). `seen` podmienia to, co
   * launcher zobaczył na panelu: `{status: 'blocked', interactiveReady: false}` = start stanął na dialogu.
   */
  settleLaunch(err: Error | null = null, seen?: LaunchSeen): void {
    const pending = this.#pendingReady.shift();
    if (pending === undefined) throw new Error('nie ma czego domknąć');
    if (err === null) pending.resolve(seen);
    else pending.reject(err);
  }

  /** Panele, które ZNIKNĘŁY z herdr — realny `closeTab` sprawdza istnienie jako pierwsze. */
  readonly vanished = new Set<string>();

  override async closeTab(key: string): Promise<void> {
    // Jak w gnieździe: przy padniętym transporcie `tab.close` nie dojeżdża nigdzie.
    if (!this.#status.available) {
      throw new HerdrUnavailableError(foreign('Przekroczony czas odpowiedzi herdr (tab.close).'));
    }
    if (this.vanished.has(key)) {
      throw new HerdrGoneError(foreign(`Agent ${key} nie istnieje już w herdr.`));
    }
    // Własność panelu nie gra roli — zamyka się każdy istniejący.
    this.closeTabCalls.push(key);
    this.paneCount -= 1;
  }

  override rarogPaneCount(): number {
    return this.paneCount;
  }

  /** Synchronizacje etykiety taba z kartą — każde wywołanie w kolejności. */
  readonly tabLabelSyncs: { key: string; label: string }[] = [];

  syncTabLabel(key: string, label: string): void {
    this.tabLabelSyncs.push({ key, label });
  }

  /** Świeży `agent.list` — test steruje tym, kto ŻYJE i pisze do jsonl. */
  liveEngines = new Set<string>();

  override async liveEngineSessions(): Promise<ReadonlySet<string>> {
    return this.liveEngines;
  }

  override dispose(): void {
    this.disposed = true;
    super.dispose();
  }

  /** Panele, które nadzorca WIDZI (żywe) — źródło `agentFor`/`reannounce`. */
  readonly live = new Map<string, HerdrAgent>();

  agentFor(key: string): HerdrAgent | undefined {
    return this.live.get(key);
  }

  reannounce(key: string): boolean {
    const agent = this.live.get(key);
    if (agent === undefined) return false;
    this.lifecycle.push({ type: 'appeared', agent });
    return true;
  }

  // --- sterowanie z testu ---

  appear(agent: HerdrAgent): void {
    // Ogłoszony panel jest od tej chwili panelem ŻYWYM — dokładnie jak w nadzorcy, który
    // trzyma go w mapach niezależnie od tego, czy manager zrobił z niego kartę.
    this.live.set(agent.key, agent);
    this.lifecycle.push({ type: 'appeared', agent });
  }

  reattach(agent: HerdrAgent): void {
    this.lifecycle.push({ type: 're-attached', agent });
  }
}

/** Slash-komendy, które zapisują TRWAŁE reguły — atrapa guardu z 5.4. */
export const DENY = new Set(['/permissions', '/hooks', '/config', '/mcp', '/login', '/logout']);

/** One durable seen entry of the fake store, shaped as in `herdr-hidden.json`. */
export interface FakeSeenMark {
  agentSessionId: string;
  stateChangeSeq: number;
  unseen?: true;
  by?: 'voice-agent';
}

export interface FakeDeps extends HerdrManagerDeps {
  /** Znaczniki „widziane z telefonu" — jak w pliku na dysku. */
  readonly seenMarks: Map<string, FakeSeenMark>;
  readonly aliases: Map<string, string>;
  readonly transcripts: Map<string, string>;
  readonly cwdByFile: Map<string, string>;
  /** Ustawienia, na których rozmowa skończyła: plik → odczyt z ogona. */
  readonly settingsByFile: Map<string, ResumeSettings>;
  readonly uploaded: { cwd: string; count: number }[];
  readonly uploadedFiles: { cwd: string; names: string[] }[];
  readonly swept: string[][];
  /** Ostatnie „teraz" throttle'a — test przesuwa je zamiast czekać. */
  setNow(ms: number): void;
  /** `true` makes every slot request fail, like an exhausted hourly cap. */
  refuseSlots(on: boolean): void;
}

/**
 * Minimalny zestaw zależności herdr.
 *
 * Świadomie NIE jest to kopia implementacji z `herdr/*`: guard sprawdza tylko deny-listę
 * (bo to jest ta reguła, która ma udowodnić „400 i zero wywołań `prompt`"), a throttle liczy
 * jeden odstęp. Pełne reguły 5.4 są testowane w `herdr-commands-guard.test.ts`.
 */
export function makeDeps(seenMarks = new Map<string, FakeSeenMark>()): FakeDeps {
  const uploaded: { cwd: string; count: number }[] = [];
  const uploadedFiles: { cwd: string; names: string[] }[] = [];
  const swept: string[][] = [];
  const lastSend = new Map<string, number>();
  const aliases = new Map<string, string>();
  // Magazyn CLI w atrapie: uuid → plik, plik → `cwd` z transkryptu.
  const transcripts = new Map<string, string>([[ENGINE_SESSION, '/store/atlas.jsonl']]);
  const cwdByFile = new Map<string, string>([['/store/atlas.jsonl', PROJECT]]);
  const settingsByFile = new Map<string, ResumeSettings>();
  let now = 0;
  let refuse = false;
  const MIN_INTERVAL = 1_000; // jak `HERDR_SEND_MIN_INTERVAL_MS`
  return {
    seenMarks,
    aliases,
    transcripts,
    cwdByFile,
    settingsByFile,
    uploaded,
    uploadedFiles,
    swept,
    setNow: (ms: number) => { now = ms; },
    refuseSlots: (on: boolean) => { refuse = on; },
    sessionIdFor: (key: string) => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`,
    // Znacznik „widziane z telefonu": w atrapie mapa, w produkcji `herdr-hidden.json`.
    seen: {
      seq: (key, engine) => {
        const mark = seenMarks.get(key);
        return mark?.agentSessionId === engine && mark.unseen !== true ? mark.stateChangeSeq : undefined;
      },
      mark: (key, engine, stateChangeSeq, by) => {
        seenMarks.set(key, { agentSessionId: engine, stateChangeSeq, ...(by === undefined ? {} : { by }) });
      },
      seenBy: (key, engine) => {
        const mark = seenMarks.get(key);
        return mark?.agentSessionId === engine && mark.unseen !== true ? mark.by : undefined;
      },
      // Ręczne „nieprzeczytane": ten sam wpis z flagą, jak w `herdr-hidden.json`.
      unseenSeq: (key, engine) => {
        const mark = seenMarks.get(key);
        return mark?.agentSessionId === engine && mark.unseen === true ? mark.stateChangeSeq : undefined;
      },
      markUnseen: (key, engine, stateChangeSeq) => {
        seenMarks.set(key, { agentSessionId: engine, stateChangeSeq, unseen: true });
      },
    },
    aliasFor: (engine) => aliases.get(engine),
    rememberAlias: (engine, id) => { aliases.set(engine, id); },
    resumeSource: {
      locate: (_root, _cwd, uuid) => Promise.resolve(transcripts.get(uuid) ?? null),
      cwdOf: (file) => Promise.resolve(cwdByFile.get(file) ?? null),
      settingsOf: (file) => Promise.resolve(settingsByFile.get(file) ?? {}),
    },
    assertSendable: (text) => {
      const first = text.trimStart().split(/\s+/)[0]?.toLowerCase() ?? '';
      if (DENY.has(first)) {
        throw new BadRequestError(say('commands.refused-known.run-in-terminal', { token: first }));
      }
      return { text: text.trim(), slash: null };
    },
    takeSendSlot: (key, opts) => {
      if (refuse) return false;
      const previous = lastSend.get(key);
      if (opts?.spaced !== false && previous !== undefined && now - previous < MIN_INTERVAL) return false;
      lastSend.set(key, now);
      return true;
    },
    writeUploads: async (cwd, images) => {
      uploaded.push({ cwd, count: images.length });
      return images.map((_img, i) => `${cwd}/.rarog-uploads/1700000000-abc${String(i)}.png`);
    },
    writeUploadFiles: async (cwd, files) => {
      uploadedFiles.push({ cwd, names: files.map((f) => f.name) });
      return files.map((f, i) => `${cwd}/.rarog-uploads/1700000000-ab${String(i)}-${f.name}`);
    },
    sweepUploads: async (roots) => { swept.push([...roots]); },
  };
}

export function makeAgent(overrides: Partial<HerdrAgent> = {}): HerdrAgent {
  return {
    key: 'w9:p72',
    paneId: 'w9:p72',
    agentSessionId: ENGINE_SESSION,
    engine: 'claude',
    termId: null,
    cwd: PROJECT,
    status: 'idle',
    title: 's3-back',
    stateChangeSeq: 1,
    mode: 'auto',
    modeReadAt: 0,
    inScope: true,
    tabId: 'w9:t3',
    launchedByRarog: false,
    interactiveReady: true,
    ...overrides,
  };
}

/** Oddaje sterowanie pętli zdarzeń, żeby pompy managera przetrawiły kolejki. */
export async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}
