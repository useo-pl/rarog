/**
 * Tryb efektywny kanału zgód (warstwa 1): to, co serwer naprawdę robi z kanałem, w odróżnieniu od trybu
 * z konfiguracji (`RAROG_CONSENT_CHANNEL`, {@link ConsentModeState.configured}). Serwer publikuje go w `alive.json`
 * (hook czeka według niego), w `/health` (`consent`), w `rarog doctor` i w logu; zakres rejestru sekretów
 * (`registry.ts`, `all`/`main`/`closed`) idzie za nim.
 *
 * Reguła ({@link effectiveConsentMode}): tryb kanału (`main` albo `all`, `consentChannelOpen` z `hook/contract.ts`)
 * efektywny WYŁĄCZNIE przy komplecie warunków naraz — konfiguracja tego trybu, status hooka `ok` (wpis
 * w ustawieniach i kopia, ta sama sonda co pole `hook` w `/health`), żywe gniazdo rejestracji `consent.sock`
 * i gniazdo administracyjne `admin.sock`, ustawiony `RAROG_MIN_CLIENT_BUILD` (stara apka ogłasza zgodę po samym
 * HTTP 200) i brak wyłącznika. Inaczej `shadow` z powodem: pierwszym niespełnionym warunkiem w kolejności
 * {@link CONSENT_MODE_REASONS}. Wyjątek sondy hooka, status spoza listy i próg spoza liczb całkowitych liczą się jak
 * brak warunku, nigdy jak tryb kanału. `main` i `all` mają te same warunki. Konfiguracja `off` i `shadow` od gniazd
 * nie zależy: tryb efektywny jest skonfigurowanym od utworzenia, z powodem `configured`.
 *
 * Cykl ({@link createConsentMode}): konfiguracja trybu kanału startuje jako `off` z powodem `starting` (do gotowości
 * gniazd hook nie czeka i nie rejestruje). Rozstrzygnięcie idzie RAZ, po starcie obu gniazd
 * ({@link ConsentModeControl.resolve}); kolejne wywołania nic nie zmieniają, więc zmiana hooka albo gniazda w biegu
 * czeka na restart. Wyłącznik ({@link ConsentModeControl.kill}, `rarog dialogs off`) daje `off` z powodem
 * `killswitch` do restartu, także przed rozstrzygnięciem, i żadne późniejsze rozstrzygnięcie go nie cofa;
 * konfiguracji nie zmienia. Każda zmiana idzie do słuchaczy synchronicznie, po zmianie stanu: wołający przestawia
 * zakres rejestru i pisze `alive.json` od razu.
 *
 * Moduł bez wejścia i wyjścia poza zegarem i linią logu; opis: `docs/server-config.md`, „Preferences and feature
 * flags” (`RAROG_CONSENT_CHANNEL`).
 */
import type { HookStatus } from '../../../health.ts';
import { HOOK_CHANNEL_MODE_OFF, consentChannelOpen } from '../hook/contract.ts';
import type { HookChannelMode } from '../hook/contract.ts';

/**
 * Tryb efektywny: `off` (hook nie czeka), `shadow` (cień), `main` (kanał dla wątku głównego), `all` (kanał także dla
 * subagentów).
 */
export type ConsentEffectiveMode = 'off' | 'shadow' | 'main' | 'all';

/**
 * Powód trybu efektywnego, w kolejności sprawdzania warunków trybu kanału (`main`, `all`):
 *
 * - `configured` — tryb efektywny = skonfigurowany (także `off` i `shadow` z konfiguracji);
 * - `starting` — konfiguracja trybu kanału, gniazda jeszcze nie wstały: `off` do rozstrzygnięcia;
 * - `missing`, `mismatch`, `stale` — status hooka inny niż `ok` (te same słowa co pole `hook` w `/health`); wyjątek
 *   sondy = `missing`;
 * - `consent-socket` — gniazdo rejestracji nie wstało;
 * - `admin-socket` — gniazdo administracyjne nie wstało (bez niego nie ma `dialogs off` ani `dialogs release`);
 * - `min-client-build` — without a minimum app build (`RAROG_MIN_CLIENT_BUILD`, or the package default from
 *   server/src/config/clients.ts);
 * - `killswitch` — `rarog dialogs off`: `off` do restartu.
 */
export const CONSENT_MODE_REASONS = [
  'configured', 'starting', 'missing', 'mismatch', 'stale', 'consent-socket', 'admin-socket', 'min-client-build',
  'killswitch',
] as const;
export type ConsentModeReason = (typeof CONSENT_MODE_REASONS)[number];

