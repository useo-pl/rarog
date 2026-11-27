/**
 * WORKSPACE PROJEKTU — czysta decyzja: do którego workspace'u herdr wstawić
 * nową sesję Claude albo nowy terminal katalogu `realCwd`, a gdy do żadnego — jak nazwać nowy.
 *
 * Nie rozstrzyga pierwszy panel z `pane.cwd === cwd`: `pane.cwd` to BIEŻĄCY katalog powłoki,
 * dryfuje z każdym `cd`, więc obcy workspace wygrałby, bo ktoś zrobił w nim `cd` do projektu,
 * a sesja, która raz trafiła w złe miejsce, ściągałaby tam każdą kolejną. Workspace musi
 * najpierw być KANDYDATEM z własnej tożsamości, a dopiero potem pokazać DOWÓD ścieżki:
 *
 * 1. **Kandydat** — workspace, którego `checkoutPath` (herdr zna go dla checkoutów gita) to
 *    `realCwd`, albo workspace bez ścieżki checkoutu, którego etykieta to nazwa katalogu
 *    (`basename`, bez wielkości liter) lub nazwa, którą resolver nadaje przy kolizji
 *    (`basename (katalog nadrzędny)`). Workspace ze ścieżką checkoutu INNEGO katalogu kandydatem
 *    nie jest, nawet gdy nazywa się tak samo: to workspace innego checkoutu (np. dowiązany
 *    worktree, którego `repoRoot` to nasz katalog — jego panele leżą W naszym katalogu).
 * 2. **Dowód za** — panel z etykietą pochodzenia Raroga (`herdr/provenance.ts`) TEJ ścieżki
 *    albo ścieżki w niej (mocny) i panel bez etykiety Raroga, którego `cwd` leży w `realCwd`
 *    (słaby — `cwd` dryfuje, ale jeden panel w projekcie wystarcza). Panel z etykietą Raroga
 *    mówi wyłącznie etykietą: `cd` cudzego terminala Raroga do naszego katalogu niczego nie
 *    dowodzi. **Dowód przeciw** — panel z etykietą Raroga INNEJ ścieżki o tej samej nazwie
 *    katalogu; liczy się, gdy workspace nie ma dowodu mocnego. Panel w innym katalogu bez
 *    etykiety Raroga dowodem przeciw NIE jest.
 * 3. **Wybór** — kandydat ze ścieżką checkoutu (przy kilku: najwięcej dowodów); inaczej jedyny
 *    kandydat z dowodem za i bez dowodu przeciw; przy kilku — najwięcej dowodów. **Remis**
 *    rozstrzyga NAJNOWSZY workspace, który ten proces sam założył dla projektu (`createdHere`),
 *    o ile nadal jest kandydatem z dowodem — inaczej przy checkoucie pierwszy z listy herdr
 *    (każdy z nich JEST tym katalogiem), a przy etykiecie brak wyboru (`null`). Bez tego remis
 *    starych duplikatów (2:2) zakładał przy KAŻDYM starcie kolejny workspace.
 * 4. **Brak wyboru** → wołający zakłada nowy workspace o nazwie {@link newProjectWorkspaceLabel}.
 *
 * Etykiety pochodzenia niosą hashe, nie ścieżki, więc „etykieta ścieżki P" sprawdzamy, licząc
 * hash kandydatów ({@link findLabelOwner}). Wołający (`herdr/project-workspace.ts`) próbuje przy
 * tym KAŻDEJ znanej pisowni — katalog projektu tak, jak go podano, katalog powstania z pliku stanu
 * terminala, `cwd` panelu z herdr przed i po `realpath` z przodkami — i dopiero znalezionego
 * właściciela sprowadza `realpath`em do pisowni z dysku (`ResolverPane.labelOwner`). Powód: na
 * macOS `…/RAROG` i `…/rarog` to ten sam katalog, a hash jest czuły na litery.
 * Panel, który zdryfował POZA swój projekt, zostaje bez rozpoznanej ścieżki — neutralny.
 *
 * Moduł nie dotyka dysku: wszystkie ścieżki (`realCwd`, `cwd` paneli, `checkoutPath`, właściciel
 * etykiety) przychodzą już po `realpath`, liczonym asynchronicznie przez wołającego.
 */
