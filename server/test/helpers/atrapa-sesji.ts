/**
 * Wspólna atrapa drivera sesji i nadzorcy herdr dla testów managera.
 *
 * Atrapa zapisuje WYWOŁANIA (`send`, `respondPermission` z decyzją, `interrupt`) i niczego nie tłumaczy na
 * klawisze: to, który klawisz idzie do panelu, jest regułą drivera herdr i ma testy drivera. Testy managera
 * sprawdzają, co manager kazał driverowi zrobić, więc asercja „poszedł `escape`” jest tu asercją na atrapę,
 * a nie na manager.
 *
 * Plik testu dziedziczy po {@link AtrapaDrivera} i {@link AtrapaNadzorcy} i dopisuje tylko to, czego potrzebuje
 * jego scenariusz (sonda restartu, rezerwy pola, start panelu, status herdr). Klasy bazowe nie mają zachowań
 * jednego scenariusza; domyślne odpowiedzi są neutralne (decyzja `applied`, przerwanie dostarczone, tryb `auto`,
 * zero paneli).
 */
import type { FileAttachment, HerdrMode, HerdrStatus } from '@rarog/shared';
import { AsyncEventQueue } from '../../src/drivers/runtime.ts';
import { APPLIED } from '../../src/drivers/types.ts';
import type { DecisionOutcome, DriverEvent, SendOptions, SessionDriver } from '../../src/drivers/types.ts';
import type {
  HerdrLaunchHandle, HerdrLaunchRequest, HerdrLifecycleEvent, HerdrSupervisor,
} from '../../src/herdr/types.ts';
import type { PermissionDecision } from '../../src/permissions.ts';

/** Jedno wywołanie drivera przez manager, zapisane tak, jak przyszło (bez klawiszy). */
export type WywolanieSesji =
  | {
    readonly method: 'send';
    readonly key: string;
    readonly text: string;
    readonly images?: readonly string[] | undefined;
    readonly files?: readonly FileAttachment[] | undefined;
    readonly opts?: SendOptions | undefined;
  }
  | {
    readonly method: 'respondPermission';
    readonly key: string;
    readonly reqId: string;
    readonly decision: PermissionDecision;
    readonly message?: string | undefined;
  }
  | { readonly method: 'interrupt'; readonly key: string };

/**
 * Dziennik wywołań. Jeden dziennik może obsłużyć wiele driverów naraz (nadzorca daje swój każdemu
 * podpiętemu), bo asercja „po `dispose()` managera nic nie poszło” ma być prawdziwa dla wszystkich paneli,
 * nie dla jednego.
 */
export class DziennikSesji {
  readonly calls: WywolanieSesji[] = [];

  /** Skrót wywołań jednej metody: `send` → tekst, `respondPermission` → decyzja, `interrupt` → klucz. */
  of(method: WywolanieSesji['method']): string[] {
    return this.calls.flatMap((call) => {
      if (call.method !== method) return [];
      if (call.method === 'send') return [call.text];
      if (call.method === 'respondPermission') return [call.decision];
      return [call.key];
    });
  }

  /**
   * Decyzje i przerwania w kolejności wywołań, bez wysyłek: `respondPermission:<decyzja>` albo `interrupt`.
   * Kolejność ma znaczenie, bo decyzja i przerwanie dzielą w driverze jedną kolejkę.
   */
  sterowanie(): string[] {
    return this.calls.flatMap((call) => {
      if (call.method === 'respondPermission') return [`respondPermission:${call.decision}`];
      if (call.method === 'interrupt') return ['interrupt'];
      return [];
    });
  }
}

export interface OpcjeAtrapyDrivera {
  /** Dziennik wspólny dla kilku driverów; bez niego driver ma własny. */
  readonly dziennik?: DziennikSesji;
  /** `true` udaje driver z własnym procesem (wtedy manager woła `interrupt()` przy odpinaniu). */
  readonly ownsProcess?: boolean;
}

/**
 * Driver sterowany z testu. Zdarzenia podaje test przez {@link queue}, wyniki decyzji i przerwania ustawia polami,
 * a każde wywołanie trafia do {@link dziennik}.
 */
export class AtrapaDrivera implements SessionDriver {
  readonly ownsProcess: boolean;
  readonly queue = new AsyncEventQueue<DriverEvent>();
  readonly dziennik: DziennikSesji;
  /** Wywołania tego drivera (dziennik bywa wspólny dla kilku). */
  readonly calls: WywolanieSesji[] = [];
  disposals = 0;

  /** Wynik `respondPermission`; test podmienia go, żeby zbadać odmowę albo wygaśnięcie. */
  decisionOutcome: DecisionOutcome = APPLIED;
  /** Wynik `answerQuestion`. */
  answerOutcome: DecisionOutcome = APPLIED;
  /** Czy `interrupt()` melduje dostarczenie przerwania. */
  interruptSent = true;
  /** Gdy `true`, `respondPermission()` czeka na {@link settleDecision} (decyzja stoi w kolejce drivera). */
  holdDecision = false;
  /** Gdy `true`, `interrupt()` czeka na {@link settleInterrupt} (przerwanie stoi w kolejce drivera). */
  holdInterrupt = false;

  readonly #heldDecisions: (() => void)[] = [];
  readonly #heldInterrupts: ((sent: boolean) => void)[] = [];

