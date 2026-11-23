/**
 * Terminal PTY — backend panelowy: trwałość powłoki na PANELU herdr.
 *
 * JEDYNY backend terminala: powłoka mieszka w tabie, który widać na Macu, a
 * transportem jest proces `herdr terminal session control <pane> --takeover` (NDJSON w obie
 * strony). Pomiary, na których stoi ta decyzja: opóźnienie p50 23 ms, tryby DECSET
 * przechodzą, JEDEN kontroler naraz.
 *
 * Trzy rzeczy są tu WIĄŻĄCE i każda ma powód:
 *
 * 1. **Terminal NIE stoi poza herdr.** Zakładanie panelu to władza
 *    „launch" (`RAROG_HERDR_LAUNCH`), a stemplowanie i zamykanie — władza „send"
 *    (`RAROG_HERDR_SEND`). Oba killswitche odmawiają TUTAJ, przed `POST /api/term`, żeby
 *    człowiek dostał zdanie zamiast zerwanego gniazda WS.
 * 2. **Cudzego panelu nie wolno ani zamknąć, ani PRZEJĄĆ.** Obie drogi (`pane.close` oraz
 *    spawn kontrolera z `--takeover`) pytają najpierw ŚWIEŻY `pane.list`, czy panel spod
 *    tego adresu nosi token `rarog-term` o WARTOŚCI równej tożsamości tego terminala.
 *    Adresy paneli herdr są pozycyjne (`w15:p1`), a uchwyt żyje w rejestrze do restartu
 *    Raroga — sama obecność tokenu broniłaby tylko przed panelem człowieka, nie przed
 *    powłoką innego projektu.
 * 3. **Zero logowania treści.** Bajty ekranu przechodzą przez ten moduł do gniazd WS i nie
 *    trafiają ani do logu, ani do pliku stanu. Na dysku zostaje jeden plik z samymi
 *    identyfikatorami paneli, ich katalogami i znacznikiem czasu (`term-herdr.json`).
 * 4. **Pochodzenie panelu = jego ETYKIETA `rarog-term <id>`, władza = token.** Token
 *    `rarog-term` ginie przy restarcie serwera herdr, etykieta panelu (`pane.rename`) — nie, bo
 *    herdr trzyma ją w snapshotcie. `reconcile()` przywraca token panelom z etykietą (jeden
 *    przebieg naraz, wspólny mutex z zakładaniem), niczego przy tym nie zamyka, a niepewny wynik
 *    znaczy odmowę zamiast drugiego taba obok. The label leads with the tab label
 *    (`<tab label> · rarog-term <id>`), so herdr's Go-to names the pane like its tab.
 * 5. **Etykieta TABA to slot albo rola plus katalog** (`rarog 1 · rarog`) — przy
 *    zakładaniu i, dla tabów w starym formacie, przy migracji w `reconcile`. Tylko tab jednopanelowy
 *    z naszym panelem i etykietą „1” z `workspace.create`; nazwa nadana ręcznie zostaje
 *    (`RAROG_HERDR_TAB_LABELS=0` gasi migrację).
 */
import { spawn as spawnChild } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TERM_ID_RE, TERM_PROC_MAX_LENGTH } from '@rarog/shared';
import { type OwnText, say } from '@rarog/shared/sentences';
import type { ServerSystem } from '@rarog/shared/rest';
import { redact } from '../auth/index.ts';
import { RAROG_TERM_PANE_TOKEN, termPaneTokenOf } from '../config.ts';
import type { RarogConfig } from '../config.ts';
import { decideProjectWorkspace, sharedProjectPlacement } from '../herdr/project-workspace.ts';
import type { ProjectPlacement } from '../herdr/project-workspace.ts';
import {
  parsePaneLabel, realProjectPath, termPaneLabel, terminalTabLabel,
} from '../herdr/provenance.ts';
import { HerdrUnavailableError } from '../herdr/socket.ts';
import { HerdrReadOnlyError, isBareShellForeground } from '../herdr/types.ts';
import type {
  HerdrLaunchClient, HerdrPaneInfo, HerdrPaneLayout, HerdrPaneProcess, HerdrTabInfo,
} from '../herdr/types.ts';
import { matchTermId } from './lifecycle.ts';
import type { Logger } from '../router.ts';
import { serverSystem } from '../version.ts';
import { TermBackendRetryError, TermHandleStaleError } from './backend.ts';
import type {
  TermBackend, TermBackendRefusal, TermBackendSession, TermEnsureOptions, TermHistory,
  TermReconcileResult, TermReleaseOptions, TermSessionHandle, TermSessionRole, TermStream,
  TermStreamExit, TermStreamOptions,
} from './backend.ts';
import { createHerdrStreamReader } from './herdr-stream.ts';

/**
 * Klucz w `tokens` panelu; wartością jest IDENTYFIKATOR terminala (`termIdFor(realpath(cwd),
 * slot)`).
 *
 * To jest jedyny ślad po numerze taba, jaki przeżywa restart Raroga — adopcja odzyskuje go,
 * próbując kolejnych slotów przeciwko tej wartości (`term/index.ts`).
 *
 * Jedyny token, jaki Rarog stawia na panelach: panele z agentem `claude` tokenu nie mają
 * (własność = nazwa agenta, pochodzenie = etykieta panelu). Ten niesie tożsamość
 * konkretnego terminala, a nie samo „mój panel", i to on jest bramką `pane.close` oraz kluczem
 * adopcji po restarcie Raroga.
 *
 * Sam literał mieszka w `config.ts` ({@link RAROG_TERM_PANE_TOKEN}), bo czyta go też
 * filtr wejściowy herdr (rozpoznanie Codexa uruchomionego w terminalu Raroga), a fasada
 * gniazda nie ma prawa importować modułu terminala. Nazwa lokalna zostaje — jest w użyciu
 * w całym module i to ona opisuje rolę tokenu po TEJ stronie.
 */
export const RAROG_TERM_TOKEN = RAROG_TERM_PANE_TOKEN;

/** `source` metadanych panelu — herdr pokazuje je przy panelu, więc mówi, kto stemplował. */
export const RAROG_TERM_METADATA_SOURCE = 'rarog-term';

/**
 * Etykiety tabów, które migracja wolno przemianować: „1", które `workspace.create` nadaje
 * pierwszemu tabowi. Tab terminala dostaje `rarog <slot> · <katalog>` /
 * `rarog lazygit · <katalog>` / `rarog popup · <katalog>` (`terminalTabLabel` w `herdr/provenance.ts`).
 * Każda INNA etykieta przy naszym panelu = nazwa nadana ręcznie, nietknięta.
 */
export const LEGACY_TERM_TAB_LABELS: ReadonlySet<string> = new Set(['1']);

/**
 * Znacznik dla POWŁOKI panelu: „ten terminal otwarto z Raroga".
 *
 * Istnieje po to, żeby konfiguracja powłoki mogła zachować się inaczej na telefonie niż przy
 * biurku — konkretny powód jest zmierzony: prompt, który dociąga wiersz do prawej
 * krawędzi (p10k z prawą stroną), po każdym ZWĘŻENIU panelu zostawia w historii swoją kopię
 * („schodek"). Rarog nie ma jak tego zwężenia uniknąć — herdr dopasowuje panel do kontrolera
 * przy każdym podłączeniu — a jedyne, co usuwa objaw u źródła, to prompt nie wypełniający
 * wiersza (zmierzone: `POWERLEVEL9K_RIGHT_PROMPT_ELEMENTS=()` → czysto nawet przy 120→40).
 *
 * Rarog **niczego nie narzuca i nie pisze do `~/.zshrc` ani `~/.p10k.zsh`** — oddaje
 * powłoce jedną informację, a decyzja, czy i jak jej użyć, należy do człowieka:
 *
 *     [[ -n $RAROG_TERM_PANE ]] && typeset -g POWERLEVEL9K_RIGHT_PROMPT_ELEMENTS=()
 *
 * Wartość jest STAŁA i jawna (`1`) — to znacznik, nie kanał na cokolwiek poufnego. Sekrety
 * Raroga nie wchodzą w stronę terminala i pilnuje tego osobny test kontraktowy
 * (`TERM_ENV_PASSTHROUGH`, `docs/security-model.md` punkt 6).
 */
export const RAROG_TERM_PANE_ENV: Readonly<Record<string, string>> = { RAROG_TERM_PANE: '1' };

/**
 * Plik ze stanem terminali panelowych: `{ "<pane_id>": { "seen": ms, "cwd": "…" } }`.
 *
 * Istnieje, bo herdr NIE ma znacznika aktywności panelu, a żniwiarz bezczynności potrzebuje
 * wieku. Panel z naszym tokenem NIEOBECNY w pliku (czysty `dataDir` po reinstalacji) dostaje
 * `now` i liczy czas od zera — nigdy „nieznany = do żniw".
 *
 * Drugie zadanie to KATALOG: `pane.list` oddaje bieżący `cwd` powłoki, więc po `cd` w
 * terminalu nie da się z niego odtworzyć katalogu, z którego terminal powstał (a to on jest
 * wejściem hasha tożsamości). Zapisujemy więc własny.
 */
export const TERM_HERDR_STATE_FILENAME = 'term-herdr.json';

/**
 * `reason` z `terminal.closed`, po którym respawnu NIE MA.
 *
 * herdr dopuszcza JEDEN kontroler panelu: drugi z `--takeover` wyrzuca pierwszego. Gdyby
 * Rarog ponawiał, dwa Rarogi (albo Rarog i człowiek przy Macu) biłyby się o panel w pętli
 * — dlatego przejęcie kładzie wpis w `failed` i czeka na decyzję człowieka.
 */
const TAKEOVER_RE = /taken\s*over|takeover/i;

/*
 * Zdania odmów `ensureSession` jadą do człowieka ramką `err` przez `TermBackendRetryError`, więc mówią, co
 * zrobić, a nie co się stało w gnieździe. Kody: `term.recovering` (panel z etykietą tego terminala jest, a jego token
 * nie wrócił: drugi tab byłby duplikatem), `term.label-conflict.mac`/`.vps` (etykieta przy panelu z innym tokenem
 * albo przy kilku panelach naraz), `term.lazygit-changed` i `term.lazygit-close-failed`, a z bramki mutacji
 * (`assertMayMutate`) zdania `refusal()`: `term.needs-launch` i `term.needs-send`.
 */

/**
 * Frazy linii logu o panelach terminala, które backend zakłada i zamyka w herdr: ich ślad jest wyłącznie
 * w `server.log`, bo `herdr-audit.log` zapisuje tylko supervisor (`docs/security-model.md`). Nowy tab:
 * `term: new tab <tab> in workspace <workspace> (<droga>, cwd=…)`.
 */
export const TERM_NEW_TAB_LOG = 'term: new tab';
/** Fraza linii o nowym workspace terminala: `term: new workspace <id> "<etykieta>" (cwd=…)`. */
export const TERM_NEW_WORKSPACE_LOG = 'term: new workspace';
/** Fraza linii o nieudanym zamknięciu gołej powłoki w panelu lazygita. */
export const TERM_LAZYGIT_CLOSE_FAILED_LOG = 'term: closing lazygit pane';

/** Ile czekamy po `terminal.release`, zanim ubijemy kontrolera siłą. */
export const HERDR_RELEASE_KILL_MS = 2_000;

/**
 * Sufit odczytu układu taba (`pane.layout`) przed zwolnieniem po karencji. Odczyt trwa milisekundy
 * (`pane get` mediana 4–5 ms); sufit jest po to, żeby wolne albo martwe gniazdo
 * herdr nigdy nie zatrzymało zwolnienia — po nim `terminal.release` idzie bez przywrócenia.
 */
