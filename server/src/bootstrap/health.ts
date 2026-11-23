/**
 * Server start: the `/health` probes without the consent channel field, which `main()` in
 * `server/src/index.ts` adds itself.
 */
import type { DeviceStore } from '../auth/index.ts';
import type { RarogConfig } from '../config.ts';
import type { DemoReviewConstants } from '../demo/content/types.ts';
import type { HealthProbes, HookHealth } from '../health.ts';
import { hookHealth, userSettingsPath } from '../herdr/hook-config.ts';
import type { LoadedSdk } from '../install/sdk.ts';
import type { TermFeature } from '../term/index.ts';

/**
 * Termin ważności odczytu stanu hooka dla `/health`.
 *
 * Sonda czyta dwa małe pliki (ustawienia Claude Code + znacznik w `dataDir`), ale `/health`
 * jest PUBLICZNY — bez cache'u każdy nieuwierzytelniony GET z tailnetu byłby dwoma `open()`.
 * Instalacja hooka zmienia się raz na miesiąc, a znacznik przy każdym dialogu: 5 s to i tak
 * rozdzielczość lepsza niż tempo, w jakim człowiek patrzy na health.
 */
export const HOOK_HEALTH_TTL_MS = 5_000;

/** Sonda `/health` dla hooka treści z terminem ważności — patrz {@link HOOK_HEALTH_TTL_MS}. */
export function hookHealthProbe(dataDir: string, home: string): () => HookHealth {
  const settingsPaths = [userSettingsPath(home)];
  let value: HookHealth | null = null;
  let freshUntil = 0;
  return (): HookHealth => {
    const nowMs = Date.now();
    if (value !== null && nowMs < freshUntil) return value;
    value = hookHealth({ settingsPaths, dataDir, home, nowMs });
    freshUntil = nowMs + HOOK_HEALTH_TTL_MS;
    return value;
  };
}

export interface HealthDeps {
  readonly config: RarogConfig;
  /** The herdr runtime of the process, or `null` when the integration is not assembled. */
  readonly herdr: { probe(): Promise<boolean> } | null;
  readonly term: TermFeature | null;
  /** Constants of the review demo, or `null` outside it: review mode builds no hook probe. */
  readonly reviewConstants: DemoReviewConstants | null;
  readonly devices: DeviceStore;
  readonly sdk: LoadedSdk | null;
  readonly home: string;
}

/** The probes of `/health` other than `consent`. */
export function healthProbes(deps: HealthDeps): HealthProbes {
  const { config, herdr, term, reviewConstants, devices, sdk, home } = deps;
  /*
   * Sondy `/health`. `herdr` pinguje gniazdo PER REQUEST (herdr żyje i umiera niezależnie
   * od Raroga); `term` jest wynikiem `loadTerm` z TEJ chwili — złożenie terminala nie zmienia
   * się bez restartu procesu, więc liczenie go od nowa przy każdym healthu byłoby udawaniem.
   */
  return {
    herdr: herdr === null ? (): Promise<boolean> => Promise.resolve(false) : herdr.probe,
    term: term !== null,
    // Hook treści: czy blok stoi w `~/.claude/settings.json` i kiedy ostatnio odpalił.
    // Wariant projektowy (`settings.local.json`) sprawdza `pnpm run hooks:doctor` — health
    // pyta o kanał user-wide, bo tylko on obejmuje sesje we WSZYSTKICH korzeniach Raroga.
    // Tryb recenzji bez sondy: pole `hook` mówi `missing` (`HOOK_HEALTH_UNKNOWN`).
    ...(reviewConstants === null ? { hook: hookHealthProbe(config.dataDir, home) } : {}),
    // Magazyn kluczy urządzeń: `broken` = oba pliki nieczytelne przy starcie, wszyscy parują od nowa.
    authStore: () => devices.status,
    ...(sdk !== null ? { sdk: sdk.status.state } : {}),
  };
}
