/**
 * Fazy przebiegu workflow policzone z rozkładu — JEDNA reguła dla serwera i dla klienta.
 *
 * `phaseCounts` liczy czytnik przebiegów serwera
 * (`server/src/herdr/background/workflow-run.ts`) i wchodzi
 * do eventu `activity` (pasek na karcie sidebara). Szyna faz w bloku „w tle" potrzebuje
 * DOKŁADNIE tego samego podziału po stronie klienta: pasek nad szyną i mianownik `n/m` mają mówić
 * to samo, co pasek na karcie tej samej sesji. Druga implementacja w kliencie rozjechałaby się przy
 * pierwszym przypadku brzegowym (faza spoza planu, przebieg bez planu), więc funkcja stoi tutaj;
 * serwer importuje ją stąd i re-eksportuje dla swoich testów i wołających.
 *
 * Moduł jest CELOWO bez zoda i bez importów wartości z `protocol.ts` (same typy, kasowane przy
 * kompilacji): wchodzi do ścieżki startowej bundla, a schematy protokołu ważą tam 25 kB.
 */
import type { ActivityPhase, WorkflowRun } from './protocol.ts';

/**
 * Fakty o fazach do eventu `activity` (pasek na karcie sidebara): dla KAŻDEJ fazy
 * ze skryptu — ilu agentów w niej ruszyło i ilu skończyło. Kolejność skryptu, także fazy bez
 * agentów (zera: „jeszcze nie ruszyła" jest informacją dla ułamka postępu).
 *
 * BEZ PLANU (przebieg z `scriptPath` nie zostawia skryptu w `workflows/scripts/`,
 * więc `run.phases` jest puste, choć agenci mają tagi faz) fazy składają się z SAMYCH TAGÓW,
 * w kolejności pierwszego pojawienia się agenta. To fakty bez planu: segmentów jest tyle, ile
 * faz już ruszyło, a mianownik rośnie z każdą nową — pasek mówi „tyle z tego, co ruszyło",
 * dokładnie jak liczenie z samych agentów, tylko z podziałem na fazy. Widok sesji i tak rysuje
 * te same fazy z tagów (`workflowRows`), więc obie karty mówią jedno.
 *
 * `null`, gdy nie ma ani planu, ani tagów: ŻADEN agent bez fazy z listy (skrypt bez konwencji
 * tagów, tytuły zmienione w locie). Klient liczy wtedy z samych agentów — brak faz
 * nigdy nie jest błędem. Przy znanym planie agent z fazą spoza listy jest pomijany (widok sesji
 * dokleja go na końcu rozkładu; do ułamka nie wchodzi, bo nie wiadomo, gdzie).
 *
 * Znane ograniczenie: fazą jest TYTUŁ. Dwie fazy skryptu o tym samym tytule `parseScriptPhases`
 * skleja w jedną (tag agenta i tak nie mówi, o którą chodzi), więc ich agenci lądują w jednym
 * koszyku, a `N` jest o jeden mniejsze niż w skrypcie. Autor skryptu widzi to jako jedną fazę
 * także w `/workflows` CLI — nie udajemy, że wiemy więcej.
 */
export function phaseCounts(run: WorkflowRun): ActivityPhase[] | null {
  const planned = run.phases.length > 0;
  const counts = run.phases.map((title) => ({ title, agents: 0, done: 0 }));
  const at = new Map(run.phases.map((title, index) => [title, index]));
  let tagged = 0;
  for (const agent of run.agents) {
    if (agent.phase !== undefined && !planned && !at.has(agent.phase)) {
      at.set(agent.phase, counts.length);
      counts.push({ title: agent.phase, agents: 0, done: 0 });
    }
    const index = agent.phase === undefined ? undefined : at.get(agent.phase);
    if (index === undefined) continue;
    const phase = counts[index];
    if (phase === undefined) continue;
    tagged += 1;
    phase.agents += 1;
    if (agent.done) phase.done += 1;
  }
  return tagged === 0 ? null : counts;
}