  constructor(readonly key = '', opcje: OpcjeAtrapyDrivera = {}) {
    this.dziennik = opcje.dziennik ?? new DziennikSesji();
    this.ownsProcess = opcje.ownsProcess ?? false;
  }

  get events(): AsyncIterable<DriverEvent> {
    return this.queue;
  }

  /** Teksty wysłane przez ten driver. */
  get sent(): string[] {
    return this.calls.flatMap((call) => (call.method === 'send' ? [call.text] : []));
  }

  /** Załączniki kolejnych wysyłek (`undefined`, gdy wysyłka była bez obrazków). */
  get sentImages(): (readonly string[] | undefined)[] {
    return this.calls.flatMap((call) => (call.method === 'send' ? [call.images] : []));
  }

  /** Opcje kolejnych wysyłek (klasyfikacja komendy, token echa). */
  get sendOpts(): (SendOptions | undefined)[] {
    return this.calls.flatMap((call) => (call.method === 'send' ? [call.opts] : []));
  }

  /** Liczba wywołań `interrupt()`. */
  get interrupts(): number {
    return this.calls.filter((call) => call.method === 'interrupt').length;
  }

  protected zapisz(call: WywolanieSesji): void {
    this.calls.push(call);
    this.dziennik.calls.push(call);
  }

  send(text: string, images?: readonly string[], files?: readonly FileAttachment[], opts?: SendOptions): void {
    this.zapisz({ method: 'send', key: this.key, text, images, files, opts });
  }

  respondPermission(reqId: string, decision: PermissionDecision, message?: string): Promise<DecisionOutcome> {
    this.zapisz({ method: 'respondPermission', key: this.key, reqId, decision, message });
    if (!this.holdDecision) return Promise.resolve(this.decisionOutcome);
    return new Promise<DecisionOutcome>((resolve) => {
      this.#heldDecisions.push(() => { resolve(this.decisionOutcome); });
    });
  }

  /** Domyka najstarszą wstrzymaną decyzję, w kolejności kolejki drivera. */
  settleDecision(): void {
    const resolve = this.#heldDecisions.shift();
    if (resolve === undefined) throw new Error('nie ma wstrzymanej decyzji do domknięcia');
    resolve();
  }

  answerQuestion(): Promise<DecisionOutcome> {
    return Promise.resolve(this.answerOutcome);
  }

  /** Celowo nie `async` i nie domyka kolejki zdarzeń: manager sam odrzuca zdarzenia po przerwaniu. */
  interrupt(): Promise<boolean> {
    this.zapisz({ method: 'interrupt', key: this.key });
    if (!this.holdInterrupt) return Promise.resolve(this.interruptSent);
    return new Promise<boolean>((resolve) => { this.#heldInterrupts.push(resolve); });
  }

  /** Domyka najstarsze wstrzymane przerwanie, w kolejności kolejki drivera. */
  settleInterrupt(sent = true): void {
    const resolve = this.#heldInterrupts.shift();
    if (resolve === undefined) throw new Error('nie ma wstrzymanego przerwania do domknięcia');
    resolve(sent);
  }

  dispose(): void {
    this.disposals += 1;
    this.queue.close();
  }
}

/**
 * Nadzorca herdr bez gniazda. Podpięcie oddaje driver z {@link nowyDriver} i zapamiętuje go pod kluczem panelu;
 * zdarzenia cyklu życia paneli test podaje przez {@link emit}. Metody kanału tworzenia i zamykania paneli są
 * neutralne (start panelu odmawia), plik testu nadpisuje te, których używa jego scenariusz.
 */
export abstract class AtrapaNadzorcy<D extends SessionDriver = AtrapaDrivera> implements HerdrSupervisor {
  readonly lifecycle = new AsyncEventQueue<HerdrLifecycleEvent>();
  /** Dziennik wspólny dla driverów, które podklasa tworzy z `this.log`. */
  readonly log = new DziennikSesji();
  readonly drivers = new Map<string, D>();

  protected abstract nowyDriver(key: string): D;

  get events(): AsyncIterable<HerdrLifecycleEvent> {
    return this.lifecycle;
  }

  status(): HerdrStatus {
    return { available: true, agentCount: this.drivers.size, readOnly: false, canLaunch: true };
  }

  attach(key: string): D {
    const driver = this.nowyDriver(key);
    this.drivers.set(key, driver);
    return driver;
  }

  markSent(_key: string): void {
    /* karencja `idle` ma testy w `herdr-supervisor.test.ts` */
  }

  ensureFreshMode(_key: string): Promise<HerdrMode> {
    return Promise.resolve('auto');
  }

  focus(_key: string): Promise<void> {
    return Promise.resolve();
  }

  launch(_req: HerdrLaunchRequest): Promise<HerdrLaunchHandle> {
    return Promise.reject(new Error('zakładanie paneli nie jest częścią scenariusza'));
  }

  closeTab(_key: string): Promise<void> {
    return Promise.resolve();
  }

  rarogPaneCount(): number {
    return 0;
  }

  liveEngineSessions(): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set());
  }

  dispose(): void {
    this.lifecycle.close();
  }

  emit(event: HerdrLifecycleEvent): void {
    this.lifecycle.push(event);
  }

  /** Driver podpięty do panelu o tym kluczu. */
  driver(key: string): D {
    const driver = this.drivers.get(key);
    if (driver === undefined) throw new Error(`brak drivera dla ${key}`);
    return driver;
  }
}
