/**
 * Transkrypt panelu: follower jsonl i puls katalogu sesji (S-live) — moduł drivera herdr.
 *
 * Dwa NIEZALEŻNE źródła jednej odpowiedzi na pytanie „czy to jeszcze żyje": follower czyta
 * JEDEN plik rozmowy, puls ogląda katalog obok niego. Moduł trzyma ich kontrakt (fabryki),
 * stałe progów i CZYSTE mapowanie „meldunek → zdarzenie protokołu"; wiring cyklu życia
 * (kiedy follower powstaje, kiedy `repoint`, kiedy `close`) zostaje w fasadzie
 * `drivers/herdr-driver.ts`, bo to ona zna zdarzenia uchwytu agenta.
 *
 * Dedup pulsu jedzie na JAWNYM stanie (`PulseEcho`) podawanym z fasady — jedno pole, jedna
 * prawda o tym, co ostatnio poszło na wiersz aktywności.
 */
import type { ActivityPhase } from '@rarog/shared';
import { say } from '@rarog/shared/sentences';
import type { DriverEvent } from '../types.ts';
import { locateConsentCheckpoint } from '../../herdr/consent-evidence.ts';
import type { ConsentEvidenceIo } from '../../herdr/consent-evidence.ts';
import type { ConsentCheckpoint } from '../../herdr/dialogs/layer1/contract.ts';
import type { JsonlFollower } from '../../herdr/jsonl-follow.ts';
import type { JsonlMeta } from '../../herdr/jsonl-pending.ts';
import { createJsonlFollower } from '../../herdr/jsonl-follow.ts';
import { createSessionPulse } from '../../herdr/session-pulse.ts';
import type { PulseSample, SessionPulse } from '../../herdr/session-pulse.ts';

/**
 * Nazwa „narzędzia" dla pulsu z przebiegu workflow…
 *
 * To MUSZĄ być nazwy z `DELEGATING_TOOLS`, a nie etykiety dla człowieka: klient rozpoznaje po
 * nich wiersz delegacji i dopiero on decyduje, jak to brzmi po polsku.
 * Wcześniej stało tu polskie „Subagenci", przez co PWA nie trafiała w swoją gałąź i pokazywała
 * dosłownie „uruchamia: Subagenci: 4 agenci pracują".
 */
export const WORKFLOW_ACTIVITY_TOOL = 'Workflow';
/** …i dla subagentów spoza workflow (pojedyncze `Task`/`Agent`). */
export const SUBAGENTS_ACTIVITY_TOOL = 'Agent';

/**
 * Ile ciszy w jsonl musi minąć, zanim puls przejmie wiersz aktywności.
 *
 * Bez tego progu puls (co 3 s) i realne zdarzenia z pliku biłyby się o ten sam wiersz w środku
 * gęstej tury — a wtedy „4 agentów pracuje" zasłaniałoby świeży `Edit`, który właśnie się stał.
 * Jedno okno throttle'a wystarcza: dopóki plik żyje, pokazujemy plik.
 */
export const PULSE_QUIET_MS = 3_000;

/**
 * Po tylu ms ciszy w jsonl sam RUCH w katalogu sesji jest już wart wiersza „pracuje".
 *
 * Próg jest wyższy niż `PULSE_QUIET_MS`, bo to zdarzenie jest słabsze: nie wiemy, kto pisze,
 * wiemy tylko, że coś rośnie. Poniżej 10 s cisza jest normalną przerwą między narzędziami
 * i mówienie o niej cokolwiek byłoby szumem. **Nic nie rośnie = nie wysyłamy nic** — Rarog ma
 * nie udawać życia, którego nie widzi.
 */
export const PULSE_SILENCE_MS = 10_000;

/**
 * Co ile POWTARZAMY ten sam wiersz pulsu, gdy nic się w nim nie zmienia.
 *
 * Puls bije co 3 s, ale „4 agentów pracuje" wysłane dwadzieścia razy pod rząd to dwadzieścia
 * ramek SSE mówiących to samo — razy liczba paneli w turze. Licznik sekund tyka lokalnie
 * w kliencie, więc powtórka niczego nie odświeża; potrzebna jest tylko po to, żeby klient, który
 * właśnie się podłączył, nie czekał na zmianę liczby agentów.
 */
export const PULSE_REFRESH_MS = 30_000;

/**
 * Pliku transkryptu nie ma po karencji. Docs `errors.md` podają dwie przyczyny „Transcript saving is off”:
 * odziedziczony `CLAUDE_CODE_CHILD_SESSION` i ustawiony `CLAUDE_CODE_SKIP_PROMPT_HISTORY`.
 */
export const NO_TRANSCRIPT_MESSAGE = say('transcript.no-transcript');