import path from 'node:path';
import { matchTermId } from '../term/lifecycle.ts';
import { claudeKeyMatches, parsePaneLabel, provenanceTermId, sanitizePaneTitle } from './provenance.ts';
import type { PaneProvenance } from './provenance.ts';
import type { HerdrPaneInfo, HerdrWorkspaceInfo } from './types.ts';

/** Panel widziany przez resolver; `cwd` MUSI być po `realpath`. */
export type ResolverPane = Pick<HerdrPaneInfo, 'paneId' | 'workspaceId' | 'cwd' | 'label'> & {
  /**
   * Katalog (po `realpath`), dla którego Rarog nadał etykietę panelu; `null` — etykieta Raroga,
   * ale jej katalogu nie ustalono. Liczy go wołający z każdej znanej pisowni ({@link findLabelOwner}).
   * Brak pola = resolver szuka sam od `realCwd` i od `cwd` panelu w górę, w jednej pisowni.
   */
  readonly labelOwner?: string | null;
};

export interface ResolveProjectWorkspaceInput {
  /** `workspace.list`; `checkoutPath` MUSI być po `realpath`. */
  readonly workspaces: readonly HerdrWorkspaceInfo[];
  readonly panes: readonly ResolverPane[];
  /** Katalog projektu po `realpath`. */
  readonly realCwd: string;
  /**
   * Workspace'y, które TEN proces sam założył dla `realCwd`, od najstarszego — most do chwili,
   * w której herdr pokaże w nim panel z etykietą albo `cwd` (launcher nadaje etykietę dopiero po
   * `agent.start`), i rozstrzygnięcie remisu (najnowszy wygrywa). Każdy liczy się jak jeden dowód
   * mocny, ale tylko u kandydata (przemianowany przez człowieka kandydatem już nie jest).
   */
  readonly createdHere?: readonly string[];
}

/** Bilans dowodów jednego kandydata. */
export interface WorkspaceEvidence {
  readonly workspaceId: string;
  /** Kandydat z racji ścieżki checkoutu (a nie etykiety). */
  readonly checkout: boolean;
  /** Panele z etykietą Raroga tej ścieżki (albo ścieżki w niej) + założony przez ten proces. */
  readonly strong: number;
  /** Panele bez etykiety Raroga, których `cwd` leży w projekcie. */
  readonly weak: number;
  /** Panele z etykietą Raroga INNEJ ścieżki o tej samej nazwie katalogu. */
  readonly against: number;
}

export interface ProjectWorkspaceChoice {
  readonly workspaceId: string;
  /** `checkout` — ścieżka checkoutu z herdr; `evidence` — kandydat po etykiecie z dowodem. */
  readonly via: 'checkout' | 'evidence';
}

/** `child` to `parent` albo ścieżka w nim (po separatorze — `/a/apix` NIE leży w `/a/api`). */
export function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child.startsWith(prefix);
}

/** Etykieta pochodzenia jest etykietą Raroga dla katalogu `dir` (hash z tej ścieżki). */
function labelBelongsTo(provenance: PaneProvenance, dir: string): boolean {
  if (provenance.kind === 'claude') return claudeKeyMatches(provenance, dir);
  const id = provenanceTermId(provenance);
  return id !== null && matchTermId(id, dir) !== null;
}

/**
 * Katalog, dla którego Rarog nadał tę etykietę, szukany od `cwd` panelu w górę — albo `null`.
 *
 * Hash jest jednokierunkowy, więc jedyną drogą jest próba kandydatów: `cwd` panelu i każdy jego
 * przodek. Trafia, gdy panel stoi w swoim projekcie albo w jego podkatalogu; panel, który
 * zdryfował poza projekt, zostaje bez odpowiedzi (`null` = „nie wiem czyj", nie „cudzy").
 */
