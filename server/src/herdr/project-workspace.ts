/**
 * Workspace projektu w herdr — ZAMEK projektu i odczyt, na którym stoi decyzja resolvera.
 *
 * Czysta decyzja mieszka w `workspace-resolver.ts`; tu jest to, czego czysta funkcja zrobić nie
 * może: `workspace.list` + `pane.list`, `realpath` każdej ścieżki z herdr i procesowy zamek, pod
 * którym wołający wybiera ORAZ zakłada (`tab.create`/`workspace.create`).
 *
 * **Zamek projektu** ({@link ProjectPlacement.withProjectLock}) jest JEDEN na proces serwera
 * ({@link sharedProjectPlacement}) i wspólny dla launchera agentów (`launcher.ts`) i backendu
 * terminala (`term/herdr-backend.ts`). Bez niego pierwsze równoczesne założenie dwóch rzeczy
 * jednego projektu (dwa sloty terminala; Claude i terminal) widziało dwa razy „brak workspace'u"
 * i zakładało dwa. Klucz to `realpath` katalogu, więc dwie drogi do tego samego katalogu dzielą
 * zamek; różne projekty nie czekają na siebie.
 *
 * **Kolejność zamków (wiążąca, bez zakleszczeń):** backend terminala bierze najpierw swój mutex
 * `exclusive` (zakładanie i odzyskiwanie terminali), a W NIM zamek projektu; launcher bierze
 * wyłącznie zamek projektu; przebieg `reconcile` — wyłącznie `exclusive`. Nikt nie czeka na
 * `exclusive`, trzymając zamek projektu, więc cyklu nie ma. Pod zamkiem projektu idą tylko
 * odczyty i zapisy gniazda z jego limitem czasu (bez `agent.start` i bez czekania na gotowość),
 * więc zamek nie wisi dłużej niż kilka RPC.
 *
 * **Pamięć „założyłem"** ({@link ProjectPlacement.remember}) — workspace'y, które ten proces sam
 * założył dla katalogu. Most do chwili, w której herdr pokaże w nim dowód (launcher nadaje
 * etykietę pochodzenia panelu dopiero po `agent.start`, poza zamkiem): kolejna rzecz tego
 * projektu trafia do tego samego workspace'u także wtedy, gdy `cwd` nowego panelu jeszcze nie
 * doszło — i ROZSTRZYGNIĘCIE REMISU: przy równej liczbie dowodów wygrywa najnowszy workspace
 * założony przez ten proces (stare duplikaty 2:2 nie zakładają przy każdym starcie kolejnego).
 * Żyje w RAM do restartu Raroga; po nim rozstrzygają już etykiety paneli.
 *
 * **Pisownie (macOS):** etykieta pochodzenia to hash ścieżki w KONKRETNEJ pisowni,
 * a `…/RAROG` i `…/rarog` to na macOS ten sam katalog. Dlatego właściciela etykiety szukamy
 * w każdej znanej pisowni (katalog podany przez wołającego, katalog powstania terminala z pliku
 * stanu, `cwd` panelu z herdr przed i po `realpath`), a dopiero znalezionego sprowadzamy
 * `realpath`em do pisowni z dysku i porównujemy z katalogiem projektu.
 */
import { parsePaneLabel, realProjectPath } from './provenance.ts';
import {
  findLabelOwner, newProjectWorkspaceLabel, projectWorkspaceCandidacy, resolveProjectWorkspace,
} from './workspace-resolver.ts';
import type { ResolverPane } from './workspace-resolver.ts';
import type { HerdrLaunchClient, HerdrPaneInfo, HerdrWorkspaceInfo } from './types.ts';

export interface ProjectPlacement {
  /** Zadanie pod zamkiem katalogu `realCwd` — zadania jednego katalogu idą jedno po drugim. */
  withProjectLock<T>(realCwd: string, task: () => Promise<T>): Promise<T>;
  /** Ten proces założył `workspaceId` dla `realCwd` (wołać pod zamkiem, zaraz po założeniu). */
  remember(realCwd: string, workspaceId: string): void;
  /** Workspace'y, które ten proces założył dla `realCwd`, od najstarszego do najnowszego. */
  createdHere(realCwd: string): readonly string[];
}

/**
 * Nowy, niezależny zamek z pamięcią — produkcja używa {@link sharedProjectPlacement}, testy
 * własnych (pamięć „założyłem" z jednego testu nie ma prawa przeciekać do drugiego).
 */
export function createProjectPlacement(): ProjectPlacement {
  /** Ogon kolejki zadań katalogu; obietnica, która nigdy nie odrzuca. */
  const tails = new Map<string, Promise<void>>();
  const created = new Map<string, string[]>();
  return {
    async withProjectLock<T>(realCwd: string, task: () => Promise<T>): Promise<T> {
      const previous = tails.get(realCwd) ?? Promise.resolve();
      const run = previous.then(task);
      const tail = run.then(() => undefined, () => undefined);
      tails.set(realCwd, tail);
      try {
        return await run;
      } finally {
        // Wpis znika, gdy nikt nie ustawił się za nami — mapa nie rośnie z każdym katalogiem.
        if (tails.get(realCwd) === tail) tails.delete(realCwd);
      }
    },
    remember(realCwd: string, workspaceId: string): void {
      if (workspaceId === '') return;
      const ids = (created.get(realCwd) ?? []).filter((id) => id !== workspaceId);
      ids.push(workspaceId);
      created.set(realCwd, ids);
    },
    createdHere(realCwd: string): readonly string[] {
      return [...(created.get(realCwd) ?? [])];
    },
  };
}

