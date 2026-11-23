/**
 * Strażniki identyfikatorów zadań w tle — CZYSTE, bez importów.
 *
 * Oba id pochodzą z TREŚCI plików (wynik narzędzia w transkrypcie, wpis journala) i trafiają do
 * ścieżek na dysku, więc kształt sprawdzamy przed każdym `join`: id z ukośnikiem albo `..`
 * czytałoby pliki spoza katalogu sesji.
 *
 * Osobny moduł, żeby czysty reduktor (`reducer.ts`) nie importował modułu z `node:fs`
 * (`satellite.ts`); pilnuje tego strażnik czystości w `herdr-background-boundary.test.ts`.
 */
const RUN_ID = /^wf_[A-Za-z0-9_-]+$/;
const AGENT_ID = /^[A-Za-z0-9_-]+$/;
const BACKGROUND_TASK_ID = /^[a-z0-9]{1,32}$/;

/** Identyfikator przebiegu workflow (`wf_<id>`) — zarazem nazwa katalogu przebiegu w satelicie. */
export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

/**
 * Id of a background task (`backgroundTaskId`, `<task-id>`): lower-case letters and digits, as the CLI writes it
 * for a command (`b8qecntp5`) and an agent (`a` and 16 hex digits); measured on 2.1.296. It names the output file
 * `<id>.output`.
 */
export function isBackgroundTaskId(value: string): boolean {
  return BACKGROUND_TASK_ID.test(value);
}

/** Identyfikator agenta — składnik nazw `agent-<id>.jsonl` i `agent-<id>.meta.json`. */
export function isAgentId(value: string): boolean {
  return AGENT_ID.test(value);
}
