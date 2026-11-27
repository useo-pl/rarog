/**
 * Demo bez herdr i bez SDK — mock NADZORCY, nie mock silnika.
 *
 * Po wycięciu SDK jedyną drogą, którą sesja trafia do managera, jest `HerdrSupervisor`.
 * Gdyby demo miało własną, drugą ścieżkę, testowałoby kod, którego w produkcji nie ma —
 * a to jest dokładnie ta klasa błędu, której cały ten plan unika. Dlatego demo
 * podstawia NADZORCĘ: `attach(key)` oddaje `MockDriver` ze scenariuszem ziarna, `launch()`
 * udaje `tab.create` (razem z throttlem i sufitem paneli, żeby ścieżki 429 i 409 dało się
 * przeklikać), a `closeTab()` zdejmuje panel z listy.
 *
 * Czego tu NIE MA świadomie: gniazda, dysku, `~/.claude` i jakiegokolwiek procesu potomnego.
 * Demo ma być pokazem, a nie drugą implementacją integracji. Zdjęcia (seedów i wysłane w pokazie)
 * leżą w RAM, żeby miniatury dało się przeklikać bez `.rarog-uploads/` na dysku.
 */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { UPLOAD_IMAGE_FILE_PATTERN } from '@rarog/shared';
import type { HerdrMode, HerdrStatus } from '@rarog/shared';
import { say } from '@rarog/shared/sentences';
import { AsyncEventQueue } from '../drivers/runtime.ts';
import type { SessionDriver } from '../drivers/types.ts';
import { createMockDriverFactory } from '../drivers/mock-driver.ts';
import type { MockScenario } from '../drivers/mock-driver.ts';
import type { HerdrManagerDeps } from '../sessions/manager.ts';
import type {
  HerdrLaunchHandle, HerdrLaunchRequest, HerdrLaunchResult, HerdrLifecycleEvent, HerdrSupervisor,
} from '../herdr/types.ts';
import { HerdrError, HerdrNotOwnedError } from '../herdr/types.ts';
import type { UploadImage } from '../herdr/uploads.ts';
import { demoProjectCwd, demoSeedUploads, demoSeeds } from './seeds.ts';
import type { DemoContent } from './content/types.ts';
import { ScenarioDriver, SCENARIO_CWD } from './scenarios.ts';
import type { ScenarioPanels } from './scenarios.ts';

/** Sufit paneli w demo — niższy niż produkcyjny, żeby ścieżkę „limit" dało się pokazać. */
export const DEMO_MAX_PANES = 6;

/**
 * Free panes above the live seeds: a named set can seed more live panes than `en` and `pl` (4), and a fresh demo must
 * still let a new session start, or the new session button is dimmed. `en` and `pl` keep 6.
 */
const DEMO_FREE_PANES = 2;

/** Minimalny odstęp między zakładaniem sesji w demo (ta sama reguła co na produkcji). */
export const DEMO_LAUNCH_MIN_INTERVAL_MS = 5_000;

/** Sufit zdjęć pokazu w RAM — najstarsze wypadają (demo nie ma sprzątania po 48 h). */
export const DEMO_MAX_UPLOADS = 64;

export interface MockHerdr {
  supervisor: HerdrSupervisor;
  deps: HerdrManagerDeps;
  scenarioPanels: ScenarioPanels;
  /** Odczyt zdjęcia do miniatury (`GET …/uploads/:file`) — z RAM pokazu. */
  readUpload(cwd: string, name: string): Promise<UploadImage | null>;
  dispose(): void;
}