export function rarogLabelOwner(provenance: PaneProvenance, paneRealCwd: string): string | null {
  let dir = paneRealCwd;
  for (;;) {
    if (labelBelongsTo(provenance, dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Katalog etykiety w pisowni, z której Rarog policzył jej hash, albo `null`.
 *
 * `exact` — pisownie sprawdzane wprost (katalog projektu tak, jak go podano; katalog powstania
 * terminala z pliku stanu), `walk` — sprawdzane razem z przodkami (`cwd` panelu z herdr, przed
 * i po `realpath`). Wynik jest w pisowni ŹRÓDŁA — porównanie z katalogiem projektu wymaga jeszcze
 * `realpath` (robi to wołający).
 */
export function findLabelOwner(
  provenance: PaneProvenance,
  spellings: { readonly exact: readonly string[]; readonly walk: readonly string[] },
): string | null {
  for (const dir of spellings.exact) if (labelBelongsTo(provenance, dir)) return dir;
  for (const dir of spellings.walk) {
    const owner = rarogLabelOwner(provenance, dir);
    if (owner !== null) return owner;
  }
  return null;
}

/** Ta sama nazwa katalogu, bez wielkości liter. */
function sameBasename(a: string, b: string): boolean {
  return path.basename(a).toLowerCase() === path.basename(b).toLowerCase();
}

type PaneVerdict = 'strong' | 'weak' | 'against' | null;

/** Co jeden panel mówi o tym, czy jego workspace jest workspace'em `realCwd`. */
function paneVerdict(pane: ResolverPane, realCwd: string): PaneVerdict {
  const provenance = parsePaneLabel(pane.label);
  if (provenance === null) return isWithin(pane.cwd, realCwd) ? 'weak' : null;
  const owner = pane.labelOwner !== undefined
    ? pane.labelOwner
    : findLabelOwner(provenance, { exact: [realCwd], walk: [pane.cwd] });
  if (owner === null) return null;
  if (isWithin(owner, realCwd)) return 'strong';
  return sameBasename(owner, realCwd) ? 'against' : null;
}

/** Etykieta do porównań: to samo czyszczenie co przy nadawaniu, bez wielkości liter. */
function labelKey(label: string): string {
  return sanitizePaneTitle(label, '').toLowerCase();
}

/**
 * Dwie nazwy workspace'u projektu: `basename` i `basename (katalog nadrzędny)` — ta druga nadawana
 * przy kolizji (dwa projekty `api` w różnych korzeniach). Obie po tym samym czyszczeniu co tytuł
 * panelu (bez znaków sterujących, ≤ 64 znaki), bo herdr etykiet nie normalizuje.
 */
export function projectWorkspaceLabels(realCwd: string): { primary: string; alternate: string } {
  const primary = sanitizePaneTitle(path.basename(realCwd), realCwd);
  const parent = sanitizePaneTitle(path.basename(path.dirname(realCwd)), path.sep);
  return { primary, alternate: sanitizePaneTitle(`${primary} (${parent})`, primary) };
}

/**
 * Nazwa NOWEGO workspace'u projektu: `basename`, a gdy tę nosi już jakiś workspace —
 * `basename (katalog nadrzędny)`. „Zajęta" znaczy „nosi ją workspace, którego resolver nie
 * wybrał", czyli bez dowodu, że jest nasz — drugi workspace o tej samej nazwie w sidebarze herdr
 * byłby nie do rozróżnienia. Gdy zajęte są obie, zostaje druga: dowody i tak rozstrzygną, który
 * jest czyj, a licznik w nazwie byłby trzecią nazwą do rozpoznawania.
 */
export function newProjectWorkspaceLabel(
  workspaces: readonly HerdrWorkspaceInfo[], realCwd: string,
): string {
  const { primary, alternate } = projectWorkspaceLabels(realCwd);
  const taken = workspaces.some((workspace) => labelKey(workspace.label) === labelKey(primary));
  return taken ? alternate : primary;
}

/**
 * Czy workspace jest KANDYDATEM katalogu `realCwd` (nagłówek modułu, pkt 1): `checkout` — po
 * ścieżce checkoutu, `label` — po nazwie, `null` — nie jest. `checkoutPath` MUSI być po `realpath`.
 */
export function projectWorkspaceCandidacy(
  workspace: HerdrWorkspaceInfo, realCwd: string,
): 'checkout' | 'label' | null {
  if (workspace.checkoutPath !== undefined) {
    return workspace.checkoutPath === realCwd ? 'checkout' : null;
  }
  const { primary, alternate } = projectWorkspaceLabels(realCwd);
  const key = labelKey(workspace.label);
  return key === labelKey(primary) || key === labelKey(alternate) ? 'label' : null;
}

/** Bilans dowodów KAŻDEGO kandydata, w kolejności listy herdr (rozstrzyga remis checkoutu). */
export function scoreProjectWorkspaces(input: ResolveProjectWorkspaceInput): WorkspaceEvidence[] {
  const { realCwd } = input;
  const out: WorkspaceEvidence[] = [];
  for (const workspace of input.workspaces) {
    const candidacy = projectWorkspaceCandidacy(workspace, realCwd);
    if (candidacy === null) continue;
    const checkout = candidacy === 'checkout';
    let strong = input.createdHere?.includes(workspace.workspaceId) === true ? 1 : 0;
    let weak = 0;
    let against = 0;
    for (const pane of input.panes) {
      if (pane.workspaceId !== workspace.workspaceId) continue;
      const verdict = paneVerdict(pane, realCwd);
      if (verdict === 'strong') strong += 1;
      else if (verdict === 'weak') weak += 1;
      else if (verdict === 'against') against += 1;
    }
    out.push({ workspaceId: workspace.workspaceId, checkout, strong, weak, against });
  }
  return out;
}

const total = (evidence: WorkspaceEvidence): number => evidence.strong + evidence.weak;

/**
 * Jedyny lider według liczby dowodów; przy remisie — NAJNOWSZY workspace z `createdHere` spośród
 * `pool` (nie tylko spośród remisujących: założony przed chwilą, którego panelu herdr jeszcze
 * nie pokazał, ma mniej dowodów niż stare duplikaty, a to on ma wygrać); bez niego `null`.
 */
function pickLeader(
  pool: readonly WorkspaceEvidence[], createdHere: readonly string[],
): WorkspaceEvidence | null {
  if (pool.length === 0) return null;
  const top = Math.max(...pool.map(total));
  const leaders = pool.filter((evidence) => total(evidence) === top);
  if (leaders.length === 1) return leaders[0] ?? null;
  for (let i = createdHere.length - 1; i >= 0; i -= 1) {
    const mine = pool.find((evidence) => evidence.workspaceId === createdHere[i]);
    if (mine !== undefined) return mine;
  }
  return null;
}

/**
 * Workspace projektu `realCwd` albo `null` (= załóż nowy). Reguły — nagłówek modułu.
 */
export function resolveProjectWorkspace(
  input: ResolveProjectWorkspaceInput,
): ProjectWorkspaceChoice | null {
  const scored = scoreProjectWorkspaces(input);
  const createdHere = input.createdHere ?? [];

  // Ścieżka checkoutu to zapis herdr „ten workspace JEST tym katalogiem" — dowód sam w sobie.
  // Remis bez rozstrzygnięcia z pamięci bierze pierwszy z listy herdr (stała między odczytami):
  // każdy z nich jest poprawny, a `null` zakładałby jeszcze jeden z tym samym checkoutem.
  const checkouts = scored.filter((evidence) => evidence.checkout);
  if (checkouts.length > 0) {
    const best = pickLeader(checkouts, createdHere)
      ?? checkouts.find((evidence) => total(evidence) === Math.max(...checkouts.map(total)));
    if (best !== undefined) return { workspaceId: best.workspaceId, via: 'checkout' };
  }

  // Dowód przeciw liczy się wyłącznie bez dowodu mocnego: nasz panel z etykietą Raroga przeważa
  // nad cudzym, ale sam `cwd` (słaby) nie przeważa nad etykietą Raroga innego projektu.
  const eligible = scored.filter(
    (evidence) => evidence.strong > 0 || (evidence.weak > 0 && evidence.against === 0),
  );
  const leader = pickLeader(eligible, createdHere);
  return leader === null ? null : { workspaceId: leader.workspaceId, via: 'evidence' };
}
