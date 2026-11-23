/**
 * Attach semaphore of the session manager for herdr panes: at most `HERDR_ATTACH_CONCURRENCY` drivers read their
 * history at once, and a slot is held until the first event of the attached driver or `HERDR_ATTACH_SETTLE_MS`.
 * The manager owns one {@link AttachSlots}, takes a slot before `supervisor.attach`, settles the waiter on the first
 * driver event and drops it when the card goes away. This module does not import `manager.ts`.
 */
import { HERDR_ATTACH_CONCURRENCY } from '../config.ts';
import type { Session } from './session.ts';
import { HERDR_ATTACH_SETTLE_MS } from './state-sentences.ts';

/** Slots, queue and waiters of herdr attachments; one instance per manager. */
export class AttachSlots {
  /** Wolne sloty podpięć herdr (5.10: 17 równoległych odczytów historii to skok latencji). */
  #attachSlots = HERDR_ATTACH_CONCURRENCY;
  /** Kolejka oczekujących na slot podpięcia. */
  readonly #attachQueue: (() => void)[] = [];
  /** Kto czeka na pierwsze zdarzenie swojego drivera (zwolnienie slotu). */
  readonly #attachWaiters = new Map<string, () => void>();

  async acquireAttachSlot(): Promise<void> {
    if (this.#attachSlots > 0) {
      this.#attachSlots -= 1;
      return;
    }
    await new Promise<void>((resolve) => { this.#attachQueue.push(resolve); });
  }

  /** Slot przekazujemy WPROST następnemu w kolejce — inaczej licznik i kolejka rozjadą się. */
  releaseAttachSlot(): void {
    const next = this.#attachQueue.shift();
    if (next !== undefined) next();
    else this.#attachSlots += 1;
  }

  /**
   * Czeka na pierwsze zdarzenie świeżo podpiętego drivera (historia albo stan agenta).
   *
   * Slot zwalnia się dopiero wtedy, bo to właśnie odczyt historii z dysku jest tym, co
   * ograniczamy. Sufit czasu jest obowiązkowy: panel bez pliku transkryptu (świeży `/clear`)
   * nie odezwie się wcale, a 17 kart nie może czekać na jeden taki przypadek.
   */
  waitForAttach(session: Session): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const settle = (): void => {
        if (done) return;
        done = true;
        this.#attachWaiters.delete(session.id);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(settle, HERDR_ATTACH_SETTLE_MS);
      if (typeof timer.unref === 'function') timer.unref();
      this.#attachWaiters.set(session.id, settle);
    });
  }

  /** Driver się odezwał — zwalniamy slot dla kolejnego panelu. */
  settleAttach(session: Session): void {
    this.#attachWaiters.get(session.id)?.();
  }

  /** Forgets the waiter of a card that went away; its slot is freed by the settle timeout. */
  dropAttachWaiter(id: string): void {
    this.#attachWaiters.delete(id);
  }
}
