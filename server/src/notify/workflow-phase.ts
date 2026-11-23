/**
 * Bieżąca faza planu workflow. Serwer potrzebuje jej do stanu Live Activity („faza 2/5 Serwer").
 * Tę samą regułę dla kart liczy apka (`ActivityText.currentPhase` w RarogUI). Wektory trzyma
 * `server/test/workflow-phase.test.ts`.
 *
 * Reguła: PIERWSZA faza w kolejności skryptu z agentem, który jeszcze pracuje; gdy wszyscy
 * skończyli — OSTATNIA, w której ktokolwiek ruszył; `null`, gdy żadna faza nie ma agentów.
 */
import type { ActivityPhase } from '@rarog/shared';

export function currentPhase(
  phases: readonly ActivityPhase[],
): { index: number; title: string } | null {
  const running = phases.findIndex((phase) => phase.agents > phase.done);
  if (running !== -1) return { index: running, title: phases[running]?.title ?? '' };
  for (let i = phases.length - 1; i >= 0; i -= 1) {
    const phase = phases[i];
    if (phase !== undefined && phase.agents > 0) return { index: i, title: phase.title };
  }
  return null;
}