export interface ConsentModeState {
  readonly configured: HookChannelMode;
  readonly effective: ConsentEffectiveMode;
  readonly reason: ConsentModeReason;
  /** Epoch ms ostatniej zmiany (utworzenie, rozstrzygnięcie, wyłącznik). */
  readonly since: number;
}

/** Tryb efektywny do odczytu: stan teraz i słuchacz zmian (zwraca funkcję wypisania). */
export interface ConsentModeSource {
  current(): ConsentModeState;
  onChange(listener: (state: ConsentModeState) => void): () => void;
}

/** Wejście rozstrzygnięcia po starcie gniazd. */
export interface ConsentModeInputs {
  /** Status hooka z sondy `/health`; wyjątek = `missing`. */
  readonly hook: () => HookStatus;
  /** Gniazdo rejestracji `consent.sock` wstało. */
  readonly consentSocket: boolean;
  /** Gniazdo administracyjne `admin.sock` wstało. */
  readonly adminSocket: boolean;
  /** `RAROG_MIN_CLIENT_BUILD`; brak = brak progu. */
  readonly minClientBuild: number | undefined;
}

export interface ConsentModeControl extends ConsentModeSource {
  /** Rozstrzygnięcie po starcie gniazd: pierwsze wywołanie liczy tryb, każde następne oddaje stan bez zmiany. */
  resolve(inputs: ConsentModeInputs): ConsentModeState;
  /** Wyłącznik: `off` z powodem `killswitch` do restartu; drugie wywołanie nic nie zmienia. */
  kill(): ConsentModeState;
}

export interface ConsentModeOptions {
  readonly configured: HookChannelMode;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** Statusy hooka inne niż `ok`, które przechodzą do powodu wprost. */
const HOOK_REASONS: ReadonlySet<string> = new Set(['missing', 'mismatch', 'stale'] satisfies ConsentModeReason[]);

/** Status hooka jako powód: `null` = `ok`; wyjątek sondy albo status spoza listy = `missing`. */
function hookReason(probe: () => HookStatus): ConsentModeReason | null {
  let status: unknown;
  try {
    status = probe();
  } catch {
    return 'missing';
  }
  if (status === 'ok') return null;
  return typeof status === 'string' && HOOK_REASONS.has(status) ? status as ConsentModeReason : 'missing';
}

/**
 * Tryb efektywny z konfiguracji i stanu po starcie gniazd (bez wyłącznika: ten trzyma {@link createConsentMode}).
 * Konfiguracja `off` i `shadow` = ona sama; `main` i `all` = ona sama przy komplecie warunków, inaczej `shadow`
 * z pierwszym niespełnionym warunkiem.
 */
export function effectiveConsentMode(
  configured: HookChannelMode, inputs: ConsentModeInputs,
): { readonly effective: ConsentEffectiveMode; readonly reason: ConsentModeReason } {
  if (!consentChannelOpen(configured)) return { effective: configured, reason: 'configured' };
  const failed: ConsentModeReason | null = hookReason(inputs.hook)
    ?? (inputs.consentSocket !== true ? 'consent-socket' : null)
    ?? (inputs.adminSocket !== true ? 'admin-socket' : null)
    ?? (typeof inputs.minClientBuild === 'number' && Number.isSafeInteger(inputs.minClientBuild)
      && inputs.minClientBuild >= 1 ? null : 'min-client-build');
  return failed === null ? { effective: configured, reason: 'configured' } : { effective: 'shadow', reason: failed };
}

export function createConsentMode(options: ConsentModeOptions): ConsentModeControl {
  const now = options.now ?? Date.now;
  const { configured } = options;
  const listeners = new Set<(state: ConsentModeState) => void>();
  let resolved = !consentChannelOpen(configured);
  let state: ConsentModeState = consentChannelOpen(configured)
    ? { configured, effective: HOOK_CHANNEL_MODE_OFF, reason: 'starting', since: now() }
    : { configured, effective: configured, reason: 'configured', since: now() };

  const change = (effective: ConsentEffectiveMode, reason: ConsentModeReason): void => {
    if (state.effective === effective && state.reason === reason) return;
    state = { configured, effective, reason, since: now() };
    options.log?.(`consent: effective mode ${effective} (configured ${configured}, reason ${reason})`);
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        options.log?.('consent: a mode change listener failed');
      }
    }
  };

  return {
    current: () => state,
    onChange: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    resolve: (inputs) => {
      if (resolved) return state;
      resolved = true;
      // Wyłącznik przed rozstrzygnięciem wygrywa: `off` zostaje do restartu.
      if (state.reason === 'killswitch') return state;
      const next = effectiveConsentMode(configured, inputs);
      change(next.effective, next.reason);
      return state;
    },
    kill: () => {
      change(HOOK_CHANNEL_MODE_OFF, 'killswitch');
      return state;
    },
  };
}
