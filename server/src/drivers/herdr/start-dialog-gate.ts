/**
 * Start dialog gate of the herdr driver: while a launched pane has no engine session herdr knows, a Claude Code start
 * dialog herdr reads as ready may stand in it (the external imports dialog, recognised from the screen, or an unknown
 * one the launcher found). No key and no text go to such a dialog: its answer is kept by Claude Code for the project
 * for good, and `Enter` behind a prompt picks the highlighted option. The gate judges screens and says the card's
 * sentence once per dialog; it sends nothing, and the dialogs Rarog reads (trust, another known dialog, a question or
 * consent form) pass it.
 */
import type { OwnText } from '@rarog/shared/sentences';
import {
  START_DIALOG_IMPORTS_MESSAGE, START_DIALOG_UNKNOWN_MESSAGE, resolveOptions, startDialogOf,
} from '../../herdr/dialogs/index.ts';
import type { StartDialog } from '../../herdr/dialogs/index.ts';
import { stripTerminalControl } from '../../herdr/dialogs/screen/text.ts';
import type { HerdrClient, HerdrStartPhase } from '../../herdr/types.ts';
import { composerRegionState } from './commands.ts';

/** What one screen says about a start dialog: it stands, it is gone, or the screen proves neither. */
export type StartDialogRead = StartDialog | 'gone' | 'unclear';

/**
 * Another dialog Rarog reads: a known dialog (also the trust dialog without digits) or a form of a question or
 * a consent. A bare list of digits is not one: an unknown start dialog may number its options too.
 */
function readableDialog(text: string): boolean {
  const resolved = resolveOptions(text, null);
  return resolved.status === 'no-jsonl' && (resolved.knownDialog !== null || resolved.questionForm !== null);
}

/**
 * One screen of a pane in its start phase. Gone takes positive proof: the prompt field, or another dialog Rarog
 * reads. The external imports dialog stands on its signature; any other screen without the prompt field stands only
 * when the launcher found an unknown start dialog, because the bypass mode warning looks the same and herdr reports
 * it `blocked` itself. A blank screen proves nothing.
 */
export function readStartDialog(text: string, phase: HerdrStartPhase): StartDialogRead {
  if (composerRegionState(text) !== 'unknown') return 'gone';
  const dialog = startDialogOf(text);
  if (dialog === null) return 'unclear';
  if (dialog.id === 'external-imports') return dialog;
  if (readableDialog(text)) return 'gone';
  return phase.startDialog !== null && phase.startDialog.id === null ? dialog : 'unclear';
}

/** What the gate needs from the driver. */
export interface StartDialogGatePort {
  /** The launch before herdr knows its engine session; `null` once it knows it (no start dialog can stand). */
  startPhase(): HerdrStartPhase | null;
  /** A fresh screen read of the pane; `null` when it failed. */
  readScreen(): Promise<string | null>;
  /** A sentence to the transcript. */
  system(text: OwnText): void;
}

export class StartDialogGate {
  readonly #port: StartDialogGatePort;
  /** The start dialog the last screen proving anything (or the launcher) showed; a failed or blank read keeps it. */
  #standing: StartDialog | null = null;
  /** The launcher's dialog is in the memory already: it counts once, so a screen proving it gone ends it for good. */
  #launcherTaken = false;
  /** The dialog whose sentence the transcript has (`id`, or the title of an unknown one). */
  #announced: string | null = null;

  constructor(port: StartDialogGatePort) {
    this.#port = port;
  }

  /**
   * One successful screen read of the pane (every dialog read of the driver goes here).
   *
   * @returns `true` when a start dialog stands that the last screen proving anything did not show: a new dialog
   */
  note(text: string): boolean {
    const phase = this.#phase();
    const read = phase === null ? 'gone' : readStartDialog(text, phase);
    if (read === 'unclear') return false;
    const before = this.#standing;
    this.#standing = read === 'gone' ? null : read;
    return this.#standing !== null && (before === null || identityOf(before) !== identityOf(this.#standing));
  }

  /** Whether the pane is in its start phase, so a start dialog may stand; no read. */
  inPhase(): boolean {
    return this.#port.startPhase() !== null;
  }

  /**
   * Whether the remembered dialog refuses a key or text now, without a read: for a send that must reach the client
   * with no `await` after its own checks. The callers that decide on a key read fresh ({@link refuses}) first.
   */
  holds(): boolean {
    return this.#phase() !== null && this.#standing !== null;
  }

  /**
   * Whether a key or text to the pane is refused: judged on `fresh` (a screen the caller has just read) or on a read
   * made here, and on the remembered dialog when the read fails or proves nothing. Outside the start phase it reads
   * nothing and refuses nothing.
   */
  async refuses(fresh: string | null = null): Promise<boolean> {
    if (this.#phase() === null) {
      this.#standing = null;
      return false;
    }
    const text = fresh ?? await this.#port.readScreen();
    if (text !== null) this.note(text);
    return this.#standing !== null;
  }

  /** A card was shown: the sentence of the start dialog under it, once per dialog. */
  cardShown(): void {
    const dialog = this.#phase() === null ? null : this.#standing;
    if (dialog === null) return;
    const identity = identityOf(dialog);
    if (this.#announced === identity) return;
    this.#announced = identity;
    this.#port.system(dialog.id === 'external-imports' ? START_DIALOG_IMPORTS_MESSAGE : START_DIALOG_UNKNOWN_MESSAGE);
  }

  /**
   * The start phase now. The dialog the launcher found on its own read goes into the memory the first time it is
   * known, as proof that it stands: before any read of the driver, and through failed or blank reads, the gate
   * refuses until a screen proves it gone.
   */
  #phase(): HerdrStartPhase | null {
    const phase = this.#port.startPhase();
    if (phase !== null && phase.startDialog !== null && !this.#launcherTaken) {
      this.#launcherTaken = true;
      this.#standing = phase.startDialog;
    }
    return phase;
  }
}

/**
 * The herdr client of the driver and its modules, with every successful `visible` + `ansi` read (the prompt field
 * reads before a key or text) noted as its plain text, like a `detection` read: a field read that already shows a start
 * dialog moves the gate's memory before the next client call. Other members pass through, read on the client at call
 * time.
 */
export function clientNotingScreens(client: HerdrClient, note: (text: string) => void): HerdrClient {
  return new Proxy(client, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop !== 'readScreen') return (value as (...args: unknown[]) => unknown).bind(target);
      return async (...args: Parameters<HerdrClient['readScreen']>) => {
        const screen = await target.readScreen(...args);
        if (args[1] === 'visible' && args[2] === 'ansi') note(stripTerminalControl(screen.text));
        return screen;
      };
    },
  });
}

/** One start dialog: its `id`, or the title of an unknown one. */
function identityOf(dialog: StartDialog): string {
  return dialog.id ?? `unknown\n${dialog.title ?? ''}`;
}