export const HERDR_RESTORE_READ_MS = 1_000;

/** Rozmiar pty panelu w komórkach. */
export interface TermPaneSize {
  readonly cols: number;
  readonly rows: number;
}

/**
 * Rozmiar, jaki panel dostałby od herdr bez kontrolera Raroga, wyliczony z układu taba — albo
 * POWÓD, dla którego go nie liczymy.
 *
 * Wzór jest wzorem herdr 0.9.5, nie zgadywanką: pty panelu to jego prostokąt z układu
 * (`pane.layout` liczy go tą samą funkcją co widok, `apply_pane_chrome` na obszarze ostatniego
 * widoku) minus obramowanie (w tabie jednopanelowym zero, punkt niżej) i minus jedna kolumna rynny
 * paska przewijania (`terminal_inner_rect_for` w `src/ui/panes.rs`: `pane_scrollbars` domyślnie
 * włączone, rynny nie ma przy szerokości ≤ 4).
 * Zmierzone na świeżym panelu: prostokąt 128×52 → pty 127×52 (`stty -f` na tty powłoki).
 *
 * Granice wzoru, wszystkie świadome:
 * - **Tylko tab jednopanelowy.** Domyślne `pane_borders = "auto"` rysuje obramowanie dopiero przy
 *   podziale, a jego kształt zależy od sąsiadów i konfiguracji; taby terminala Rarog zakłada
 *   jednopanelowe, a tab podzielony przy biurku ma zwykle klienta herdr, który przywraca rozmiar
 *   sam. Split = powód, rozmiar zostaje taki, jak zostawiłby go herdr.
 * - **Rynna zawsze.** Herdr jej nie odejmuje panelowi na ekranie alternatywnym (lazygit, nvim),
 *   a tego Rarog nie widzi. Węższa o kolumnę strona jest bezpieczniejsza: gdy klient herdr później
 *   poszerzy panel, prompt nie zostawia kopii w historii, a przy zwężeniu — tak (schodek p10k).
 * - **Konfiguracja herdr z ustawień domyślnych** (`pane_borders`, `pane_scrollbars`). Inna
 *   konfiguracja daje różnicę jednej, dwóch komórek, którą poprawia pierwszy klient herdr na tym tabie.
 * - Wymiary spoza 1…1000 (zakres ramki `rs`) i obszar zerowy (herdr bez żadnego widoku) — powód.
 */
export function termRestoreSize(layout: HerdrPaneLayout, paneId: string): TermPaneSize | string {
  if (layout.panes.length !== 1) return `tab with ${String(layout.panes.length)} panes`;
  const pane = layout.panes[0];
  if (pane?.paneId !== paneId) return 'layout does not describe this pane';
  const cols = pane.width > 4 ? pane.width - 1 : pane.width;
  const rows = pane.height;
  const fits = (value: number): boolean => Number.isInteger(value) && value >= 1 && value <= 1000;
  if (!fits(cols) || !fits(rows)) {
    return `layout ${String(pane.width)}×${String(pane.height)} out of range`;
  }
  return { cols, rows };
}

/**
 * Okno SKLEJANIA ramek przewijania (`sc` → `terminal.scroll`).
 *
 * Ramka `sc` ma limit AMPLITUDY w schemacie (±200), ale nie ma limitu CZĘSTOTLIWOŚCI, a każda
 * linia NDJSON na stdin kontrolera to RPC do demona herdr — czyli do control-plane'u WSZYSTKICH
 * paneli użytkownika, nie tylko naszego panelu. Uczciwy klient wysyła ~60 ramek/s, ale
 * uwierzytelniony klient zapętlony albo złośliwy mógłby pchać tyle, ile przyjmie gniazdo WS.
 * 16 ms to jedna klatka: dla palca niewidoczne, dla stdin sufit.
 */
export const HERDR_SCROLL_TICK_MS = 16;

/**
 * Na ile WYWOŁAŃ `terminal.scroll` wolno rozbić jedno okno sklejania, żeby scroll w lazygicie
 * nie był dużo wolniejszy niż w terminalu.
 *
 * Zmierzone na żywym panelu z lazygitem: herdr zamienia JEDNO `terminal.scroll` w aplikacji
 * proszącej o mysz na JEDNO tyknięcie kółka, niezależnie od `lines` (1 i 10 dawały po 2 wiersze
 * — `gui.scrollHeight` lazygita). Rarog nie ma jak tej aplikacji rozpoznać: pełna ramka
 * kontrolera nie niesie `DECSET 1000/1002/1006` (tylko `?2026` i `?25`, zmierzone), więc sniffer
 * klienta widzi „bez myszy" i palec jedzie ramką `sc`. Z jednym wywołaniem na okno 16 ms
 * lazygit dostawałby ~1 tyknięcie na klatkę — powłoka w tym czasie przewija pełną sumę wierszy.
 *
 * Dlatego okno wysyła `min(|suma|, ten sufit)` wywołań: pierwsze niesie nadwyżkę, reszta po
 * jednym wierszu. Dla scrollbacku powłoki suma jest ta sama co dotąd (N wierszy = N wierszy),
 * dla aplikacji z myszą okno daje do ośmiu tyknięć zamiast jednego. Sufit zostaje sufitem
 * CZĘSTOTLIWOŚCI z komentarza wyżej — najwyżej 8 RPC na 16 ms (500/s), nie „ile przyjmie WS".
 */
export const HERDR_SCROLL_CALLS_PER_TICK = 8;

/** Ile bajtów stderr kontrolera trzymamy na potrzeby POWODU wyjścia (diagnostyka, nie treść). */
const STDERR_KEEP_CHARS = 200;

/**
 * Jak długo nazwa procesu z `pane.process_info` uchodzi za świeżą.
 *
 * 5 s przy pollingu listy co 5 s znaczy „jeden odczyt na poll i ani jednego więcej". Krócej
 * byłoby pompą do control-plane'u herdr (a pompy Rarog nie prowadzi), dłużej robiłoby
 * z etykiety pigułki nieprawdę: `nvim` zamknięty przed chwilą wisiałby na ekranie.
 */
export const TERM_PROC_TTL_MS = 5_000;

/**
 * Etykieta, gdy powłoka nie ma procesu na pierwszym planie ALBO herdr nie odpowiedział.
 *
 * Świadomie NIE pusty string: `''` znaczy w kontrakcie „jeszcze nie wiem" (pigułka pokazuje
 * samo `>_`), a tu wiemy — pusta lista procesów pierwszego planu to normalny stan powłoki,
 * w której nic nie chodzi.
 */
export const TERM_PROC_FALLBACK = 'zsh';

/**
 * Nazwa procesu z odpowiedzi `pane.process_info` → JEDNO SŁOWO na pigułkę.
 *
 * Trzy decyzje, każda zmierzona na żywym herdr:
 * - **`foreground_processes[0]`**, a NIE proces o `pid == foreground_process_group_id`: dla
 *   panelu z codeksem `[0]` to `codex`, a proces o pid grupy — `node`. Pierwszy jest tym,
 *   co człowiek uznaje za „co tu chodzi".
 * - **`argv0`, gdy NIEPUSTY, inaczej `name`** (czyli `||`, nie `??`): `argv0` jest nullowalne
 *   w schemacie HERDR, ale do backendu wchodzi już jako `string` — fasada klienta koercuje
 *   `proc.argv0 ?? ''` (`herdr/client.ts`). Zaimplementowane literalnie `??` NIGDY nie
 *   spadłoby na `name` i dla panelu bez `argv0` dałoby PUSTĄ etykietę.
 * - **NIE `terminal_title`**: tytuł panelu zależy od promptu powłoki, więc dla zwykłego `zsh`
 *   niesie `u@Mac:~/Projects/rarog`, a nie nazwę procesu.
 *
 * `basename`, lowercase i obcięcie: herdr potrafi oddać w `argv0` pełną ścieżkę binarki.
 */
export function termProcessLabel(processes: readonly HerdrPaneProcess[]): string {
  const first = processes[0];
  if (first === undefined) return TERM_PROC_FALLBACK;
  const raw = first.argv0 !== '' ? first.argv0 : first.name;
  const base = path.basename(raw.trim());
  if (base === '') return TERM_PROC_FALLBACK;
  return base.toLowerCase().slice(0, TERM_PROC_MAX_LENGTH);
}

/** Zmienne środowiska procesu kontrolera — lista ZAMKNIĘTA, jak przy PTY. */
const HERDR_CHILD_ENV_KEYS: readonly string[] = ['HOME', 'PATH', 'TMPDIR'];

/**
 * Proces kontrolera widziany przez backend — minimalny kontrakt zamiast `ChildProcess`.
 *
 * Po to, żeby testy podstawiły atrapę z `PassThrough` i nie potrzebowały ani binarki herdr,
 * ani żywego panelu (ten sam wzorzec co `TmuxBackendOptions.spawn`).
 */
