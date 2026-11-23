/**
 * On/off switches and preferences without their own area module: refusal dumps, notes, the Codex row, CLI waiting,
 * git file details, subagent files, the deferred echo, the blocked prompt, SSE compression, the voice agent, the PR
 * status and the consent channel's restart grace. The
 * consent channel, dialog layer 2 and tall dialog guard flags stay in `server/src/config.ts`.
 */
import {
  COMPANION_ENV, COMPANION_MODEL_ENV, COMPANION_SESSIONS_ENV, CONSENT_RESTART_GRACE_ENV, ConfigError, PR_STATUS_ENV,
  SSE_GZIP_ENV,
} from '../config-env.ts';
import { HOOK_RESTART_GRACE_DEFAULT_MS, HOOK_RESTART_GRACE_MAX_MS } from '../herdr/dialogs/hook/contract.ts';

/**
 * Restart grace of the consent channel in ms from whole seconds (`RAROG_CONSENT_RESTART_GRACE`); no value = 45 s,
 * `0` = no grace. Only whole seconds up to the ceiling (600 s): any other value stops the start instead of falling
 * back to the default.
 */
export function parseConsentRestartGrace(raw: string | undefined): number {
  const value = raw?.trim() ?? '';
  if (value === '') return HOOK_RESTART_GRACE_DEFAULT_MS;
  const ms = /^\d{1,6}$/.test(value) ? Number(value) * 1000 : Number.NaN;
  if (ms <= HOOK_RESTART_GRACE_MAX_MS) return ms;
  throw new ConfigError(
    `${CONSENT_RESTART_GRACE_ENV} takes whole seconds from 0 to ${String(HOOK_RESTART_GRACE_MAX_MS / 1000)}`
    + ` (got: ${value}).`,
  );
}

/**
 * Killswitch zrzutów diagnostycznych odmów; brak wartości = WŁĄCZONE.
 *
 * Domyślne „włączone" jest tu świadome: katalog ma retencję (48 h) i sufit (200 plików),
 * a bez niego jedna odmowa to dzień śledztwa. Wyłączenie zostawia Rarogowi
 * `herdr-audit.log` z samym powodem — mniej, ale nadal liczby odmów.
 */
export function parseRefusalDumps(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  return !(raw === '0' || raw === 'false');
}

/**
 * Killswitch notatek projektu; brak wartości = WŁĄCZONE.
 *
 * Domyślne „włączone" jest tu asymetrią wobec `RAROG_TERM` i asymetria ta jest świadoma:
 * notatka niczego nie uruchamia, nie pisze do cudzego panelu i nie wychodzi poza `dataDir`.
 * Wyłącznik istnieje dla jednej ceny, której nie opisuje żaden inny killswitch — trwałej
 * treści bez retencji na dysku Maca (`docs/security-model.md`).
 */
export function parseNotesEnabled(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  return !(raw === '0' || raw === 'false');
}

/**
 * Flaga wiersza Codexa; brak wartości = WŁĄCZONE.
 *
 * Domyślne „włączone" jest tu tańsze niż przy którymkolwiek killswitchu: wpis Codexa NIE
 * dokłada Rarogowi żadnej władzy (zero wysyłki, zero odczytu ekranu, `inScope: false` na
 * sztywno), a jedyne, co zmienia, to liczba wierszy w sidebarze i adresaci pusha. `0` ukrywa
 * wiersze Codexa.
 */
export function parseCodexStatusEnabled(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  return !(raw === '0' || raw === 'false');
}

/** Preferencja wykrycia dialogu z rejestru CLI; brak wartości = WŁĄCZONE. */
export function parseCliWaiting(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  return !(raw === '0' || raw === 'false');
}

/** Preferencja szczegółów plików w ramce `git-status`; brak wartości = WŁĄCZONE. */
export function parseGitFileDetails(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  return !(raw === '0' || raw === 'false');
}

/** Preferencja odczytu plików rozmów subagentów; brak wartości = WŁĄCZONE. */
export function parseAgentFiles(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  return !(raw === '0' || raw === 'false');
}

/** Preferencja echa odroczonego; brak wartości = WŁĄCZONE. */
export function parseQueueEcho(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  return !(raw === '0' || raw === 'false');
}

/** Rozpoznanie promptu zablokowanego przez hook; brak wartości = WŁĄCZONE, `0`/`false` wyłącza. */
export function parsePromptBlock(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  return !(raw === '0' || raw === 'false');
}

/** SSE compression flag; missing, empty or `1` = on, `0` = off, any other value stops the start. */
export function parseSseGzip(raw: string | undefined): boolean {
  const value = raw?.trim() ?? '';
  if (value === '' || value === '1') return true;
  if (value === '0') return false;
  throw new ConfigError(`${SSE_GZIP_ENV} takes 1 or 0 (got: ${value}).`);
}

/** PR status flag (`docs/pull-requests.md`); missing, empty or `1` = on, `0` = off, any other value stops the start. */
export function parsePrStatusEnabled(raw: string | undefined): boolean {
  const value = raw?.trim() ?? '';
  if (value === '' || value === '1') return true;
  if (value === '0') return false;
  throw new ConfigError(`${PR_STATUS_ENV} takes 1 or 0 (got: ${value}).`);
}

/** Voice agent flag; missing or `0` = off, `1` = on, any other value stops the start. */
export function parseCompanionEnabled(raw: string | undefined): boolean {
  const value = raw?.trim() ?? '';
  if (value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new ConfigError(`${COMPANION_ENV} takes 1 or 0 (got: ${value}).`);
}

/** Flag of the voice agent's mode across sessions; missing or `0` = off, `1` = on, any other value stops the start. */
export function parseCompanionSessionsEnabled(raw: string | undefined): boolean {
  const value = raw?.trim() ?? '';
  if (value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new ConfigError(`${COMPANION_SESSIONS_ENV} takes 1 or 0 (got: ${value}).`);
}

/** OpenAI Realtime model of the voice agent when `RAROG_COMPANION_MODEL` is missing. */
export const COMPANION_MODEL_DEFAULT = 'gpt-realtime-2.1';

/** Shape of a Realtime model name; `rarog voice-agent set-model` checks the same pattern. */
export const COMPANION_MODEL_PATTERN = /^gpt-realtime[a-z0-9.-]*$/;

/**
 * Voice agent model; missing or blank = {@link COMPANION_MODEL_DEFAULT}, a name outside the pattern stops the
 * start.
 */
export function parseCompanionModel(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (value === '') return COMPANION_MODEL_DEFAULT;
  if (COMPANION_MODEL_PATTERN.test(value)) return value;
  throw new ConfigError(`${COMPANION_MODEL_ENV} takes an OpenAI Realtime model name (gpt-realtime…), got: ${value}.`);
}
