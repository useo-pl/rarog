/**
 * CLI registry reads for the consent channel, a module of the herdr driver: whether a registry signal says
 * `waiting: permission`, the report of a status without it to the consent cycle, and the registry read of a channel
 * observation. The manager signal and the screen read stay in the facade `drivers/herdr-driver.ts`; the observation
 * itself is `drivers/herdr/consent-channel.ts`.
 */
import type { CliWaitingSignal } from '../../cli-version.ts';
import { registryEvidenceFromSignal } from '../../herdr/dialogs/index.ts';

/** Contact with the facade: the driver dependencies (`HerdrDriverDeps`) satisfy it as they are. */
export interface ConsentRegistryPort {
  readonly now: () => number;
  readonly consentRegistryNotWaiting?: (engineSessionId: string, at: number) => void;
  readonly consentRegistryRead?: (engineSessionId: string) => Promise<CliWaitingSignal>;
}

/** Czy sygnał rejestru mówi `waiting` z klasą `permission` (dialog zgody na narzędzie); brak sygnału = nie. */
export function cliWaitsForPermission(signal: CliWaitingSignal | null): boolean {
  return signal?.kind === 'waiting' && signal.dialog === 'permission';
}

/**
 * A registry read `signal` of the engine session at time `at`, from any source (manager tick, consent nudge, the
 * observation's own read): without `waiting: permission` it goes to the consent cycle at once
 * (`HerdrDriverDeps.consentRegistryNotWaiting`), which drops the channel proof from registry reads not later than
 * `at`. With `waiting: permission`, without an engine session or without the port nothing; a port exception changes
 * nothing.
 */
export function noteConsentRegistryRead(
  port: ConsentRegistryPort, engineSessionId: string, signal: CliWaitingSignal, at: number,
): void {
  const note = port.consentRegistryNotWaiting;
  if (note === undefined || engineSessionId === '' || cliWaitsForPermission(signal)) return;
  try {
    note(engineSessionId, at);
  } catch {
    // Port cyklu: dowód z kanału i tak ma termin od odczytu rejestru.
  }
}

/**
 * The session registry from this observation's own read (`HerdrDriverDeps.consentRegistryRead`) with the time before
 * the query; without the port or on its exception `null`, and the facade takes the last manager signal of the session.
 * A read without `waiting: permission` goes to the cycle with that time ({@link noteConsentRegistryRead}) before this
 * returns, so the observation never goes on while an older channel proof still stands.
 */
export async function readConsentRegistry(
  port: ConsentRegistryPort, engineSessionId: string,
): Promise<ReturnType<typeof registryEvidenceFromSignal> | null> {
  const read = port.consentRegistryRead;
  if (read === undefined) return null;
  const readStartedAt = port.now();
  let signal: CliWaitingSignal;
  try {
    signal = await read(engineSessionId);
  } catch {
    // Ostatni sygnał od managera w fasadzie.
    return null;
  }
  noteConsentRegistryRead(port, engineSessionId, signal, readStartedAt);
  return registryEvidenceFromSignal(signal, readStartedAt);
}