/** Bajty i typ z data URL-a png/jpeg (kształt sprawdził już schemat ciała wysyłki). */
function uploadFromDataUrl(dataUrl: string): UploadImage {
  const mime = dataUrl.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
  return { bytes: Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'), mime };
}

/** Panel demo: ziarno albo sesja założona w trakcie pokazu. */
interface MockPane {
  key: string;
  cwd: string;
  scenario: MockScenario;
  model?: string;
  /** Rozmowa ziarna, gdy demo pokazuje ją na liście „Wznów istniejącą” jako otwartą. */
  engineSessionId?: string;
  launchedByRarog: boolean;
  driver?: SessionDriver;
}

/**
 * Mock nadzorcy + zależności managera dla trybu demo.
 *
 * Zwracany `deps` trzyma aliasy i znaczniki `seen` W PAMIĘCI: demo nie ma prawa zostawić po
 * sobie pliku w katalogu danych.
 *
 * @param content zestaw treści demo: seedy paneli i treść tur drivera; ten sam, który dostaje manager
 */
export function createMockHerdr(content: DemoContent): MockHerdr {
  const factory = createMockDriverFactory({ content });
  const lifecycle = new AsyncEventQueue<HerdrLifecycleEvent>();
  const panes = new Map<string, MockPane>();
  const seenMarks = new Map<string, { agentSessionId: string; stateChangeSeq: number; unseen?: true }>();
  const aliases = new Map<string, string>();
  /** Zdjęcia pokazu: `<cwd>\0<nazwa>` → bajty; kolejność wstawienia = kolejność wypadania. */
  const uploads = new Map<string, UploadImage>();
  const uploadKey = (cwd: string, name: string): string => `${cwd}\u0000${name}`;
  const keepUpload = (cwd: string, name: string, dataUrl: string): void => {
    const key = uploadKey(cwd, name);
    uploads.delete(key);
    uploads.set(key, uploadFromDataUrl(dataUrl));
    for (const oldest of uploads.keys()) {
      if (uploads.size <= DEMO_MAX_UPLOADS) break;
      uploads.delete(oldest);
    }
  };
  for (const seed of demoSeedUploads(content)) keepUpload(seed.cwd, seed.file, seed.dataUrl);
  let lastLaunchAt = 0;
  let disposed = false;
  const maxPanes = Math.max(
    DEMO_MAX_PANES,
    demoSeeds(content).filter((seed) => seed.live !== undefined).length + DEMO_FREE_PANES,
  );

  // Ziarna demo są panelami „Raroga" od pierwszej sekundy — pokaz ma to samo „Zamknij
  // panel", co produkcja („×" zamyka każdy panel).
  for (const seed of demoSeeds(content)) {
    if (seed.live === undefined) continue;
    const pane: MockPane = {
      key: seed.id,
      cwd: seed.cwd,
      scenario: seed.live,
      launchedByRarog: true,
    };
    if (seed.model !== undefined) pane.model = seed.model;
    if (seed.engineSessionId !== undefined) pane.engineSessionId = seed.engineSessionId;
    panes.set(seed.id, pane);
  }

  const supervisor: HerdrSupervisor = {
    events: lifecycle,

    status(): HerdrStatus {
      return {
        available: !disposed,
        agentCount: panes.size,
        readOnly: false,
        canLaunch: !disposed && panes.size < maxPanes,
      };
    },

    attach(key: string): SessionDriver {
      const pane = panes.get(key);
      if (pane?.driver !== undefined) return pane.driver;
      // Panel, którego nie ma w mapie, to w demo pusta sesja czekająca na wiadomość —
      // ta sama semantyka co świeżo założony panel bez promptu startowego.
      const scenario: MockScenario = pane?.scenario ?? { kind: 'idle' };
      const opts = {
        cwd: pane?.cwd ?? demoProjectCwd(content, 'main'),
        ...(pane?.model !== undefined ? { model: pane.model } : {}),
        ...(pane?.engineSessionId !== undefined ? { engineSessionId: pane.engineSessionId } : {}),
      };
      return factory.startScenario(scenario, opts);
    },

    markSent(): void {
      // Karencja `idle` dotyczy detekcji EKRANOWEJ, której w demo nie ma.
    },

    ensureFreshMode(): Promise<HerdrMode> {
      // W demo tryb panelu jest znany z definicji: to my go wymyśliliśmy. `auto` (a nie
      // `unknown`) po to, żeby bramka wysyłki nie blokowała pokazu poza `RAROG_YOLO_ROOTS`.
      return Promise.resolve('auto');
    },

    focus(): Promise<void> {
      return Promise.resolve();
    },

    async launch(req: HerdrLaunchRequest): Promise<HerdrLaunchHandle> {
      const at = Date.now();
      // Te dwa bezpieczniki są w demo NIE dla bezpieczeństwa, tylko po to, żeby dało się
      // przeklikać 429 i 409 — czyli te ścieżki UI, których nikt nigdy nie testuje ręcznie.
      if (at - lastLaunchAt < DEMO_LAUNCH_MIN_INTERVAL_MS && lastLaunchAt !== 0) {
        throw new HerdrError(say('demo.launch-throttled'));
      }
      if (panes.size >= maxPanes) {
        throw new HerdrError(say('demo.pane-cap'));
      }
      lastLaunchAt = at;

      const key = `w0:d${String(panes.size + 1)}`;
      const agentSessionId = randomUUID();
      panes.set(key, {
        key,
        cwd: req.cwd,
        scenario: { kind: 'idle' },
        ...(req.model !== undefined ? { model: req.model } : {}),
        launchedByRarog: true,
      });
      const result: HerdrLaunchResult = {
        key,
        paneId: key,
        tabId: `${key}:tab`,
        agentSessionId,
        createdWorkspace: false,
        argv: ['--session-id', agentSessionId],
        // Pokaz nie ma dialogu zaufania: panel demo wstaje od razu gotowy do wysyłki.
        status: 'idle',
        interactiveReady: true,
      };
      return {
        key,
        paneId: result.paneId,
        tabId: result.tabId,
        agentSessionId,
        // Gotowość natychmiastowa: w demo nie ma czego uruchamiać, a sztuczne 5 s czekania
        // pokazywałoby stan, który w pokazie nie niesie żadnej informacji.
        ready: Promise.resolve(result),
      };
    },

    closeTab(key: string): Promise<void> {
      const pane = panes.get(key);
      // Zamykamy każdy panel, także nie założony przez Raroga —
      // parytet z produkcyjnym supervisorem. Odmowa zostaje tylko dla nieistniejącego.
      if (pane === undefined) {
        return Promise.reject(new HerdrNotOwnedError(say('demo.pane-not-found')));
      }
      panes.delete(key);
      return Promise.resolve();
    },

    rarogPaneCount(): number {
      return [...panes.values()].filter((pane) => pane.launchedByRarog).length;
    },

    liveEngineSessions(): Promise<ReadonlySet<string>> {
      return Promise.resolve(new Set());
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      lifecycle.close();
    },
  };

  const deps: HerdrManagerDeps = {
    sessionIdFor: (key) => key,
    /*
     * Znacznik „widziane z telefonu" — w RAM, jak reszta stanu demo. Pokaz ma pokazać,
     * że karta schodzi z sekcji uwagi po wejściu w sesję, a nie przeżyć restart.
     */
    seen: {
      seq: (key, agentSessionId) => {
        const mark = seenMarks.get(key);
        return mark?.agentSessionId === agentSessionId && mark.unseen !== true ? mark.stateChangeSeq : undefined;
      },
      mark: (key, agentSessionId, stateChangeSeq) => {
        seenMarks.set(key, { agentSessionId, stateChangeSeq });
      },
      // Demo has no voice agent, so no receipt has another receiver.
      seenBy: () => undefined,
      // Ręczne „nieprzeczytane": ten sam wpis z flagą, ostatnia decyzja wygrywa.
      unseenSeq: (key, agentSessionId) => {
        const mark = seenMarks.get(key);
        return mark?.agentSessionId === agentSessionId && mark.unseen === true ? mark.stateChangeSeq : undefined;
      },
      markUnseen: (key, agentSessionId, stateChangeSeq) => {
        seenMarks.set(key, { agentSessionId, stateChangeSeq, unseen: true });
      },
    },
    aliasFor: (engineSessionId) => aliases.get(engineSessionId),
    rememberAlias: (engineSessionId, sessionId) => { aliases.set(engineSessionId, sessionId); },
    // Guard demo jest CELOWO trywialny: pełne reguły mają własne testy, a pokaz ma pokazywać
    // scenariusze, nie odrzucać zdania prowadzącego przez znak sterujący w schowku.
    assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true,
    // Nazwa w kształcie `herdr/uploads.ts` (`<ms>-<16 hex>.png|jpg`): echo niesie ją w polu
    // `attachments[].file`, a klient odrzuca ramkę z nazwą spoza `UPLOAD_IMAGE_FILE_PATTERN`.
    writeUploads: (cwd, images) => Promise.resolve(
      images.map((img, i) => {
        const ext = img.startsWith('data:image/png') ? 'png' : 'jpg';
        const path = `${cwd}/.rarog-uploads/${String(Date.now())}-${String(i).padStart(16, '0')}.${ext}`;
        keepUpload(cwd, basename(path), img);
        return path;
      }),
    ),
    // Demo nie dotyka dysku, ale ścieżka MA wyglądać jak prawdziwa (z nazwą oryginalną) —
    // pokaz jest po to, żeby pokazać, co zobaczy agent, a nie żeby zobaczyć `demo-0`.
    writeUploadFiles: (cwd, files) => Promise.resolve(
      files.map((file, i) => `${cwd}/.rarog-uploads/demo-${String(i)}-${file.name}`),
    ),
    sweepUploads: () => Promise.resolve(),
  };

  // Ten sam wzorzec nazwy co `herdr/uploads.ts` — ścieżka od klienta nie wskaże niczego innego.
  const readUpload = (cwd: string, name: string): Promise<UploadImage | null> => Promise.resolve(
    UPLOAD_IMAGE_FILE_PATTERN.test(name) ? (uploads.get(uploadKey(cwd, name)) ?? null) : null,
  );

  const scenarioPanels: ScenarioPanels = {
    create(scenario, label, cwd = SCENARIO_CWD, wait) {
      const sessionId = randomUUID();
      const driver = new ScenarioDriver(scenario, label, wait);
      panes.set(sessionId, { key: sessionId, cwd, scenario: { kind: 'idle' },
        launchedByRarog: true, driver });
      // Normalna ścieżka przyłączenia panelu herdr; seedy innych sesji zostają na miejscu.
      lifecycle.push({ type: 'appeared', agent: {
        key: sessionId, paneId: sessionId, tabId: `${sessionId}:tab`,
        agentSessionId: randomUUID(), engine: 'claude', termId: null, cwd,
        status: 'idle', launchedByRarog: true, interactiveReady: true, title: label,
        stateChangeSeq: 0, mode: 'auto', modeReadAt: Date.now(), inScope: true,
      } });
      return { sessionId, driver };
    },
  };
  return { supervisor, deps, scenarioPanels, readUpload, dispose: () => { supervisor.dispose(); } };
}