/** JEDEN zamek na proces serwera — wspólny dla launchera i backendu terminala. */
export const sharedProjectPlacement: ProjectPlacement = createProjectPlacement();

/** Zamek projektu procesu serwera (skrót do {@link sharedProjectPlacement}). */
export function withProjectLock<T>(realCwd: string, task: () => Promise<T>): Promise<T> {
  return sharedProjectPlacement.withProjectLock(realCwd, task);
}

/** Decyzja: istniejący workspace albo nowy z podaną etykietą. */
export type ProjectWorkspaceDecision =
  | { readonly kind: 'existing'; readonly workspaceId: string; readonly via: 'checkout' | 'evidence' }
  | { readonly kind: 'new'; readonly label: string };

export interface DecideProjectWorkspaceParams {
  readonly client: Pick<HerdrLaunchClient, 'listWorkspaces' | 'listPanes'>;
  /** Katalog projektu po `realpath`. */
  readonly realCwd: string;
  readonly placement: ProjectPlacement;
  /**
   * `pane.list` przeczytany już POD TYM SAMYM zamkiem (backend terminala sprawdza na nim własny
   * panel) — bez drugiego odczytu. Nieobecny = świeży odczyt tutaj.
   */
  readonly panes?: readonly HerdrPaneInfo[];
  /**
   * Katalog projektu w pisowni wołającego (launcher: z żądania; terminal: z rejestru) — gdy różni
   * się od `realCwd` wielkością liter, w niej mogła zostać policzona etykieta panelu.
   */
  readonly spellings?: readonly string[];
  /**
   * Katalog powstania panelu z pliku stanu terminala (`term-herdr.json`), po `paneId` — pisownia,
   * z której policzono tożsamość terminala, także gdy jego powłoka zrobiła potem `cd`.
   */
  readonly ownerHints?: ReadonlyMap<string, string>;
  /** `realpath` — wstrzykiwany w testach; domyślnie {@link realProjectPath}. */
  readonly resolvePath?: (dir: string) => Promise<string>;
}

/**
 * Odczyt herdr → `realpath` ścieżek → resolver. Wołać POD {@link ProjectPlacement.withProjectLock}
 * tego samego `realCwd`, razem z zakładaniem — inaczej dwa równoległe wywołania zobaczą ten sam
 * „brak workspace'u".
 */
export async function decideProjectWorkspace(
  params: DecideProjectWorkspaceParams,
): Promise<ProjectWorkspaceDecision> {
  const { client, realCwd, placement } = params;
  const resolvePath = params.resolvePath ?? realProjectPath;
  const workspaces = await client.listWorkspaces();
  const panes = params.panes ?? await client.listPanes();

  // Wiele paneli stoi w tym samym katalogu — każdy `realpath` raz na decyzję.
  const cache = new Map<string, Promise<string>>();
  const real = (dir: string): Promise<string> => {
    let hit = cache.get(dir);
    if (hit === undefined) {
      hit = resolvePath(dir);
      cache.set(dir, hit);
    }
    return hit;
  };
  const realWorkspaces: HerdrWorkspaceInfo[] = await Promise.all(workspaces.map(async (ws) => ({
    workspaceId: ws.workspaceId,
    label: ws.label,
    ...(ws.checkoutPath === undefined ? {} : { checkoutPath: await real(ws.checkoutPath) }),
    ...(ws.repoRoot === undefined ? {} : { repoRoot: await real(ws.repoRoot) }),
  })));
  // Etykiety czytamy tylko u kandydatów — reszta paneli nie wpływa na decyzję.
  const candidates = new Set(realWorkspaces
    .filter((ws) => projectWorkspaceCandidacy(ws, realCwd) !== null)
    .map((ws) => ws.workspaceId));
  const exact = [...new Set([realCwd, ...(params.spellings ?? [])])];
  const realPanes: ResolverPane[] = await Promise.all(panes
    .filter((pane) => candidates.has(pane.workspaceId))
    .map(async (pane): Promise<ResolverPane> => {
      const paneReal = await real(pane.cwd);
      const base = { paneId: pane.paneId, workspaceId: pane.workspaceId, label: pane.label, cwd: paneReal };
      const provenance = parsePaneLabel(pane.label);
      if (provenance === null) return base;
      const hint = params.ownerHints?.get(pane.paneId);
      const owner = findLabelOwner(provenance, {
        exact: hint === undefined || hint === '' ? exact : [hint, ...exact],
        walk: [...new Set([pane.cwd, paneReal])],
      });
      return { ...base, labelOwner: owner === null ? null : await real(owner) };
    }));

  const chosen = resolveProjectWorkspace({
    workspaces: realWorkspaces, panes: realPanes, realCwd, createdHere: placement.createdHere(realCwd),
  });
  if (chosen !== null) return { kind: 'existing', workspaceId: chosen.workspaceId, via: chosen.via };
  return { kind: 'new', label: newProjectWorkspaceLabel(workspaces, realCwd) };
}
