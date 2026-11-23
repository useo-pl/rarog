/**
 * Server start: the herdr supervisor's agent set signal, wired to the `alive.json` writer. The supervisor is built
 * before the writer, so the signal exists first and gets the writer later (`connect`). The writer publishes the first
 * sessions after the start at once instead of with its 10 s tick (`AliveWriter.sessionsChanged`). It does not decide
 * anything about the hook or the consent channel.
 */
import type { AliveWriter } from '../herdr/dialogs/shadow/alive.ts';

export interface AliveSessionsSignal {
  /** Supervisor dependency `onAgentsChanged`: never throws, the write runs in a microtask after the resync step. */
  readonly onAgentsChanged: () => void;
  /** Hands over the writer once it exists; `null` (demo) = the signal does nothing. */
  connect(writer: AliveWriter | null): void;
}

export function createAliveSessionsSignal(): AliveSessionsSignal {
  let writer: AliveWriter | null = null;
  // One microtask for a burst: a resync that adds ten agents asks the writer once.
  let queued = false;
  return {
    onAgentsChanged: () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        try {
          writer?.sessionsChanged();
        } catch {
          // A throw in a microtask would end the process; the 10 s tick writes the list anyway.
        }
      });
    },
    connect: (next) => { writer = next; },
  };
}