export interface TermHerdrChild {
  readonly stdin: { write(chunk: string): unknown; end(): unknown } | null;
  readonly stdout: {
    on(event: 'data', listener: (chunk: Buffer) => void): unknown;
    pause(): unknown;
    resume(): unknown;
  } | null;
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type TermHerdrSpawn = (
  file: string,
  args: readonly string[],
  options: { env: Record<string, string>; stdio: ['pipe', 'pipe', 'pipe'] },
) => TermHerdrChild;

export interface HerdrBackendOptions {
  readonly config: RarogConfig;
  readonly logger: Logger;
  /**
   * Fabryka klienta gniazda herdr — FABRYKA, nie gotowy klient: terminal ładuje się leniwie
   * i niezależnie od nadzorcy, więc w chwili składania backendu gniazda może jeszcze nie być.
   */
  readonly launchClient: () => HerdrLaunchClient | null;
  /** Spawn kontrolera — wyłącznie testy (powód przy {@link TermHerdrChild}). */
  readonly spawn?: TermHerdrSpawn;
  readonly now?: () => number;
  /** Timer dobicia kontrolera po `release` — testy podstawiają własny. */
  readonly setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout;
  /** Sufit odczytu układu przed zwolnieniem ({@link HERDR_RESTORE_READ_MS}) — testy skracają. */
  readonly restoreReadMs?: number;
  /**
   * Zamek projektu i pamięć założonych workspace'ów. Domyślnie JEDEN na proces
   * (`sharedProjectPlacement`) — ten sam, którego używa launcher agentów; testy podają własny.
   */
  readonly placement?: ProjectPlacement;
  /** System maszyny serwera: słowo maszyny w zdaniach („Mac” albo „VPS”). Domyślnie `serverSystem()`. */
  readonly system?: ServerSystem;
}

/** Stan JEDNEGO panelu na dysku. */
interface PaneState {
  /** `Date.now()` ostatniego kontaktu Raroga z panelem (założenie, podpięcie, zwolnienie). */
  seen: number;
  /** Katalog, z którego terminal powstał — patrz {@link TERM_HERDR_STATE_FILENAME}. */
  cwd: string;
}

function truncate(text: string): string {
  return text.length > STDERR_KEEP_CHARS ? `${text.slice(0, STDERR_KEEP_CHARS)}…` : text;
}

/**
 * Składa backend panelowy. Stan własny to jeden `Map` żywych kontrolerów (do odpowiedzi
 * „czy panel ma klienta") i plik znaczników czasu — reszta prawdy jest w herdr.
 */
export function createHerdrBackend(options: HerdrBackendOptions): TermBackend {
  const { config, logger: log } = options;
  const system = options.system ?? serverSystem();
  /** Konflikt etykiet: zdanie wskazuje maszynę, na której człowiek sprawdzi taby. */
  const labelConflict = (): OwnText => (system === 'macos'
    ? say('term.label-conflict.mac') : say('term.label-conflict.vps'));
  const spawn: TermHerdrSpawn = options.spawn
    ?? ((file, args, opts) => spawnChild(file, [...args], opts));
  const now = options.now ?? ((): number => Date.now());
  const setTimer = options.setTimer ?? ((cb, ms): NodeJS.Timeout => setTimeout(cb, ms));
  const restoreReadMs = options.restoreReadMs ?? HERDR_RESTORE_READ_MS;
  const statePath = path.join(config.dataDir, TERM_HERDR_STATE_FILENAME);
  const placement = options.placement ?? sharedProjectPlacement;
  /**
   * Panele z ŻYWYM kontrolerem tego procesu — źródło `attached` dla żniwiarza.
   *
   * Mapa, nie zbiór: przy planowym respawnie (nowe gniazdo) STARY kontroler kończy się już po
   * starcie nowego, więc samo `delete(ref)` w jego `onExit` skasowałoby wpis żywego kontrolera
   * i żniwiarz zobaczyłby panel „bez klienta". Wartością jest konkretny proces, więc każdy
   * sprząta wyłącznie po sobie.
   */
  const live = new Map<string, TermHerdrChild>();

  // -------------------------------------------------------------------------
  // Cache nazw procesów (etykiety pigułek tabów)
  // -------------------------------------------------------------------------

  /**
   * Ostatnio odczytane nazwy procesów, kluczowane parą `ref|id` uchwytu.
   *
   * W RAM, a nie w `term-herdr.json`: plik ma wiek panelu i katalog powstania, czyli rzeczy,
   * które MUSZĄ przeżyć restart Raroga. Nazwa procesu przeżyć nie musi (po restarcie czytamy
   * ją w pierwszym pollingu), a zapis na dysk przy KAŻDEJ liście oznaczałby write co 5 s
   * po nic.
   *
   * Klucz niesie ID, nie sam adres panelu: adresy herdr są pozycyjne (`w15:p1`), więc po
   * przenumerowaniu ten sam `ref` bywa cudzym panelem — wpis pod starym kluczem po prostu
   * przestaje pasować, zamiast pokazać nazwę procesu z cudzego taba.
   */
  const procCache = new Map<string, { name: string; at: number }>();
  /** Uchwyty czekające na odczyt w NAJBLIŻSZYM odświeżeniu (sklejamy je w jedną turę). */
  const procQueue = new Map<string, TermSessionHandle>();
  let procScheduled = false;

  const procKey = (handle: TermSessionHandle): string => `${handle.ref}|${handle.id}`;

  /**
   * Odświeżenie nazw — JEDEN `pane.list` na turę, potem `pane.process_info` na panel.
   *
   * Bramka własności jest ta sama co przy `attach`, `killSession` i `readHistory`: pytamy
   * wyłącznie o panele, które w ŚWIEŻEJ liście noszą token `rarog-term` o WARTOŚCI równej
   * tożsamości uchwytu. Bez niej etykieta zdradzałaby, co człowiek uruchomił w CUDZYM panelu,
   * pod adresem, który kiedyś był nasz.
   *
   * Wspólny `pane.list` dla całej tury jest po to, żeby lista ośmiu terminali kosztowała jeden
   * odczyt inwentarza, a nie osiem.
   */
  async function refreshProcessNames(): Promise<void> {
    const wanted = [...procQueue.values()];
    procQueue.clear();
    if (wanted.length === 0) return;
    const client = options.launchClient();
    if (client === null) return; // Gniazdo nie stoi — zostaje ostatnia znana nazwa.
    let panes: readonly HerdrPaneInfo[];
    try {
      panes = await client.listPanes();
    } catch {
      return; // Chwilowa awaria gniazda nie jest powodem, żeby skłamać o procesie.
    }
    for (const handle of wanted) {
      const pane = panes.find((candidate) => candidate.paneId === handle.ref);
      if (pane === undefined || termPaneTokenOf(pane.tokens) !== handle.id) {
        // Panel spod tego adresu nie jest już nasz: kasujemy wpis, żeby pigułka wróciła do
        // samego `>_`, zamiast wisieć z nazwą sprzed przenumerowania.
        procCache.delete(procKey(handle));
        continue;
      }
      try {
        const info = await client.readPaneProcess(handle.ref);
        procCache.set(procKey(handle), { name: termProcessLabel(info.processes), at: now() });
      } catch (err: unknown) {
        // Do logu POWÓD, nigdy nazwa procesu — ta sama reguła co przy bajtach strumienia.
        log.info(`term: process name of pane ${handle.ref} unknown (${redact(err)})`);
        procCache.set(procKey(handle), { name: TERM_PROC_FALLBACK, at: now() });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Stan na dysku
  // -------------------------------------------------------------------------

  function readState(): Record<string, PaneState> {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch {
      // Brak pliku i plik nie do odczytania znaczą to samo: nic nie wiemy o wieku paneli.
      // To NIE jest awaria — panele dostaną wtedy znacznik `now` i licznik od zera.
      return {};
    }
    if (typeof raw !== 'object' || raw === null) return {};
    const out: Record<string, PaneState> = {};
    for (const [paneId, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const entry = value as Record<string, unknown>;
      const seen = entry['seen'];
      const cwd = entry['cwd'];
      if (typeof seen !== 'number' || !Number.isFinite(seen)) continue;
      out[paneId] = { seen, cwd: typeof cwd === 'string' ? cwd : '' };
    }
    return out;
  }

  function writeState(state: Record<string, PaneState>): void {
    try {
      mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
      writeFileSync(statePath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (err: unknown) {
      // Nieudany zapis kosztuje dokładnie tyle, ile wynosi wiek panelu po restarcie (`now`)
      // — nie ma za co wywracać terminala.
      log.info(`term: write of ${TERM_HERDR_STATE_FILENAME} failed (${redact(err)})`);
    }
  }

  /** Odświeża znacznik panelu (i zapamiętuje katalog, gdy go znamy). */
  function touch(paneId: string, cwd?: string): void {
    const state = readState();
    const previous = state[paneId];
    state[paneId] = { seen: now(), cwd: cwd ?? previous?.cwd ?? '' };
    writeState(state);
  }

  function forget(paneId: string): void {
    const state = readState();
    if (state[paneId] === undefined) return;
    delete state[paneId];
    writeState(state);
  }

  /**
   * Kasuje wpisy paneli NIEOBECNYCH w pełnym inwentarzu herdr (`listPaneIds`) — odczyt-scal-zapis
   * bez ani jednego `await` pomiędzy, więc świeży `touch` z równoległej ścieżki nie zostaje
   * nadpisany starym stanem.
   *
   * Inwentarzem jest `listPaneIds`, a NIE `listPanes`: ta druga odsiewa wiersze bez `cwd` albo
   * `tab_id`, a „odfiltrowany" nie znaczy „nieistniejący" — prune po niej kasował wiek i katalog
   * powstania żywego panelu, z którego potem nie dało się już odtworzyć tożsamości.
   */
  function pruneState(present: ReadonlySet<string>): void {
    const state = readState();
    let dirty = false;
    for (const paneId of Object.keys(state)) {
      if (present.has(paneId)) continue;
      delete state[paneId];
      dirty = true;
    }
    if (dirty) writeState(state);
  }

  // -------------------------------------------------------------------------
  // Gniazdo herdr
  // -------------------------------------------------------------------------

  function requireClient(): HerdrLaunchClient {
    const client = options.launchClient();
    if (client === null) {
      throw new Error('term: herdr socket unavailable — the pane can be neither found nor created.');
    }
    return client;
  }

  /** Panel z NASZYM tokenem o tej tożsamości, albo `null`. */
  function findOwnPane(panes: readonly HerdrPaneInfo[], id: string): HerdrPaneInfo | null {
    /*
     * Dopasowanie WYŁĄCZNIE po tokenie, świadomie bez porównania `cwd`: token niesie
     * `termIdFor(realpath(cwd), slot)`, czyli tożsamość katalogu I NUMER TABA są w nim zaszyte,
     * a `pane.list` oddaje BIEŻĄCY katalog powłoki — pierwsze `cd` w terminalu rozjechałoby
     * porównanie i Rarog zakładałby drugi panel na ten sam terminal.
     */
    return panes.find((pane) => termPaneTokenOf(pane.tokens) === id) ?? null;
  }

  // -------------------------------------------------------------------------
  // Znakowanie panelu: token = władza, etykieta = pochodzenie
  // -------------------------------------------------------------------------

  /** Po `dispose()` backend nie zakłada, nie zamyka i nie odzyskuje niczego. */
  let disposed = false;

  function refusal(): TermBackendRefusal | null {
    if (!config.herdrLaunch) {
      return {
        code: 'herdr-launch-off',
        sentence: say('term.needs-launch'),
      };
    }
    if (!config.herdrSend) {
      return {
        code: 'herdr-send-off',
        sentence: say('term.needs-send'),
      };
    }
    return null;
  }

  /**
   * Bramka KAŻDEJ mutacji poza drogą `POST` (ta pyta `refusal()` w rejestrze sama). Odmowa jedzie
   * `TermBackendRetryError` ze zdaniem `refusal()`: rejestr pokazuje je ramką `err` z `msgRef` i nie liczy padu.
   */
  function assertMayMutate(): void {
    if (disposed) throw new Error('term: backend closed — not creating or closing panes.');
    const refused = refusal();
    if (refused !== null) throw new TermBackendRetryError(refused.sentence);
  }

  /**
   * Stempel tokenu `rarog-term` — BEZ `ttlMs`. herdr trzyma taki raport do zastąpienia,
   * zdjęcia albo zamknięcia panelu; TTL 24 h był opcją czytaną jako wymóg. Restart serwera herdr
   * kasuje token i tak — wraca wtedy z etykiety panelu (`reconcile`).
   */
  async function stampToken(client: HerdrLaunchClient, paneId: string, id: string): Promise<void> {
    await client.reportPaneMetadata({
      paneId, source: RAROG_TERM_METADATA_SOURCE, tokens: { [RAROG_TERM_TOKEN]: id },
    });
  }

  /** Tożsamość z etykiety `rarog-term <id>` panelu albo `null` (brak, cudza, panel Claude). */
  function labelIdOf(pane: HerdrPaneInfo): string | null {
    const provenance = parsePaneLabel(pane.label);
    return provenance?.kind === 'term' ? provenance.value : null;
  }

  /**
   * Tożsamość z tokenu `rarog-term` albo `null`. Wartość spoza kształtu `TERM_ID_RE` nie jest
   * tożsamością żadnego terminala — z niej nie wolno ani odtworzyć etykiety, ani niczego dopasować.
   */
  function tokenIdOf(pane: HerdrPaneInfo): string | null {
    const token = termPaneTokenOf(pane.tokens);
    return token !== undefined && TERM_ID_RE.test(token) ? token : null;
  }

  /**
   * Mutex ZAKŁADANIA i ODZYSKIWANIA — kolejka obietnic, jeden ogon.
   *
   * Pod nim jedzie przebieg `reconcile` i cała część `ensureSession`, która zakłada nowy panel
   * (świeży odczyt → decyzja → `tab.create` → znakowanie). Bez wspólnego zamka `POST`
   * równoległy z przebiegiem odzyskiwania mógłby zobaczyć panel z etykietą BEZ tokenu (stempel
   * w locie) i założyć drugi tab obok — dokładnie tę sierotę, której etykieta ma zapobiec.
   */
  let lockTail: Promise<void> = Promise.resolve();
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = lockTail.then(task, task);
    lockTail = run.then(() => undefined, () => undefined);
    return run;
  }

  const NOT_RUN: TermReconcileResult = {
    ran: false,
    confirmed: new Map(),
    restored: [],
    migrated: [],
    unknown: new Set(),
    conflicts: new Set(),
  };

  /**
   * Panele z tokenem bez etykiety, którym TEN proces już próbował nadać etykietę (migracja
   * „raz na proces"). Klucz `adres|tożsamość`, bo adresy herdr bywają pozycyjne. Timeout
   * (wynik nieznany) klucza NIE wpisuje: kolejny przebieg sprawdzi, czy etykieta stoi.
   */
  const migrationTried = new Set<string>();
  /** Konflikty już zalogowane — linia raz na proces na układ, a nie co przebieg i co `POST`. */
  const conflictsLogged = new Set<string>();

  /** Przebieg odzyskiwania w locie — `reconcile()` jest single-flight. */
  let reconcileInFlight: Promise<TermReconcileResult> | null = null;

  function reconcile(): Promise<TermReconcileResult> {
    if (reconcileInFlight !== null) return reconcileInFlight;
    const pass: Promise<TermReconcileResult> = exclusive(reconcilePass)
      .catch((err: unknown) => {
        log.info(`term: pane recovery failed (${redact(err)})`);
        return NOT_RUN;
      })
      .finally(() => {
        if (reconcileInFlight === pass) reconcileInFlight = null;
      });
    reconcileInFlight = pass;
    return pass;
  }

  /**
   * JEDEN przebieg odzyskiwania. Kroki:
   *
   * 1. Świeży `pane.list` (pełny wiersz z etykietą) i `listPaneIds` (pełny inwentarz obecności).
   * 2. Etykieta `rarog-term <id>` bez tokenu → token wraca (bez TTL). Token bez etykiety
   *    (panel w starym formacie) → `pane.rename` na `rarog-term <token>`. Tożsamość obecna na więcej niż
   *    jednym panelu albo panel z etykietą i INNYM tokenem → konflikt: nie ruszamy żadnego.
   * 3. Prune `term-herdr.json` wyłącznie po `listPaneIds`.
   * 4. Wynik: potwierdzone, przywrócone, zmigrowane, nieznane (timeout mutacji) i konflikty.
   *
   * Niczego NIE zamyka (rola `lazygit`/`popup` też nie: token mógł zniknąć bez restartu herdr,
   * a w panelu żyje praca) i niczego nie zakłada. Każda mutacja stoi za `refusal()` i `disposed`,
   * sprawdzanymi po każdym `await`; `HerdrReadOnlyError` (nieznany protokół, `SEND=0` po
   * stronie gniazda) kończy mutacje przebiegu jedną linią logu.
   */
  async function reconcilePass(): Promise<TermReconcileResult> {
    if (disposed) return NOT_RUN;
    const refused = refusal();
    if (refused !== null) {
      log.info(`term: pane recovery skipped — ${refused.code}`);
      return NOT_RUN;
    }
    const client = options.launchClient();
    if (client === null) return NOT_RUN;
    let panes: readonly HerdrPaneInfo[];
    let present: ReadonlySet<string>;
    try {
      panes = await client.listPanes();
      present = await client.listPaneIds();
    } catch (err: unknown) {
      log.info(`term: pane recovery failed to read herdr (${redact(err)})`);
      return NOT_RUN;
    }
    if (disposed) return NOT_RUN;

    // Kto przyznaje się do której tożsamości — etykietą albo tokenem.
    const claims = new Map<string, Set<string>>();
    const claim = (id: string, paneId: string): void => {
      const holders = claims.get(id) ?? new Set<string>();
      holders.add(paneId);
      claims.set(id, holders);
    };
    for (const pane of panes) {
      const labelled = labelIdOf(pane);
      const token = tokenIdOf(pane);
      if (labelled !== null) claim(labelled, pane.paneId);
      if (token !== null) claim(token, pane.paneId);
    }
    const conflicts = new Set<string>();
    for (const [id, holders] of claims) if (holders.size > 1) conflicts.add(id);
    for (const pane of panes) {
      const labelled = labelIdOf(pane);
      const token = tokenIdOf(pane);
      if (labelled === null || token === null || labelled === token) continue;
      conflicts.add(labelled);
      conflicts.add(token);
    }
    for (const id of conflicts) {
      const holders = [...(claims.get(id) ?? [])].sort();
      const key = `${id}:${holders.join(',')}`;
      if (conflictsLogged.has(key)) continue;
      conflictsLogged.add(key);
      log.info(
        `term: conflicting marks for terminal ${id} — panes ${holders.join(', ')}; recovering none`,
      );
    }

    const confirmed = new Map<string, string>();
    const restored: string[] = [];
    const migrated: string[] = [];
    const unknown = new Set<string>();
    let readOnly = false;
    for (const pane of panes) {
      const labelled = labelIdOf(pane);
      const token = tokenIdOf(pane);
      const id = labelled ?? token;
      if (id === null || conflicts.has(id)) continue;
      if (token !== null && labelled === token) {
        confirmed.set(pane.paneId, id);
        continue;
      }
      if (labelled === null && token !== null && pane.label !== null) {
        // Token przy CUDZEJ etykiecie (człowiek nazwał panel po swojemu): władza zostaje, a nazwy
        // człowieka nie nadpisujemy. Cena świadoma: po restarcie herdr taki panel nie ma z czego
        // odzyskać tokenu i zostaje cudzy — nazwa nadana ręcznie wygrywa z migracją.
        confirmed.set(pane.paneId, id);
        continue;
      }
      const migrationKey = `${pane.paneId}|${id}`;
      if (labelled === null && migrationTried.has(migrationKey)) {
        confirmed.set(pane.paneId, id);
        continue;
      }
      if (disposed) break;
      if (readOnly || refusal() !== null) {
        if (token !== null) confirmed.set(pane.paneId, id);
        continue;
      }
      /*
       * POTWIERDZENIE tuż przed zapisem. Adresy paneli herdr są
       * pozycyjne, a od migawki z kroku 1 minęły co najmniej `listPaneIds` i wcześniejsze mutacje
       * przebiegu — pod tym adresem mógł w tym czasie stanąć panel człowieka. Świeży `pane.list`
       * (bez `pane.get`, którego nie ma na allow-liście) i stan oczekiwany: przy przywróceniu
       * etykieta TEJ tożsamości bez tokenu, przy migracji ten sam token bez etykiety. Rozjazd =
       * żadnego zapisu na tym panelu. Mutacje są rzadkie (restart herdr, migracja raz), więc
       * dodatkowy odczyt na mutację nie jest pompą.
       */
      let current: HerdrPaneInfo | undefined;
      try {
        current = (await client.listPanes()).find((candidate) => candidate.paneId === pane.paneId);
      } catch (err: unknown) {
        if (labelled !== null) unknown.add(id);
        if (token !== null) confirmed.set(pane.paneId, id);
        log.info(`term: pane ${pane.paneId} not confirmed before write (${redact(err)}) — skipping`);
        continue;
      }
      if (disposed) break;
      const nowLabelled = current === undefined ? null : labelIdOf(current);
      const nowToken = current === undefined ? null : tokenIdOf(current);
      if (labelled !== null && nowLabelled === id && nowToken === id) {
        // Token wrócił sam między odczytami (równoległy stempel) — nie ma czego przywracać.
        confirmed.set(pane.paneId, id);
        continue;
      }
      const stillExpected = labelled !== null
        ? nowLabelled === id && nowToken === null
        : nowToken === id && current?.label === null;
      if (!stillExpected) {
        if (labelled !== null) unknown.add(id);
        log.info(`term: pane ${pane.paneId} changed before write — skipping (terminal ${id})`);
        continue;
      }
      try {
        if (labelled !== null) {
          await stampToken(client, pane.paneId, id);
          restored.push(pane.paneId);
          log.info(`term: recovered token of pane ${pane.paneId} from its label (terminal ${id})`);
        } else {
          await client.renamePane(pane.paneId, termPaneLabel(id));
          migrationTried.add(migrationKey);
          migrated.push(pane.paneId);
          log.info(`term: migration — pane ${pane.paneId} got the label of terminal ${id}`);
        }
        confirmed.set(pane.paneId, id);
      } catch (err: unknown) {
        if (token !== null) confirmed.set(pane.paneId, id);
        const what = labelled !== null ? 'token restore' : 'label (migration)';
        if (err instanceof HerdrReadOnlyError) {
          readOnly = true;
          log.info(`term: pane recovery read-only — ${redact(err)}`);
        } else if (err instanceof HerdrUnavailableError) {
          // Timeout NIE mówi, czy mutacja przeszła (socket.ts) — wynik nieznany, nie porażka.
          if (labelled !== null) unknown.add(id);
          log.info(`term: ${what} of pane ${pane.paneId} — result unknown (${redact(err)})`);
        } else {
          if (labelled === null) migrationTried.add(migrationKey);
          log.info(`term: ${what} of pane ${pane.paneId} failed (${redact(err)})`);
        }
      }
    }

    // Etykiety tabów w starym formacie — po tokenach i etykietach paneli, bo pyta wyłącznie
    // o panele z potwierdzoną tożsamością. Odbicie bramki zapisu w tym przebiegu = bez migracji.
    const relabelled = !disposed && !readOnly && refusal() === null
      ? await migrateTermTabLabels(client, panes, confirmed, new Set(migrated))
      : { tabs: 0, panes: 0 };

    // Plik stanu jest lokalny, ale po `dispose()` serwer już się zamyka — zostawiamy go w spokoju.
    if (!disposed) pruneState(present);
    if (restored.length + migrated.length + unknown.size + relabelled.tabs + relabelled.panes > 0) {
      log.info(
        `term: pane recovery — restored ${String(restored.length)},`
        + ` migrated ${String(migrated.length)}, unknown ${String(unknown.size)},`
        + ` conflicts ${String(conflicts.size)}, tab labels ${String(relabelled.tabs)},`
        + ` pane labels ${String(relabelled.panes)}`,
      );
    }
    return { ran: true, confirmed, restored, migrated, unknown, conflicts };
  }

  // -------------------------------------------------------------------------
  // Zakładanie panelu
  // -------------------------------------------------------------------------

  /**
   * Etykieta TABA terminala: `rarog <slot> · <katalog>` albo `rarog <rola> · <katalog>`
   * — to, co pigułka dawnej PWA, plus projekt. Slot i rolę odczytujemy z tożsamości (`matchTermId`
   * próbuje kandydatów — hash jest jednokierunkowy), katalog to `realCwd`, z którego tożsamość
   * powstała. Tożsamość spoza tego katalogu = slot nieznany, etykieta bez numeru.
   */
  function tabLabelFor(id: string, realCwd: string, role: TermSessionRole): string {
    const identity = matchTermId(id, realCwd);
    return identity === null
      ? terminalTabLabel(role, null, realCwd)
      : terminalTabLabel(identity.role, identity.slot, realCwd);
  }

  /**
   * Taby terminala, których etykietę migracja tego procesu już sprawdziła — klucz
   * `adres panelu|tożsamość|tab`. Stary format nie wraca sam (taby powstają
   * w nowym), więc jedno sprawdzenie na panel i proces wystarcza; wynik nieznany (timeout)
   * klucza nie zostawia — kolejny przebieg sprawdzi jeszcze raz.
   */
  const tabLabelChecked = new Set<string>();

  /**
   * MIGRACJA etykiet tabów terminala w starym formacie — krok `reconcile`, pod jego mutexem.
   *
   * Panel z potwierdzoną tożsamością (token) i NASZĄ etykietą panelu `rarog-term <id>` (także
   * nadaną w tym samym przebiegu), tab jednopanelowy z etykietą z {@link LEGACY_TERM_TAB_LABELS}
   * → `tab.rename` na nowy format. Inna etykieta taba = ręczna, nietknięta; split (więcej niż jeden panel) — nietknięty, bo tab nie jest wtedy „terminala". Katalog i slot bierzemy
   * z pliku stanu (katalog powstania), a gdy ten nie pasuje — z bieżącego `cwd` panelu; żadna
   * nie pasuje = bez migracji (etykieta mówiłaby nieprawdę). `tab.get` tuż przed zapisem jest
   * potwierdzeniem stanu. Etykieta jest deterministyczna, więc śladu nie potrzebuje.
   * `RAROG_HERDR_TAB_LABELS=0` gasi ten krok w całości.
   *
   * The same step gives a bare pane label `rarog-term <id>` its description: the terminal tab
   * label from the same identity and directory, so a pane without a match keeps its old label.
   * Single-pane tabs only, each write behind its own fresh confirmation.
   *
   * @returns how many tabs and pane labels got the new format
   */
  async function migrateTermTabLabels(
    client: HerdrLaunchClient,
    panes: readonly HerdrPaneInfo[],
    confirmed: ReadonlyMap<string, string>,
    labelledNow: ReadonlySet<string>,
  ): Promise<{ tabs: number; panes: number }> {
    if (!config.herdrTabLabels) return { tabs: 0, panes: 0 };
    const state = readState();
    let renamed = 0;
    let described = 0;
    for (const pane of panes) {
      const id = confirmed.get(pane.paneId);
      if (id === undefined) continue;
      // Token przy CUDZEJ etykiecie panelu znaczy „człowiek nazwał ten panel po swojemu" —
      // jego tab też zostaje jego.
      if (labelIdOf(pane) !== id && !labelledNow.has(pane.paneId)) continue;
      const checkKey = `${pane.paneId}|${id}|${pane.tabId}`;
      if (tabLabelChecked.has(checkKey)) continue;
      const stateCwd = state[pane.paneId]?.cwd ?? '';
      const fromState = stateCwd === '' ? null : matchTermId(id, stateCwd);
      const identity = fromState ?? matchTermId(id, pane.cwd);
      if (identity === null) {
        tabLabelChecked.add(checkKey);
        continue;
      }
      const tabCwd = fromState !== null ? stateCwd : pane.cwd;
      const target = terminalTabLabel(identity.role, identity.slot, tabCwd);
      if (disposed || refusal() !== null) break;
      let tab: HerdrTabInfo;
      try {
        tab = await client.getTab(pane.tabId);
      } catch (err: unknown) {
        log.info(`term: tab ${pane.tabId} label read failed (${redact(err)}) — migration on the next pass`);
        continue;
      }
      if (disposed) break;
      tabLabelChecked.add(checkKey);
      if (tab.paneCount !== 1) continue;
      if (tab.label !== target && LEGACY_TERM_TAB_LABELS.has(tab.label)) {
        /*
         * POTWIERDZENIE tuż przed zapisem: prawo nie stoi na samej migawce
         * z początku przebiegu, a `tab.get` mówi tylko, ILE paneli ma tab. Terminal przeniesiony
         * w międzyczasie zostawia pod tym adresem taba panel człowieka — jego tab nie jest „terminala".
         * Świeży `pane.list`: w tym tabie stoi DOKŁADNIE nasz panel, z naszym tokenem i etykietą.
         */
        const alone = await aloneInTab(client, pane.paneId, tab.tabId, id, null, checkKey);
        if (alone === 'stop') break;
        if (alone === 'changed') continue;
        if (refusal() !== null) break;
        try {
          await client.renameTab(tab.tabId, target);
          renamed += 1;
          log.info(`term: migration — tab ${tab.tabId} got the label of terminal ${id}`);
        } catch (err: unknown) {
          if (err instanceof HerdrReadOnlyError) {
            log.info(`term: tab labels read-only — ${redact(err)}`);
            break;
          }
          // Timeout nie mówi, czy zmiana przeszła — kolejny przebieg sprawdzi tab od nowa.
          if (err instanceof HerdrUnavailableError) tabLabelChecked.delete(checkKey);
          log.info(`term: label of tab ${tab.tabId} failed (${redact(err)})`);
          continue;
        }
      }
      /*
       * The pane label: a bare `rarog-term <id>` gets the terminal tab label in front, so herdr's
       * Go-to names the pane like its tab. A label that already has a description stays (Rarog
       * wrote it, or a human chose it within the pattern), which makes the step idempotent.
       */
      const bare = termPaneLabel(id);
      const describedLabel = termPaneLabel(id, target);
      const readLabel = labelledNow.has(pane.paneId) ? bare : pane.label;
      if (readLabel !== bare || describedLabel === bare) continue;
      const alone = await aloneInTab(client, pane.paneId, tab.tabId, id, bare, checkKey);
      if (alone === 'stop') break;
      if (alone === 'changed') continue;
      if (refusal() !== null) break;
      try {
        await client.renamePane(pane.paneId, describedLabel);
        described += 1;
        log.info(`term: migration — pane ${pane.paneId} label leads with its tab label (terminal ${id})`);
      } catch (err: unknown) {
        if (err instanceof HerdrReadOnlyError) {
          log.info(`term: pane labels read-only — ${redact(err)}`);
          break;
        }
        // A timeout is an unknown result: the next pass reads the label and writes only if still bare.
        if (err instanceof HerdrUnavailableError) tabLabelChecked.delete(checkKey);
        log.info(`term: label of pane ${pane.paneId} failed (${redact(err)})`);
      }
    }
    return { tabs: renamed, panes: described };
  }

  /**
   * Fresh `pane.list` right before a label write: the pane stands ALONE in its tab, with this
   * terminal's token and label. `label` = the exact label the write expects (`null` = any label
   * of this terminal). `changed` = no write on this pane in this pass; `stop` = backend closed.
   */
  async function aloneInTab(
    client: HerdrLaunchClient, paneId: string, tabId: string, id: string, label: string | null,
    checkKey: string,
  ): Promise<'ok' | 'changed' | 'stop'> {
    let fresh: readonly HerdrPaneInfo[];
    try {
      fresh = await client.listPanes();
    } catch (err: unknown) {
      tabLabelChecked.delete(checkKey);
      log.info(`term: tab ${tabId} not confirmed before relabel (${redact(err)})`);
      return 'changed';
    }
    if (disposed) return 'stop';
    const inTab = fresh.filter((candidate) => candidate.tabId === tabId);
    const only = inTab.length === 1 ? inTab[0] : undefined;
    if (
      only?.paneId !== paneId || tokenIdOf(only) !== id || labelIdOf(only) !== id
      || (label !== null && only.label !== label)
    ) {
      log.info(`term: tab ${tabId} changed before relabel — skipping (terminal ${id})`);
      return 'changed';
    }
    return 'ok';
  }

  /**
   * Zakłada NOWY panel terminala — wyłącznie pod mutexem i wyłącznie po odzyskiwaniu.
   *
   * Kolejność jest wiążąca: `reconcile` (może przywrócić token sierocie z etykietą) →
   * mutex `exclusive` → zamek PROJEKTU → ŚWIEŻY `pane.list` → panel z tokenem tego terminala
   * oddajemy (`fresh: false`) → panel z ETYKIETĄ tego terminala bez tokenu = odmowa
   * `TermBackendRetryError`, nigdy drugi tab obok → workspace z resolvera → dopiero wtedy
   * `tab.create`/`workspace.create` i znakowanie.
   *
   * Zamek projektu (`herdr/project-workspace.ts`) jest wspólny z launcherem agentów: pierwsze
   * równoczesne założenie sesji Claude i terminala tego samego katalogu daje JEDEN workspace.
   * Kolejność zamków jest stała — `exclusive`, potem projekt; launcher bierze tylko projekt,
   * `reconcile` tylko `exclusive` — więc nikt nie czeka na `exclusive`, trzymając projekt.
   */
  async function createSession(
    client: HerdrLaunchClient, id: string, cwd: string, role: TermSessionRole,
  ): Promise<TermSessionHandle> {
    const recovered = await reconcile();
    // Klucz zamka i wejście resolvera: ten sam `realpath`, którego używa launcher. `cwd` przychodzi
    // z rejestru już po `realpath`, więc to zwykle ta sama ścieżka.
    const realCwd = await realProjectPath(cwd);
    return await exclusive(async () => {
      assertMayMutate();
      return await placement.withProjectLock(realCwd, async () => {
        const panes = await client.listPanes();
        // `dispose()` mógł przyjść w trakcie odczytu — po nim nie ma ani taba,
        // ani znaków, ani uchwytu.
        assertMayMutate();
        const own = findOwnPane(panes, id);
        if (own !== null) {
          // Token wrócił w przebiegu odzyskiwania (albo równoległy `POST` właśnie założył panel).
          touch(own.paneId, cwd);
          return { ref: own.paneId, id, fresh: false };
        }
        const marked = panes.filter((pane) => labelIdOf(pane) === id);
        if (marked.length > 0) {
          /*
           * Panel z etykietą TEGO terminala bez jego tokenu: odzyskiwanie nie przeszło (wynik
           * nieznany po timeoucie, odmowa herdr) albo trafiło na konflikt. Świeży odczyt wyżej był
           * drugą szansą; nowy tab obok byłby duplikatem, więc odmawiamy zdaniem dla człowieka,
           * a kolejny `POST` zacznie od nowego przebiegu odzyskiwania.
           */
          const conflict = recovered.conflicts.has(id) || marked.length > 1
            || marked.some((pane) => tokenIdOf(pane) !== null);
          log.info(
            `term: terminal ${id} has a marked pane without a token (${marked.map((p) => p.paneId).join(', ')})`
            + ` — ${conflict ? 'conflict' : 'recovery in progress'}, not creating a new tab`,
          );
          throw new TermBackendRetryError(
            conflict ? labelConflict() : say('term.recovering'),
          );
        }

        /*
         * Workspace projektu: resolver `herdr/workspace-resolver.ts` — kandydat
         * po etykiecie (nazwa katalogu) albo ścieżce checkoutu, potwierdzony dowodem ścieżki
         * (etykieta Raroga tej ścieżki albo `cwd` panelu w projekcie); bez dowodu nowy workspace.
         * Samo `pane.cwd` nie wystarcza: dryfuje z każdym `cd`, więc tab projektu A wchodziłby do
         * workspace'u projektu B. Sloty jednego projektu trzymają się razem dzięki etykiecie
         * `rarog-term <id>` pierwszego slotu (dowód mocny).
         */
        /*
         * Pisownie dla rozpoznania etykiet: `cwd` z rejestru i katalogi powstania
         * paneli z pliku stanu — tożsamość terminala sprzed poprawki liczyła się z pisowni
         * WEJŚCIA (`…/RAROG`), a resolver porównuje pisownię z dysku (`…/rarog`).
         */
        const ownerHints = new Map<string, string>();
        for (const [paneId, entry] of Object.entries(readState())) {
          if (entry.cwd !== '') ownerHints.set(paneId, entry.cwd);
        }
        const decision = await decideProjectWorkspace({
          client, realCwd, placement, panes, spellings: [cwd], ownerHints,
        });
        assertMayMutate();
        // Etykieta taba mówi przy Macu, CO w tym tabie stoi (slot albo rola) i DLA KTÓREGO
        // projektu — to samo, co pigułka w dawnej PWA. Token panelu jest wspólny dla ról.
        const label = tabLabelFor(id, cwd, role);
        let paneId: string;
        let tabId: string;
        let createdWorkspace = false;
        if (decision.kind === 'existing') {
          const tab = await client.createTab({
            workspaceId: decision.workspaceId, cwd, label,
            env: { ...RAROG_TERM_PANE_ENV },
          });
          paneId = tab.paneId;
          tabId = tab.tabId;
          log.info(`${TERM_NEW_TAB_LOG} ${tab.tabId} in workspace ${decision.workspaceId}`
            + ` (${decision.via}, cwd=${cwd})`);
        } else {
          const workspace = await client.createWorkspace({
            cwd, label: decision.label,
            env: { ...RAROG_TERM_PANE_ENV },
          });
          paneId = workspace.paneId;
          tabId = workspace.tabId;
          createdWorkspace = true;
          placement.remember(realCwd, workspace.workspaceId);
          log.info(`${TERM_NEW_WORKSPACE_LOG} ${workspace.workspaceId} "${decision.label}" (cwd=${cwd})`);
        }

        /*
         * Token i etykieta są WARUNKIEM własności, a nie kosmetyką: bez tokenu panel nie przejdzie
         * ani bramki `pane.close`, ani adopcji po restarcie Raroga, a bez etykiety nie odzyska
         * tokenu po restarcie herdr. Dlatego błąd któregokolwiek przerywa zakładanie
         * (inaczej niż w launcherze agentów, gdzie znacznik jest best-effort). Etykieta panelu
         * jest przy tym DOWODEM dla resolvera, więc idzie jeszcze pod zamkiem projektu.
         *
         * Zamknięty w międzyczasie backend (`dispose()` przy zamykaniu serwera) nie dosyła już
         * NICZEGO — także sprzątania: tab bez znaków zostaje na Macu i mówi o tym linia w logu.
         */
        const stopIfDisposed = (): void => {
          if (!disposed) return;
          log.info(`term: backend closed during creation — tab ${tabId} stays unmarked`);
          assertMayMutate();
        };
        stopIfDisposed();
        try {
          await stampToken(client, paneId, id);
          stopIfDisposed();
          // The pane label leads with the tab label, so herdr's Go-to names the pane like its tab.
          await client.renamePane(paneId, termPaneLabel(id, label));
        } catch (err: unknown) {
          if (disposed) throw err;
          /*
           * Panel BEZ znaków jest dla Raroga niewidzialny: nie adoptuje go (`listSessions`
           * pomija panele bez tokenu), nie tknie żniwiarz i nie zamknie `killSession` (bramka
           * własności) — a każdy następny `POST` zakładałby KOLEJNY taki sam pusty tab.
           * Dlatego sprzątamy tu i teraz, dopóki mamy adres taba z tej
           * samej odpowiedzi; bramka „czy nasz" jest w tym jednym miejscu zbędna, bo tab
           * powstał przed chwilą na nasze żądanie i nikt inny nie zdążył go dostać.
           */
          log.info(
            `term: marking pane ${paneId} failed (${redact(err)}) — closing the fresh tab ${tabId}`,
          );
          try {
            await client.closeTab(tabId);
          } catch (closeErr: unknown) {
            // Zostaje pusty tab widoczny na Macu — brzydkie, ale jawne. Cichy `throw` wyżej
            // i tak przerywa zakładanie, więc drugiego panelu z tego nie będzie.
            log.info(`term: could not close tab ${tabId} after failed marking (${redact(closeErr)})`);
          }
          throw err;
        }
        stopIfDisposed();
        if (createdWorkspace) {
          /*
           * `workspace.create` nadaje pierwszemu tabowi etykietę „1" (zmierzone),
           * a `tab.create` niesie naszą sam. Best effort: tab z „1" niczego nie psuje —
           * pochodzenie niesie etykieta PANELU.
           */
          try {
            await client.renameTab(tabId, label);
          } catch (err: unknown) {
            log.info(`term: label ${label} of tab ${tabId} failed (${redact(err)})`);
          }
        }
        touch(paneId, cwd);
        // `fresh: true` — panel powstał PRZED CHWILĄ na to żądanie. Rejestr wpisuje do takiego
        // (i tylko do takiego) panelu start lazygita.
        return { ref: paneId, id, fresh: true };
      });
    });
  }

  /**
   * JAWNE otwarcie roli `lazygit` na ZASTANYM panelu, w którym
   * zamiast lazygita stoi goła powłoka — sierota po restarcie herdr, który zabija procesy paneli
   * i odtwarza je samą powłoką. `Cmd+G` jest prośbą o lazygit, a panel jest nasz (token), więc
   * Rarog zamyka go i zakłada świeży, do którego rejestr wpisze start.
   *
   * `true` = panel zamknięty, wołający zakłada nowy; `false` = ponowne użycie jak dotąd.
   *
   * Zamykamy WYŁĄCZNIE gołą powłokę (`isBareShellForeground`: jeden proces i to powłoka) —
   * węziej niż „nie lazygit": edytor otwarty z lazygita albo program wpisany ręcznie w tę powłokę
   * stoi na pierwszym planie z własną nazwą i zostaje. Decyzję potwierdza DRUGI odczyt (token
   * i proces) tuż przed `pane.close`; rozjazd to odmowa ze zdaniem, nie zamknięcie w ciemno.
   * Pierwszy odczyt, który padł, to „nie wiem" = ponowne użycie.
   */
  async function replaceIdleLazygit(
    client: HerdrLaunchClient, paneId: string, id: string,
  ): Promise<boolean> {
    let first: readonly HerdrPaneProcess[];
    try {
      first = (await client.readPaneProcess(paneId)).processes;
    } catch (err: unknown) {
      log.info(`term: lazygit pane ${paneId} — process unknown (${redact(err)}), kept`);
      return false;
    }
    if (!isBareShellForeground(first)) return false;
    let confirmed = false;
    try {
      const again = (await client.listPanes()).find((pane) => pane.paneId === paneId);
      if (again !== undefined && termPaneTokenOf(again.tokens) === id) {
        confirmed = isBareShellForeground((await client.readPaneProcess(paneId)).processes);
      }
    } catch (err: unknown) {
      log.info(`term: lazygit pane ${paneId} — second read failed (${redact(err)})`);
    }
    if (!confirmed) {
      log.info(`term: lazygit pane ${paneId} changed between reads — not closing`);
      throw new TermBackendRetryError(say('term.lazygit-changed'));
    }
    assertMayMutate();
    log.info(`term: lazygit pane ${paneId} is a bare shell — closing it and creating a fresh one (Q6)`);
    try {
      await client.closePane(paneId);
    } catch (err: unknown) {
      log.info(`${TERM_LAZYGIT_CLOSE_FAILED_LOG} ${paneId} failed (${redact(err)})`);
      throw new TermBackendRetryError(say('term.lazygit-close-failed'));
    }
    procCache.delete(`${paneId}|${id}`);
    procQueue.delete(`${paneId}|${id}`);
    forget(paneId);
    return true;
  }

  // -------------------------------------------------------------------------
  // Strumień
  // -------------------------------------------------------------------------

  /**
   * Rozmiar panelu do przywrócenia przed zwolnieniem ({@link termRestoreSize}) albo POWÓD, czemu go
   * nie ma. Nigdy nie rzuca i nigdy nie czeka dłużej niż {@link HERDR_RESTORE_READ_MS}: brak gniazda,
   * brak metody, błąd, nieznany kształt i cisza herdr to ten sam wynik — zwolnienie jak dotąd.
   *
   * Bez bramki tokenu: odczyt idzie tylko dla panelu, do którego jest podłączony NASZ żywy kontroler
   * (bramka własności stała przed jego `--takeover`), a odpowiedź to sama geometria. Że układ opisuje
   * dokładnie ten panel, sprawdza {@link termRestoreSize}.
   */
  async function readRestoreSize(ref: string): Promise<TermPaneSize | string> {
    const client = options.launchClient();
    if (client === null) return 'herdr socket unavailable';
    if (client.readPaneLayout === undefined) return 'herdr client without `pane.layout`';
    let timer: NodeJS.Timeout | undefined;
    const clock = new Promise<string>((resolve) => {
      timer = setTimeout(() => {
        resolve(`layout read timed out after ${String(restoreReadMs)} ms`);
      }, restoreReadMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        client.readPaneLayout(ref).then(
          (layout) => termRestoreSize(layout, ref),
          (err: unknown) => `layout read failed: ${redact(err)}`,
        ),
        clock,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function makeStream(child: TermHerdrChild, ref: string, alive: () => boolean): TermStream {
    const send = (frame: Record<string, unknown>): void => {
      try {
        child.stdin?.write(`${JSON.stringify(frame)}\n`);
      } catch (err: unknown) {
        // Kontroler mógł już paść — `onExit` i tak zaraz przyjdzie, a wyjątek z zapisu do
        // martwego stdin nie ma prawa wyjść na zewnątrz rejestru.
        log.info(`term: write to controller ${ref} failed (${redact(err)})`);
      }
    };

    /*
     * Przewijanie SKLEJAMY w oknie {@link HERDR_SCROLL_TICK_MS} — powód (i dlaczego to jest
     * sprawa bezpieczeństwa, a nie wygody) stoi przy tej stałej.
     *
     * Zegar jest ZWYKŁYM `setTimeout`, a nie wstrzykiwanym `setTimer`: ten drugi jest w testach
     * jednoslotową atrapą karencji i dobicia kontrolera, więc trzeci użytkownik zabrałby jej
     * slot. `unref`, bo tykający scroll nie ma prawa trzymać procesu przy życiu.
     */
    let pendingLines = 0;
    let pendingCell: { col: number; row: number } | null = null;
    let tick: NodeJS.Timeout | null = null;
    const flushScroll = (): void => {
      const lines = pendingLines;
      const cell = pendingCell;
      pendingLines = 0;
      pendingCell = null;
      if (lines === 0) return;
      /*
       * `source: 'wheel'` — zmierzone na żywo: i `page_key`,
       * i `wheel` działają, ale `wheel` odpowiada gestowi palca (przewijanie o wiersze,
       * nie o ekrany) i tak samo zachowuje się w aplikacji proszącej o mysz.
       *
       * `column`/`row` — komórka pod palcem: herdr kieruje kółko do panelu aplikacji pod nią
       * (lazygit przewija diff pod palcem, nie panel z fokusem; bez współrzędnych kółko
       * w aplikacji z panelami nie robi NIC — zmierzone). Sklejanie bierze
       * OSTATNIĄ znaną komórkę okna: palec rysuje jeden gest, więc ostatni punkt jest
       * najbliższy prawdy, a mieszanie dwóch gestów w 16 ms nie występuje.
       */
      // Rozbicie na wywołania — powód przy {@link HERDR_SCROLL_CALLS_PER_TICK}: dla powłoki
      // suma wierszy jest ta sama, dla aplikacji z myszą każde wywołanie to tyknięcie kółka.
      const total = Math.abs(lines);
      const calls = Math.min(total, HERDR_SCROLL_CALLS_PER_TICK);
      for (let i = 0; i < calls; i += 1) {
        send({
          type: 'terminal.scroll',
          direction: lines < 0 ? 'up' : 'down',
          lines: i === 0 ? total - (calls - 1) : 1,
          source: 'wheel',
          ...(cell === null ? {} : { column: cell.col, row: cell.row }),
        });
      }
    };

    const sayGoodbye = (): void => {
      // Uprzejme pożegnanie: kontroler ma oddać panel, a nie zginąć w połowie ramki.
      send({ type: 'terminal.release' });
      try {
        child.stdin?.end();
      } catch { /* jw. — martwe stdin nie jest awarią */ }
      // ...ale nie czekamy na nie w nieskończoność: kontroler, który nie wyszedł, trzyma
      // panel w rozmiarze Raroga i blokuje kolejny `--takeover`.
      const timer = setTimer(() => {
        // Kontroler zdążył wyjść po `release` — nie ma czego dobijać (a `kill` po jego
        // śmierci trafiałby w cudzy, nowszy proces, gdyby PID zdążył się przewinąć).
        if (!alive()) return;
        log.info(`term: controller ${ref} did not exit after release — SIGTERM`);
        try {
          child.kill('SIGTERM');
        } catch { /* proces mógł zniknąć w międzyczasie */ }
      }, HERDR_RELEASE_KILL_MS);
      timer.unref?.();
    };

    /*
     * Przywrócenie rozmiaru PRZED zwolnieniem po karencji. Kontroler ustawia pty panelu na rozmiar
     * telefonu, a herdr po `terminal.release` zdejmuje blokadę rozmiaru BEZ przeliczenia — pty
     * zostawałoby 62×29, dopóki tabu nie obejrzy klient herdr (zmierzone do +11 min), i dialog CLI
     * wyższy niż panel traciłby nagłówek. Herdr
     * przetwarza wiadomości kontrolera po kolei, więc `terminal.resize` tuż przed
     * `terminal.release` zostaje po zwolnieniu (zmierzone: 127×52 po ≤ 50 ms i dalej po 10 s).
     *
     * Rozmiar dostaje wyłącznie OSTATNI kontroler tego panelu: następca z tego procesu (nowe
     * gniazdo w trakcie odczytu) albo koniec kontrolera = bez `terminal.resize`. Obcy następca jest
     * bezpieczny po stronie herdr — przejęcie wyrzuca nasz kontroler, a `Resize` od klienta spoza
     * listy herdr pomija (`ClientResize` w `src/server/headless.rs`).
     */
    const restoreSize = async (): Promise<void> => {
      const size = await readRestoreSize(ref);
      if (typeof size === 'string') {
        log.info(`term: pane ${ref} size not restored (${size}) — plain release`);
        return;
      }
      const gone = disposed ? 'server is shutting down'
        : !alive() || live.get(ref) !== child ? 'controller is no longer the last one' : null;
      if (gone !== null) {
        log.info(`term: pane ${ref} size not restored (${gone})`);
        return;
      }
      send({ type: 'terminal.resize', cols: size.cols, rows: size.rows });
      log.info(`term: pane ${ref} back to ${String(size.cols)}×${String(size.rows)} before release`);
    };

    return {
      write: (data) => { send({ type: 'terminal.input', text: data }); },
      resize: (cols, rows) => { send({ type: 'terminal.resize', cols, rows }); },
      scroll: (lines, cell = null) => {
        if (!Number.isFinite(lines) || lines === 0) return;
        pendingLines += lines;
        if (cell != null) pendingCell = cell;
        if (tick !== null) return;
        tick = setTimeout(() => {
          tick = null;
          flushScroll();
        }, HERDR_SCROLL_TICK_MS);
        tick.unref?.();
      },
      /*
       * Świadomy no-op: pełną ramkę kontroler wysyła WYŁĄCZNIE na starcie, więc odmalowania
       * na żądanie po prostu nie ma czym zrobić. Rejestr tej ścieżki tu nie używa —
       * `respawnOnAttach` sprawia, że każde nowe gniazdo dostaje nowego kontrolera i pełną
       * ramkę razem z nim.
       */
      refresh: () => { /* patrz powód wyżej */ },
      pause: () => { child.stdout?.pause(); },
      resume: () => { child.stdout?.resume(); },
      release: (opts: TermReleaseOptions = {}) => {
        // Reszta gestu jedzie PRZED pożegnaniem — inaczej ostatnie wiersze zbierane w oknie
        // sklejania ginęłyby przy każdym zwolnieniu strumienia.
        if (tick !== null) {
          clearTimeout(tick);
          tick = null;
        }
        flushScroll();
        if (opts.restoreSize !== true || !alive()) {
          sayGoodbye();
          return;
        }
        void restoreSize()
          .catch((err: unknown) => {
            log.info(`term: pane ${ref} size not restored (${redact(err)}) — plain release`);
          })
          .finally(sayGoodbye);
      },
    };
  }

  return {
    /*
     * Pełna ramka leci tylko na starcie kontrolera, a rozmiar wchodzi argumentem spawnu —
     * więc każde nowe gniazdo musi dostać WŁASNEGO kontrolera. Konsekwencja jest
     * ZAAKCEPTOWANA: rozmiar = ostatnie urządzenie, a panel na Macu
     * zmienia rozmiar na czas podłączenia. „Na czas" znaczy naprawdę: zwolnienie
     * po karencji oddaje panelowi rozmiar z układu taba (`release` z `restoreSize`), bo herdr
     * sam go nie przelicza.
     */
    respawnOnAttach: true,

    refusal,

    reconcile,

    dispose: (): void => { disposed = true; },

    /**
     * Odnajduje panel po tokenie albo zakłada nowy: tab w workspace'ie projektu (resolver workspace'u),
     * a gdy go nie ma — nowy workspace. Świeży panel dostaje token i etykietę natychmiast, bo bez
     * nich jest dla Raroga nieodróżnialny od cudzego (i nie wolno go potem ani zamknąć, ani
     * adoptować, ani odzyskać po restarcie herdr). Zakładanie idzie przez {@link createSession}:
     * po odzyskiwaniu, pod mutexem i pod zamkiem projektu.
     */
    ensureSession: async (
      id: string, cwd: string, role: TermSessionRole = 'shell', opts: TermEnsureOptions = {},
    ): Promise<TermSessionHandle> => {
      const client = requireClient();
      const panes = await client.listPanes();
      const own = findOwnPane(panes, id);
      // Panel replaced only on an explicit lazygit request; adoption never replaces one.
      const wantsLazygit = role === 'lazygit' && opts.explicit === true;
      if (own === null) {
        const handle = await createSession(client, id, cwd, role);
        /*
         * Panel ODZYSKANY w przebiegu tego samego otwarcia: pierwsze `Cmd+G` po
         * restarcie herdr trafia na sierotę lazygita, której token wraca dopiero tutaj — a w
         * środku stoi goła powłoka. Ta sama zamiana co dla panelu zastanego.
         */
        if (
          wantsLazygit && handle.fresh !== true && await replaceIdleLazygit(client, handle.ref, id)
        ) {
          return await createSession(client, id, cwd, role);
        }
        return handle;
      }
      if (wantsLazygit && await replaceIdleLazygit(client, own.paneId, id)) {
        return await createSession(client, id, cwd, role);
      }
      /*
       * Ponowny stempel przy KAŻDYM odnalezieniu panelu. Token jest bez TTL, więc to nie
       * wyścig z terminem ważności, tylko tani, idempotentny raport (token bez terminu trwa do
       * zastąpienia albo zamknięcia panelu). Best-effort: panel już jest i nosi token — ale
       * po `dispose()` (mógł przyjść w trakcie odczytu) nie idzie już nic.
       */
      assertMayMutate();
      try {
        await stampToken(client, own.paneId, id);
      } catch (err: unknown) {
        log.info(`term: pane ${own.paneId} token refresh failed (${redact(err)})`);
      }
      touch(own.paneId, cwd);
      // `fresh: false` — panel ODNALEZIONY. Dla roli `lazygit` to jedyna bramka, która
      // powstrzymuje rejestr przed wpisaniem `exec lazygit` w klawiaturę chodzącego już
      // lazygita (adopcja po restarcie Raroga idzie dokładnie tędy).
      return { ref: own.paneId, id, fresh: false };
    },

    attach: async (handle: TermSessionHandle, opts: TermStreamOptions): Promise<TermStream> => {
      const ref = handle.ref;
      /*
       * BRAMKA WŁASNOŚCI PRZED SPAWNEM, ta sama co przy `pane.close`
       * i z tego samego powodu: `--takeover` WYRZUCA z panelu dotychczasowego kontrolera,
       * a id paneli herdr są POZYCYJNE (`w15:p1`). Uchwyt żyje w rejestrze do restartu Raroga,
       * więc po zamknięciu naszego panelu na Macu albo po restarcie herdr ten sam adres należy
       * dziś do kogoś innego — bez tego pytania Rarog przejmowałby cudzą powłokę. Świeży
       * `pane.list`, nigdy pamięć rejestru.
       */
      const client = requireClient();
      const target = (await client.listPanes()).find((pane) => pane.paneId === ref);
      if (target === undefined || termPaneTokenOf(target.tokens) !== handle.id) {
        throw new TermHandleStaleError(
          `term: pane ${ref} is no longer terminal ${handle.id} — handle needs recomputing`,
        );
      }
      /*
       * Ponowny stempel przy KAŻDYM podpięciu, a nie tylko w `ensureSession`. Token nie
       * ma terminu, więc to tani, idempotentny raport na panelu, który bramka wyżej przed
       * chwilą uznała za nasz. Best-effort: nieudany stempel niczego nie odbiera.
       */
      try {
        await stampToken(client, ref, handle.id);
      } catch (err: unknown) {
        log.info(`term: pane ${ref} token refresh on attach failed (${redact(err)})`);
      }
      touch(ref, opts.cwd);
      const args = [
        'terminal', 'session', 'control', ref,
        // `--takeover`, bo herdr dopuszcza JEDEN kontroler panelu, a nasz własny, planowy
        // respawn (nowe gniazdo) musi umieć wejść na miejsce poprzedniego.
        '--takeover',
        '--cols', String(opts.cols),
        '--rows', String(opts.rows),
      ];
      const env: Record<string, string> = {};
      for (const key of HERDR_CHILD_ENV_KEYS) {
        const value = config.termEnvBase[key];
        if (value !== undefined && value !== '') env[key] = value;
      }

      const child = spawn(config.herdrBin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      live.set(ref, child);

      let finished = false;
      let closedReason = '';
      let stderrTail = '';
      const finish = (exit: TermStreamExit): void => {
        // Kontroler potrafi powiedzieć o końcu DWA razy (ramka `terminal.closed`, a zaraz
        // po niej `exit` procesu). Rejestr ma zobaczyć dokładnie jeden koniec — inaczej
        // jeden pad liczyłby się do bezpiecznika podwójnie.
        if (finished) return;
        finished = true;
        // Wyłącznie PO SOBIE: przy respawnie w mapie stoi już nowszy kontroler tego panelu.
        if (live.get(ref) === child) live.delete(ref);
        touch(ref);
        opts.onExit(exit);
      };

      const reader = createHerdrStreamReader({
        onEvent: (event) => {
          if (event.kind === 'frame') {
            opts.onData(event.bytes);
            return;
          }
          closedReason = event.reason;
          if (!TAKEOVER_RE.test(event.reason)) return;
          /*
           * Przejęcie rozstrzygamy TU, a nie przy `exit` procesu: tylko `reason` odróżnia
           * „wyrzucił nas inny kontroler" od zwykłego końca, a rejestr sam tego nie wie.
           * Nasz WŁASNY respawn też kończy się tym powodem — ale tam rejestr ma rezerwację
           * `plannedKill` i wycisza wszystko, zanim spojrzy na `fatal`.
           */
          finish({
            detail: `terminal.closed: ${truncate(event.reason)}`,
            fatal: true,
            // Zdanie dla człowieka przy przejęciu — jedyny tekst, jaki zobaczy w ramce `err` (z kodem, `msgRef`).
            sentence: say('term.taken-over'),
          });
        },
        onSkip: (reason, length) => {
          // Powód i długość — NIGDY treść linii (niesie zawartość ekranu powłoki).
          log.info(`term: controller ${ref} — ${reason} (${String(length)} chars)`);
        },
      });

      child.stdout?.on('data', (chunk: Buffer) => { reader.push(chunk); });
      child.stderr?.on('data', (chunk: Buffer) => {
        // stderr kontrolera to diagnostyka CLI (brak panelu, zła wersja), nie treść powłoki —
        // trzymamy OGON i doklejamy do powodu wyjścia, zamiast logować strumieniem.
        stderrTail = truncate(`${stderrTail}${chunk.toString('utf8')}`.trim());
      });
      child.on('error', (err: Error) => {
        finish({ detail: `spawn ${config.herdrBin}: ${redact(err)}` });
      });
      child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        const parts = [`code ${String(code ?? 0)}, signal ${String(signal ?? 0)}`];
        if (closedReason !== '') parts.push(`reason: ${truncate(closedReason)}`);
        if (stderrTail !== '') parts.push(`stderr: ${stderrTail}`);
        finish({ detail: parts.join('; ') });
      });

      /*
       * Strumień oddajemy OD RAZU po spawnie, bez czekania na pierwszą ramkę: kontroler, który
       * nie wstanie, zgłosi się przez `error`/`exit`, a bezpiecznik respawnu w rejestrze
       * policzy to jako pad. Czekanie na ramkę wisiałoby przy panelu, w którym nic się nie
       * dzieje (powłoka bez wyjścia to normalny stan). Jedyne `await` wyżej to bramka
       * własności — ta MUSI się rozstrzygnąć przed `--takeover`.
       */
      return makeStream(child, ref, () => !finished);
    },

    listSessions: async (): Promise<TermBackendSession[]> => {
      const client = options.launchClient();
      // Brak gniazda = nic nie wiemy o panelach. Fail-closed: pusta lista nie adoptuje
      // i nie zabija niczego (odpowiednik „no server running" w tmuksie).
      if (client === null) return [];
      const panes = await client.listPanes();
      // Inwentarz obecności do prune — powód przy `pruneState`. Bez niego (awaria odczytu) plik
      // zostaje bez kasowania: lepiej wpis-śmieć niż utracony katalog powstania żywego panelu.
      let present: ReadonlySet<string> | null = null;
      try {
        present = await client.listPaneIds();
      } catch (err: unknown) {
        log.info(
          `term: pane inventory read failed — ${TERM_HERDR_STATE_FILENAME} not pruned (${redact(err)})`,
        );
      }
      // Odczyt-scal-zapis BEZ `await` pomiędzy: świeży `touch` z równoległej ścieżki nie ginie.
      const state = readState();
      const out: TermBackendSession[] = [];
      let dirty = false;

      for (const pane of panes) {
        const id = termPaneTokenOf(pane.tokens);
        if (id === undefined || id === '') continue;
        let entry = state[pane.paneId];
        if (entry === undefined) {
          // Panel z tokenem, którego nie ma w pliku (czysty `dataDir`, zgubiony plik):
          // znacznik = TERAZ. Nigdy „nieznany = do żniw".
          entry = { seen: now(), cwd: pane.cwd };
          state[pane.paneId] = entry;
          dirty = true;
        }
        out.push({
          // Tożsamość do uchwytu bierzemy Z TOKENU panelu, bo to ona jest bramką zamykania:
          // `killSession` porówna ją ze świeżym `pane.list` i nie ruszy panelu, który w
          // międzyczasie zmienił właściciela (id paneli herdr są pozycyjne).
          // `fresh: false`: to są panele ZASTANE (adopcja i żniwa), nigdy świeżo założone.
          handle: { ref: pane.paneId, id, fresh: false },
          cwd: entry.cwd !== '' ? entry.cwd : pane.cwd,
          id,
          activityEpochSec: Math.floor(entry.seen / 1000),
          attached: live.has(pane.paneId),
        });
      }

      // Wpisy po panelach, których herdr już nie ma, są śmieciem — plik ma nie puchnąć przez rok.
      // Panel, który wróci, dostanie znacznik `now` przy najbliższym odczycie.
      if (present !== null) {
        for (const paneId of Object.keys(state)) {
          if (present.has(paneId)) continue;
          delete state[paneId];
          dirty = true;
        }
      }
      if (dirty) writeState(state);
      return out;
    },

    processName: (handle: TermSessionHandle): string => {
      const key = procKey(handle);
      const hit = procCache.get(key);
      if (hit === undefined || now() - hit.at >= TERM_PROC_TTL_MS) {
        procQueue.set(key, handle);
        if (!procScheduled) {
          procScheduled = true;
          /*
           * `queueMicrotask`, żeby odczyt ruszył PO ODPOWIEDZI: router woła `list()`
           * i `sendJson()` w jednym bloku synchronicznym, więc mikrozadanie wykonuje się już
           * po zapisaniu ciała do gniazda. Zwykłe `void refresh…()` startowałoby pierwszy
           * `await` przed nim — i tak nie blokując, ale ta kolejność jest częścią kontraktu
           * „`GET /api/term` nie czeka na herdr", więc wolno ją widzieć w kodzie.
           *
           * Sklejenie całej listy w JEDNĄ turę jest tu darmowe: wszystkie wywołania
           * `processName` z jednego `list()` lądują w kolejce, zanim mikrozadanie ruszy.
           */
          queueMicrotask(() => {
            /*
             * Flaga puszcza dopiero w `finally`, czyli po CAŁEJ turze. Zerowana na początku
             * `refreshProcessNames` nie chroniłaby tury,
             * która jest w locie: dwa urządzenia pollujące `GET /api/term` 100 ms po sobie
             * widziałyby wpisy `procCache` wciąż przeterminowane (nic jeszcze nie zapisano)
             * i planowały DRUGĄ, równoległą turę — kolejny `pane.list` plus
             * `pane.process_info` na każdy terminal. Przy suficie `RAROG_TERM_MAX` i trzech
             * urządzeniach to kilkanaście nadmiarowych odczytów w oknie 5 s, wbrew własnemu
             * komentarzowi TTL („jeden odczyt na poll i ani jednego więcej") i wbrew regule
             * „Rarog nie prowadzi pomp do control-plane'u herdr".
             *
             * Uchwyty, które w tym czasie dołożyły się do `procQueue`, NIE giną: kolejka jest
             * czytana na początku tury, a wpisy dorzucone później zostają w mapie i pojedzie
             * po nie NASTĘPNY poll (najdalej za `TERM_PROC_TTL_MS`).
             */
            void refreshProcessNames()
              .catch((err: unknown) => {
                log.info(`term: process name refresh failed (${redact(err)})`);
              })
              .finally(() => { procScheduled = false; });
          });
        }
      }
      return hit?.name ?? '';
    },

    killSession: async (handle: TermSessionHandle): Promise<void> => {
      const client = requireClient();
      /*
       * BRAMKA `pane.close` (allow-lista gniazda): zamykamy wyłącznie panel, który
       * NOSI TOKEN TEGO TERMINALA. Świeży odczyt `pane.list`, a nie pamięć rejestru —
       * identyfikatory paneli herdr są pozycyjne (`w15:p1`), więc uchwyt sprzed restartu herdr
       * mógłby wskazywać dziś cudzy panel (`docs/security-model.md`).
       *
       * Porównujemy WARTOŚĆ tokenu, nie samą jego obecność: obecność broni
       * tylko przed zamknięciem panelu człowieka, a pod tym samym adresem może dziś stać INNY
       * terminal Raroga — i `DELETE /api/term/:id` zabiłby powłokę cudzego projektu razem
       * z pracą w niej. Tożsamość terminala niesie uchwyt (`handle.id`).
       */
      const panes = await client.listPanes();
      const target = panes.find((pane) => pane.paneId === handle.ref);
      // Cache nazwy procesu ginie w OBU gałęziach: po zamknięciu nie ma czego etykietować,
      // a przy cudzym panelu wpis i tak przestał być prawdą.
      procCache.delete(procKey(handle));
      procQueue.delete(procKey(handle));
      if (target === undefined || termPaneTokenOf(target.tokens) !== handle.id) {
        log.info(
          `term: skipping close of ${handle.ref} — the pane does not carry`
          + ` this terminal's ${RAROG_TERM_TOKEN} token`,
        );
        forget(handle.ref);
        return;
      }
      await client.closePane(handle.ref);
      forget(handle.ref);
    },

    refreshSession: async (handle: TermSessionHandle): Promise<boolean> => {
      /*
       * Ta sama bramka własności co przy `attach` i `killSession`: świeży `pane.list`, WARTOŚĆ
       * tokenu równa tożsamości uchwytu. Panel bez tokenu NIE dostaje go z powrotem z pamięci
       * rejestru — id paneli herdr są pozycyjne, więc pod starym adresem może dziś stać powłoka
       * człowieka, a stempel czyniłby ją naszą (i podatną na `--takeover`). Jedyną drogą powrotu
       * tokenu jest etykieta PANELU (`reconcile`), która jedzie z panelem, nie z adresem.
       *
       * Bez `touch`: znacznik `seen` liczy ciszę dla żniwiarza, a timer nie jest aktywnością.
       */
      const client = requireClient();
      const target = (await client.listPanes()).find((pane) => pane.paneId === handle.ref);
      if (target === undefined || termPaneTokenOf(target.tokens) !== handle.id) return false;
      await stampToken(client, handle.ref, handle.id);
      return true;
    },

    readHistory: async (handle: TermSessionHandle, lines: number): Promise<TermHistory> => {
      const client = requireClient();
      /*
       * BRAMKA WŁASNOŚCI PRZED ODCZYTEM — ta sama co przy `attach` i `killSession`, i tu
       * waży NAJWIĘCEJ: `pane.read` oddaje TREŚĆ powłoki, więc panel spod nieaktualnego
       * adresu wysłałby człowiekowi cudzy scrollback (klucz w komendzie, `.env` na ekranie).
       * Świeży `pane.list` i porównanie WARTOŚCI tokenu `rarog-term` z tożsamością uchwytu —
       * nigdy pamięć rejestru, bo id paneli herdr są pozycyjne (`w15:p1`).
       *
       * Odczyt NIE pyta `refusal()`: `pane.read` jest metodą czytającą (`READ_METHODS`),
       * więc historia ma wychodzić także przy `RAROG_HERDR_SEND=0` („widzę, nie ruszam").
       */
      const target = (await client.listPanes()).find((pane) => pane.paneId === handle.ref);
      if (target === undefined || termPaneTokenOf(target.tokens) !== handle.id) {
        throw new TermHandleStaleError(
          `term: pane ${handle.ref} is no longer terminal ${handle.id} — not reading history`,
        );
      }
      // Do logu idzie WYŁĄCZNIE cykl życia (adres panelu i liczba zamówionych linii) —
      // ani jeden znak historii; to ta sama reguła co przy bajtach strumienia.
      log.info(`term: pane history ${handle.ref} (${String(lines)} lines)`);
      return await client.readPaneHistory(handle.ref, lines);
    },
  };
}
