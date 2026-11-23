/**
 * Server start: the files in the data directory that hooks and the server share, before anything reads them. The
 * roots file of the `cwd` filter, the start cleanup of hook dumps, answer files and refusal dumps, and the rotation
 * of the guard, shadow and `alive.json` logs. A failure here is never a start failure.
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { redact } from '../auth/index.ts';
import type { RarogConfig } from '../config.ts';
import { excludedFolders } from '../config/work-area.ts';
import { sweepHookAnswers } from '../herdr/dialogs/hook/answers.ts';
import { sweepPendingHooks } from '../herdr/dialogs/hook/dump.ts';
import { sweepRefusalDumps } from '../herdr/dialogs/refusals.ts';
import { rotateAliveLog, rotateShadowLog } from '../herdr/dialogs/shadow/sweep.ts';
import { rotateGuardLog, writeHookRoots } from '../herdr/hook-config.ts';
import type { Logger } from '../router.ts';

/** Home in its on-disk form; an unresolvable one stays as the system gives it. */
function realHome(): string {
  const home = homedir();
  try {
    return realpathSync(home);
  } catch {
    return home;
  }
}

/** Writes `roots.json`, sweeps `pending/`, `answers/` and `refusals/`, rotates the logs; synchronous. */
export function prepareHookFiles(config: RarogConfig, log: Logger): void {
  /*
   * Korzenie dla filtra `cwd` w hooku treści — pisane przy KAŻDYM starcie, bo
   * `RAROG_HERDR_ROOTS` żyje w środowisku serwera, a hook (cudzy proces, cudza sesja Claude) nie ma
   * skąd znać tej zmiennej. Nieudany zapis NIE jest błędem startu: hook bez pliku po prostu
   * nigdzie nie pisze (fail-closed), a Rarog pokazuje karty z ekranu. Tym samym plikiem jedzie
   * włącznik strażnika wysokości dialogu (`RAROG_TALL_DIALOG_GUARD`).
   */
  try {
    // The folders the work area leaves out, under home in its on-disk form: the hook compares real paths.
    // Demo writes to its own data directory, which no hook reads, and touches nothing of the host's home.
    const exclude = excludedFolders(config.demo ? homedir() : realHome());
    writeHookRoots(config.dataDir, config.herdrRoots, { tallDialogGuard: config.tallDialogGuard, exclude });
    log.info(`hook: roots for the cwd filter → ${config.herdrRoots.join(', ')}`
      + ` · tall dialog guard: ${config.tallDialogGuard ? 'on' : 'off'}`);
  } catch (err: unknown) {
    log.error(`hook: could not write roots.json (${redact(err)}); the hook dumps no content.`);
  }

  /*
   * Żniwiarz zrzutów hooka. TTL działa po stronie CZYTNIKA — po terminie zrzutu
   * (10 minut, 60 dla formularza pytania i zgody `Bash`; `hook/dump.ts`) `readPendingHook` oddaje `null`,
   * ale plik z pełnym `tool_input` (komenda `Bash`, treść `Write`, cały plan) leżał w `dataDir` bezterminowo:
   * kasował go WYŁĄCZNIE `clearPendingHook` po decyzji podjętej Z RAROGA. Każdy dialog rozstrzygnięty przy
   * biurku — w każdej sesji Claude pod korzeniami Raroga, także w tych, których Rarog nigdy nie zobaczy —
   * zostawiał plik na zawsze. Start jest jedynym momentem, w którym mamy pewność, że nikt ich nie czyta.
   * Nieudane sprzątanie NIE jest błędem startu, tak samo jak zapis `roots.json`.
   */
  try {
    const swept = sweepPendingHooks(config.dataDir);
    if (swept > 0) log.info(`hook: deleted ${String(swept)} expired dumps in pending/`);
  } catch (err: unknown) {
    log.error(`hook: could not clean up pending/ (${redact(err)})`);
  }

  // Dziennik strażnika wysokości dialogu rotuje tylko serwer: hook wyłącznie dopisuje.
  if (rotateGuardLog(config.dataDir)) log.info('hook: guard.jsonl rotated to guard.jsonl.1 (over 1 MB)');
  // Tak samo dziennik cyklu trybu cienia (`docs/dialogs.md`, „Server in shadow mode”).
  if (rotateShadowLog(config.dataDir)) log.info('hook: shadow.jsonl rotated to shadow.jsonl.1 (over 8 MB)');
  // Dziennik przejść `alive.json` pisze sam serwer; rotacja przed pierwszym zapisem pisarza niżej.
  if (rotateAliveLog(config.dataDir)) log.info('shadow: alive.jsonl rotated to alive.jsonl.1 (over 8 MB)');

  /*
   * To samo dla kanału ODPOWIEDZI: plik z treścią odpowiedzi człowieka kasuje
   * hook po odczycie albo Rarog po nieudanym czekaniu — ale SIGTERM w środku tego czekania
   * zostawia go na dysku. Start jest jedynym momentem z gwarancją, że nikt go nie czyta.
   */
  try {
    const swept = sweepHookAnswers(config.dataDir);
    if (swept > 0) log.info(`hook: deleted ${String(swept)} stale files in answers/`);
  } catch (err: unknown) {
    log.error(`hook: could not clean up answers/ (${redact(err)})`);
  }

  /*
   * Żniwiarz zrzutów odmów (`docs/dialogs.md`, „Refusal diagnostics”). Chodzi ZAWSZE, także przy `RAROG_REFUSAL_DUMPS=0`:
   * wyłącznik ma opróżnić katalog przez retencję, a nie zamrozić w nim treść ekranów
   * z ostatniego uruchomienia. Drugi obrót żniwiarza siedzi w samym zapisie (sufit plików).
   */
  try {
    const swept = sweepRefusalDumps(config.dataDir);
    if (swept > 0) log.info(`refusals: deleted ${String(swept)} dumps in refusals/`);
  } catch (err: unknown) {
    log.error(`refusals: could not clean up refusals/ (${redact(err)})`);
  }
}