/**
 * Fabryka followera transkryptu (testy podstawiają katalog tymczasowy). `promptBlock: false` jedzie tylko przy
 * wyłączonym rozpoznaniu promptu zablokowanego przez hook (`RAROG_PROMPT_BLOCK=0`).
 */
export type FollowerFactory = (opts: {
  cwd: string; agentSessionId: string; knownContextLimit?: number; promptBlock?: false;
}) => JsonlFollower;

/**
 * Fabryka pulsu katalogu sesji (S-live). Osobna od {@link FollowerFactory}, bo to DRUGIE,
 * niezależne źródło: follower czyta jeden plik, puls ogląda katalog obok niego.
 */
export type PulseFactory = (opts: {
  cwd: string; agentSessionId: string; onPulse: (sample: PulseSample) => void;
}) => SessionPulse;

/** Follower dla jednego panelu; limit okna jedzie dalej TYLKO, gdy Rarog go zna
 * („Session fields and herdr frames” w `docs/implementation-spec.md`). */
export function openFollower(
  make: FollowerFactory | undefined,
  opts: { cwd: string; agentSessionId: string; knownContextLimit?: number; promptBlock?: false },
): JsonlFollower {
  const args: { cwd: string; agentSessionId: string; knownContextLimit?: number; promptBlock?: false } = {
    cwd: opts.cwd, agentSessionId: opts.agentSessionId,
  };
  if (opts.knownContextLimit !== undefined) args.knownContextLimit = opts.knownContextLimit;
  if (opts.promptBlock === false) args.promptBlock = false;
  return (make ?? createJsonlFollower)(args);
}

/**
 * Checkpoint przeglądu dowodów kanału zgód (warstwa 1) dla tury `promptId` panelu: pozycja followera
 * (`transcriptOffset`) jako podpowiedź, od której `herdr/consent-evidence.ts` szuka wstecz początku tury. `null` =
 * follower bez pliku albo bez odczytu (przegląd ruszy od początku pliku, gdy ten się znajdzie).
 */
export async function consentCheckpointFor(
  follower: JsonlFollower, sessionId: string, promptId: string, io?: ConsentEvidenceIo,
): Promise<ConsentCheckpoint | null> {
  const offset = follower.transcriptOffset?.() ?? null;
  if (offset === null) return null;
  return locateConsentCheckpoint(offset.file, sessionId, promptId, offset.lineStart, io);
}

/** Puls katalogu sesji dla jednego panelu. */
export function openPulse(
  make: PulseFactory | undefined,
  opts: { cwd: string; agentSessionId: string; onPulse: (sample: PulseSample) => void },
): SessionPulse {
  return (make ?? createSessionPulse)(opts);
}

/**
 * Model, effort i ultracode z jsonl → `init`, albo `null`, gdy plik nie powiedział nic nowego.
 *
 * The follower's `meta` carries a model or effort only when the file newly said it; an absent model becomes
 * `model: ''`, which the manager reads as "no change", so a flush caused by ultracode or the mode alone keeps the
 * card's values.
 *
 * Ultracode jedzie tylko z dowodem bieżącego procesu CLI (`JsonlMeta.ultracode`); brak pola w `init` znaczy
 * dla managera „bez zmiany”, nie „wyłączone”, a `null` („dowód przestał się liczyć”) zdejmuje pole z karty.
 *
 * **Trybu z jsonl NIE przepuszczamy dalej** i to jest decyzja bezpieczeństwa, nie
 * przeoczenie: `agent-state.mode` ląduje w `session.herdrMode`, a `session.herdrMode` jest
 * DZIŚ argumentem `assertSendable` w `#sendToHerdr` (`manager.ts`), czyli bramką wysyłki.
 * Wpisy `permission-mode` powstają PO turze, więc `shift+tab` naciśnięty przy biurku między
 * turami byłby w pliku niewidoczny — panel przełączony na `bypass permissions` wyglądałby
 * dla bramki na `manual`. Do bramki tryb bierze się z odczytu stopki; chip w UI
 * dostaje go tą samą drogą.
 */
export function metaInitEvent(meta: JsonlMeta, engineSessionId: string): DriverEvent | null {
  if (meta.model === undefined && meta.effort === undefined && meta.ultracode === undefined) return null;
  const event: Extract<DriverEvent, { type: 'init' }> = {
    type: 'init',
    engineSessionId,
    model: meta.model ?? '',
  };
  if (meta.effort !== undefined) event.effort = meta.effort;
  if (meta.ultracode !== undefined) event.ultracode = meta.ultracode;
  return event;
}

/** Co ostatnio poszło na wiersz aktywności z PULSU — jawny stan dedupu, właścicielem fasada. */
export interface PulseEcho {
  key: string;
  at: number;
}

