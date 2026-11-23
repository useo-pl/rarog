/**
 * The driver's own digit in a control command's confirmation dialog, a module of the herdr driver: which block that
 * digit answers, and the wait of the next queued step until the answered dialog leaves.
 *
 * After the driver's digit the CLI takes the dialog off the screen only after a repaint (about 2 s, measured on CLI
 * 2.1.329), and the registry keeps saying `waiting` until its next read. The next queued step (the second command of a
 * batch, a send behind it) would see that answered dialog at the send gates and be refused. It waits here first,
 * bounded, until the screen no longer shows that dialog and the CLI registry hold is gone, and only then chooses its
 * path and runs the gates. A wait that did not see the prompt field come back (a dialog stands, or the screen stayed
 * unreadable) says so, and keeps saying so to every later step until the field is back: no step goes past it.
 */
import { ANSWERED_HOOK_SHIELD_MS, cliDialogOnScreen, parseOptions } from '../../herdr/dialogs/index.ts';
import { MODEL_CONFIRM_ATTEMPTS, commandDialogStands } from './commands.ts';

export interface CommandDialogSettleConfig {
  /** The pause between reads: the command confirmation's poll (`MODEL_CONFIRM_POLL_MS`, shorter in tests). */
  readonly pollMs: number;
}

/** Driver state the wait reads. */
export interface CommandDialogSettlePort {
  disposed(): boolean;
  /** A fresh `detection` read past every cache; `null` = the read failed. */
  readScreen(): Promise<string | null>;
  /** The CLI registry hold (`CliReserve.cliHold`). */
  cliHold(): boolean;
  /** The current block generation (the driver's `#blockedSeq`). */
  blockedSeq(): number;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export class CommandDialogSettle {
  readonly #pollMs: number;
  readonly #port: CommandDialogSettlePort;
  /** The command whose dialog got the driver's digit, and when; it stays until a read shows the prompt field. */
  #answered: { readonly command: string; readonly at: number } | null = null;
  /** The block generation read right before the driver's digit ({@link digitGoes}). */
  #digitSeq: number | null = null;

  constructor(config: CommandDialogSettleConfig, port: CommandDialogSettlePort) {
    this.#pollMs = config.pollMs;
    this.#port = port;
  }

  /**
   * Call synchronously right before the driver's digit goes to the confirmation dialog of `command`. It arms the wait
   * and reads the block the digit answers. The wait does not depend on the result of the send: a send that failed may
   * still have delivered the key.
   */
  digitGoes(command: string): void {
    this.#answered = { command, at: this.#port.now() };
    this.#digitSeq = this.#port.blockedSeq();
  }

  /**
   * The driver's digit was confirmed. Returns the block generation the answer covers: the one read right before the
   * key ({@link digitGoes}), while it is still the current one. A block that began during the send is a new dialog and
   * is never covered: `null`, so it gets its own card.
   */
  answered(): number | null {
    const seq = this.#digitSeq;
    this.#digitSeq = null;
    return seq !== null && seq === this.#port.blockedSeq() ? seq : null;
  }

  /**
   * Waits while the screen still shows the answered dialog, is mid-repaint or unreadable, or shows the prompt field
   * under a registry hold. It returns at once without an answer to wait for, on the prompt field without a hold, and on
   * any other dialog. The bound is the command confirmation's own window ({@link MODEL_CONFIRM_ATTEMPTS} reads one poll
   * apart, about 5 s), the time the CLI is already given to draw a command dialog: the measured clear took about 2 s on
   * CLI 2.1.329, and the registry is read every 1.5 s.
   *
   * Only a read that shows the prompt field without a hold releases the answer; time alone never does. Until then
   * every queued step comes here again and is held: a refused command does not open the way for the message behind
   * it, and a screen that never became readable proves nothing. Past the answer shield window
   * (`ANSWERED_HOOK_SHIELD_MS` from the digit) the repaint is long over, so a step makes one read instead of the
   * whole bound.
   *
   * @returns `true` = the prompt field was not read back: a dialog stands (another one, or the answered one), or no
   *   read showed the field; the step must not reach the prompt field. `false` = no answer to wait for, or the prompt
   *   field without a hold.
   */
  async settle(): Promise<boolean> {
    const answered = this.#answered;
    if (answered === null) return false;
    for (let attempt = 0; attempt < MODEL_CONFIRM_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        if (this.#port.now() - answered.at >= ANSWERED_HOOK_SHIELD_MS) return true;
        await this.#port.sleep(this.#pollMs);
      }
      if (this.#port.disposed()) return true;
      const text = await this.#port.readScreen();
      if (this.#port.disposed()) return true;
      if (text === null) continue;
      if (commandDialogStands(answered.command, text, parseOptions(text))) continue;
      const presence = cliDialogOnScreen(text);
      if (presence === 'dialog') return true;
      if (presence === 'none' && !this.#port.cliHold()) {
        this.#answered = null;
        return false;
      }
    }
    return true;
  }
}
