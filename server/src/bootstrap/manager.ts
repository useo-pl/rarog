/**
 * Server start: what the session manager gets, other than the consent channel ports, which `main()` in
 * `server/src/index.ts` adds itself. Also the Claude SDK for the "Recent sessions" list, loaded once before
 * `listen()`.
 */
import type { RarogConfig } from '../config.ts';
import { readAccountDefaultEffort, readAccountDefaultModel } from '../config.ts';
import type { CliVersionReader } from '../cli-version.ts';
import type { DemoContent, DemoReviewConstants } from '../demo/content/types.ts';
import { loadListSessions, sdkLogLine } from '../install/sdk.ts';
import type { LoadedSdk } from '../install/sdk.ts';
import type { Notifier } from '../notify/index.ts';
import type { Logger } from '../router.ts';
import { createSessionListReader, engineListerOf } from '../session-list.ts';
import type { ManagerConfig } from '../sessions/manager.ts';
import type { HerdrRuntime } from './herdr.ts';

/** The SDK of the process, or `null` in the demo, which reads seeds and never touches it. */
export async function loadSdk(config: RarogConfig, log: Logger): Promise<LoadedSdk | null> {
  /*
   * SDK Claude listy „Ostatnie sesje” (`install/sdk.ts`): raz, przy starcie, przed `listen()`, z przypięciem tej
   * instalacji, więc stary proces po aktualizacji Raroga nie wczyta nowego przypięcia. Brak albo błąd SDK nie
   * zatrzymuje startu: serwer działa bez listy sesji, a stan mówią log, `/health` (`sdk`) i `rarog doctor`. Demo ma
   * czytnik z seedów i SDK nie dotyka.
   */
  let sdk: LoadedSdk | null = null;
  if (!config.demo) {
    sdk = await loadListSessions({ dataDir: config.dataDir });
    const line = sdkLogLine(sdk.status);
    if (sdk.status.state === 'ok') log.info(line);
    else log.error(line);
  }
  return sdk;
}

export interface ManagerAssembly {
  readonly config: RarogConfig;
  readonly demoContent: DemoContent | null;
  readonly system: ManagerConfig['system'];
  readonly sdk: LoadedSdk | null;
  readonly log: Logger;
  readonly notifier: Notifier | null;
  /** Constants of the review demo, or `null` outside it. */
  readonly reviewConstants: DemoReviewConstants | null;
  readonly cliVersionReader: CliVersionReader | null;
  readonly herdr: HerdrRuntime | null;
}

/** Manager configuration without `consent`. */
export function managerConfig(assembly: ManagerAssembly): ManagerConfig {
  const { config, demoContent, system, sdk, log, notifier, reviewConstants, cliVersionReader, herdr } = assembly;
  const sdkList = sdk?.listSessions ?? null;
  return {
    ...config,
    ...(demoContent === null ? {} : { demoContent }),
    system,
    ...(config.demo
      ? {}
      : { resumableReader: createSessionListReader(sdkList === null ? {} : { lister: engineListerOf(sdkList) }) }),
    // State corrections from herdr ("herdr: stan X → Y") go to the server log: `config` has no `logger` field.
    // It is the only trace of an event that by definition happens when nobody is watching.
    logger: (line) => { log.info(line); },
    ...(notifier !== null ? { notifier } : {}),
    // Pigułka modelu i effortu sesji startującej bez `--model` / `--effort`: panel wstaje na
    // domyślnych konta, a te stoją w `~/.claude/settings.json` — patrz `readAccountDefault*`. Tryb recenzji
    // tego pliku nie czyta: stałe z zestawu treści.
    ...(reviewConstants === null
      ? {
        accountDefaultModel: readAccountDefaultModel,
        accountDefaultEffort: (model?: string) => readAccountDefaultEffort(model),
      }
      : { accountDefaultModel: () => reviewConstants.model, accountDefaultEffort: () => reviewConstants.effort }),
    // Wydanie Claude Code działających sesji vs zainstalowane (czytnik z `main()`, ten sam co przy `loadHerdr`).
    ...(cliVersionReader === null ? {} : { cliVersionReader }),
    ...(herdr !== null ? { herdrSupervisor: herdr.supervisor, herdrDeps: herdr.deps } : {}),
  };
}