export function createPulseEcho(): PulseEcho {
  return { key: '', at: 0 };
}

/**
 * Wiersz z PLIKU zastępuje wiersz z pulsu, więc dedup zaczyna się od nowa — inaczej po jednym
 * `Edit` w środku workflow „4 agentów pracuje" nie wróciłoby przez pół minuty.
 */
export function resetPulseEcho(echo: PulseEcho): void {
  echo.key = '';
}

/** Czy ten sam wiersz pulsu leciał niedawno? Trafienie = cisza w SSE (licznik tyka w kliencie). */
function pulseRepeats(echo: PulseEcho, key: string, now: number): boolean {
  if (key === echo.key && now - echo.at < PULSE_REFRESH_MS) return true;
  echo.key = key;
  echo.at = now;
  return false;
}

/**
 * Meldunek pulsu → wiersz aktywności (albo `null`, gdy nie ma o czym mówić).
 *
 * Dwa warianty, bo dwa różne fakty:
 *
 * 1. **Rosną transkrypty subagentów** — wiemy ILU ich pracuje i (dla workflow) JAK się nazywa
 *    przebieg. To jest pełnoprawny wiersz narzędzia.
 * 2. **Rośnie coś innego** (journal, wynik narzędzia) — wiemy tylko tyle, że sesja żyje.
 *    Wtedy `thinking` z licznikiem ciszy: żadnej nazwy, żadnej liczby agentów, bo ich nie znamy.
 *
 * Obu wariantów NIE wysyłamy, dopóki plik rozmowy sam mówi (`PULSE_QUIET_MS`) — dopóki żyje
 * jsonl, pokazujemy jsonl. Licznik na wierszu mierzy CISZĘ W PLIKU, a nie wiek pulsu: to jest
 * ta liczba, o którą pyta człowiek patrzący na nieruchomy ekran („ile już tak stoi").
 *
 * The second variant also waits while the follower has an open tool call (`moment.openTools`): the row shows that
 * call, and a long tool grows files next to the transcript (its output, the journal) without the model thinking.
 * Unknown open calls (`null` or absent) do not hold it back. The first variant does not wait: a delegating call stays
 * open for the whole time its subagents work.
 */
export function pulseActivity(
  echo: PulseEcho,
  sample: PulseSample,
  moment: { now: number; silentFor: number; openTools?: readonly unknown[] | null },
  /**
   * Fakty o fazach przebiegu `sample.runId` z cache'u rozkładu (`phaseCounts`), doklejane przez
   * driver; `null` = nie znamy planu i pola w evencie nie ma (klient liczy z samych agentów).
   */
  phases: ActivityPhase[] | null = null,
): DriverEvent | null {
  const { now, silentFor } = moment;
  if (silentFor < PULSE_QUIET_MS) return null;
  const elapsedSeconds = Math.round(silentFor / 1000);

  if (sample.agents > 0) {
    const workflow = sample.workflowName;
    // Lecą FAKTY (ile agentów, jak się nazywa przebieg), a nie gotowe zdanie: odmiana
    // liczebnika należy do klienta, gdzie stoi cała reszta polszczyzny. Serwer
    // budujący copy znaczyłby dwie prawdy o tym samym wierszu — i dokładnie tak było.
    const activity: Extract<DriverEvent, { type: 'activity' }> = {
      type: 'activity',
      kind: 'tool',
      toolName: workflow === undefined ? SUBAGENTS_ACTIVITY_TOOL : WORKFLOW_ACTIVITY_TOOL,
      agents: sample.agents,
      elapsedSeconds,
      // Klient rozpoznaje wiersz delegacji po tym polu, a nie po nazwie narzędzia.
      delegation: workflow === undefined ? 'agents' : 'workflow',
    };
    if (workflow !== undefined) activity.workflow = workflow;
    if (sample.agentsDone !== undefined) activity.agentsDone = sample.agentsDone;
    if (phases !== null) activity.phases = phases;
    // Fazy wchodzą do klucza dedup: agent kończący fazę to zmiana paska, choć liczby agentów stoją.
    const key = `${activity.toolName ?? ''}|${String(sample.agents)}|${workflow ?? ''}`
      + `|${String(sample.agentsDone ?? '')}|${phases === null ? '' : JSON.stringify(phases)}`;
    return pulseRepeats(echo, key, now) ? null : activity;
  }

  // Sam ruch w katalogu: to za mało na „N agentów", ale dość na „ta sesja nie stoi".
  if (silentFor < PULSE_SILENCE_MS) return null;
  if ((moment.openTools?.length ?? 0) > 0) return null;
  if (pulseRepeats(echo, 'thinking', now)) return null;
  return { type: 'activity', kind: 'thinking', elapsedSeconds };
}
