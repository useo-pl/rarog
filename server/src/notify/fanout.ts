/**
 * Sink harmonogramu — adapter JEDNEGO kanału banerów: APNs apki natywnej.
 *
 * Harmonogram (`index.ts`) zna dokładnie jeden sink i to jest ten. Moduł robi trzy rzeczy:
 * łapie wyjątek sinka APNs (`apns-sink.ts` nie rzuca, ale to granica modułu — wyjątek to
 * `failed`, nie przerwany harmonogram), przy „skończył” zleca dźwięk z kafla Live Activity
 * i oddaje wynik jako raport per kanał plus liczbę zleceń dźwięku,
 * z których harmonogram składa linię logu wysyłki. Degradacji nie liczy nikt na tym poziomie: APNs
 * liczy ją PER TOKEN w rejestrze urządzeń (`apns-devices.ts`), a apka pyta o nią
 * `POST /api/push/apns/status`.
 *
 * Raport per kanał zostaje przy jednym kanale, bo linia logu
 * mówi nim, którym kanałem poszedł baner.
 *
 * **Ten moduł nigdy nie rzuca.**
 */
import { badgeOnly } from './apns-payload.ts';
import type { ApnsSink } from './apns-sink.ts';
import type { PushContent, SendOutcome } from './content.ts';

/** Wynik jednej wysyłki per kanał. Brak pola = tego kanału w Rarogu NIE MA (nie: „nikt nie słucha"). */
export interface ChannelReport {
  readonly apns?: SendOutcome;
}

/** Raport wysyłki dla harmonogramu: kanały banerów i dźwięk z kafla (poza mapą kanałów). */
export interface SendReport {
  readonly channels: ChannelReport;
  /**
   * Ile aktywności Live Activity dostało zlecenie dźwięku „skończył” (`live-activity.ts`, `chime`).
   * Brak pola = ta wysyłka dźwięku nie zleca (inny rodzaj niż „skończył” albo sink bez kafla).
   */
  readonly chime?: number;
}

/** Kształt sinka, który zna harmonogram: treść → raport wysyłki. */
export interface ChannelSink {
  send(content: PushContent): Promise<SendReport>;
}

export interface FanoutOptions {
  /** Sink APNs (`apns-sink.ts`); bez kompletu `RAROG_APNS_*` harmonogramu nie ma wcale (`index.ts`). */
  readonly apns: Pick<ApnsSink, 'send'>;
  /**
   * Dźwięk „skończył” z kafla (`LiveActivityController.chime`): liczba zleceń. Wołany przy KAŻDYM
   * wysłanym „skończył” (`badgeOnly`) PRZED wysyłką plakietki — ta sama chwila, te same reguły ciszy
   * harmonogramu. Brak = bez dźwięku.
   */
  readonly chime?: () => number;
}

export function createFanoutSink(options: FanoutOptions): ChannelSink {
  const { apns, chime } = options;
  /** Zlecenie dźwięku — wyjątek to zero zleceń, nigdy przerwana wysyłka plakietki. */
  const chimeOf = (content: PushContent): number | undefined => {
    if (chime === undefined || !badgeOnly(content)) return undefined;
    try {
      return chime();
    } catch {
      return 0;
    }
  };
  return {
    async send(content: PushContent): Promise<SendReport> {
      const chimed = chimeOf(content);
      let outcome: SendOutcome;
      try {
        outcome = await apns.send(content);
      } catch {
        outcome = 'failed';
      }
      return { channels: { apns: outcome }, ...(chimed === undefined ? {} : { chime: chimed }) };
    },
  };
}
