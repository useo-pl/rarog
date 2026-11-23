/**
 * The consent channel's digit gate for a card from the screen or jsonl: the effective channel mode, whether
 * the digit of a card is blocked (`consentDigitBlocked` in `router.ts`), and the consent card without its allow
 * button in channel mode, with the reason of a card without that button (`screen-unavailable.ts`). Pure functions
 * over explicit arguments: the driver facade passes its dependencies and the registry class. Card wait for a channel
 * card and the channel observation live in `drivers/herdr/consent-channel.ts`.
 */
import type { CliDialogClass } from '@rarog/shared';
import type { ActiveReq, DecisionCard } from './cards/build.ts';
import type { ConsentDeskRelease } from './layer1/desk-reason.ts';
import type { ConsentEffectiveMode } from './layer1/mode.ts';
import { consentDigitBlocked } from './router.ts';
import { screenCardUnavailable } from './screen-unavailable.ts';

/**
 * The mode source and the desk release lookup of the driver's dependencies (`HerdrDriverDeps.consentMode`,
 * `consentDeskRelease`); they satisfy it as they are.
 */
export interface ConsentGateSource {
  readonly consentMode?: () => ConsentEffectiveMode;
  readonly consentDeskRelease?: (engineSessionId: string, key: string) => ConsentDeskRelease | null;
}

/** The session of the card: the engine session (key of the desk release lookup) and the pane's `cwd`. */
export interface ConsentGateSession {
  readonly engineSessionId: string;
  readonly cwd: string;
}

/** Tryb efektywny kanału zgód albo `null` (źródło rzuciło: tryb nieznany, liczony jak `main`). */
export function consentModeNow(deps: ConsentGateSource): ConsentEffectiveMode | null {
  const source = deps.consentMode;
  if (source === undefined) return 'off';
  try {
    return source();
  } catch {
    return null;
  }
}

/**
 * Bramka cyfry trybu kanału dla karty `card` ({@link consentDigitBlocked}); wyjątek = cyfra zablokowana.
 * `cliDialog` is the registry class of the standing dialog (`CliReserve.cliWaiting`).
 */
export function consentDigitRefused(
  deps: ConsentGateSource, cliDialog: CliDialogClass | null, card: Pick<ActiveReq, 'toolName' | 'measuredConsent'>,
  consent: boolean,
): boolean {
  try {
    return consentDigitBlocked({
      mode: consentModeNow(deps), cliDialog, toolName: card.toolName, consent,
      measured: card.measuredConsent,
    });
  } catch {
    return true;
  }
}

/**
 * Karta zgody w trybie kanału (`main`): bez przycisku zgody i bez „nie pytaj więcej”, bo cyfra i tak by nie wyszła
 * ({@link consentDigitRefused}). Każda inna karta i każdy inny tryb bez zmian. A consent card that has no approve
 * button for that or for its text also carries the reason (`unavailable`, `screen-unavailable.ts`).
 */
export function consentOnlyEvent(
  event: DecisionCard['event'], active: ActiveReq, deps: ConsentGateSource, cliDialog: CliDialogClass | null,
  session: ConsentGateSession,
): DecisionCard['event'] {
  if (event.type !== 'permission-request') return event;
  const blocked = consentDigitRefused(deps, cliDialog, active, true);
  const unavailable = screenCardUnavailable({
    input: event.input, displayText: event.displayText, truncation: event.truncation, blocked,
    mode: consentModeNow(deps), origin: active.origin, release: deskReleaseOf(deps, session, active),
    sessionCwd: session.cwd,
  });
  const reason = unavailable === undefined ? {} : { unavailable };
  if (!blocked) return { ...event, ...reason };
  const { alwaysLabel: _always, ...rest } = event;
  void _always;
  return { ...rest, canAllow: false, ...reason };
}

/** The desk release of the card's call key (`ActiveReq.origin.callKey`); no key, no source or an exception = `null`. */
function deskReleaseOf(
  deps: ConsentGateSource, session: ConsentGateSession, active: ActiveReq,
): ConsentDeskRelease | null {
  const key = active.origin?.callKey;
  if (key === undefined || deps.consentDeskRelease === undefined) return null;
  try {
    return deps.consentDeskRelease(session.engineSessionId, key);
  } catch {
    return null;
  }
}
