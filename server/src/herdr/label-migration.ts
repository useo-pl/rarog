/**
 * Pane labels in the old provenance format, the only code that knows it:
 * `<description> · rarog-term <16 hex terminal id>` and
 * `<description> · rarog-claude <16 hex project key> <8 hex tab label trace>`, the description optional.
 *
 * Two parts. {@link legacyToCurrent} is a pure normalizer: `parsePaneLabel` reads every label
 * through it, so a pane with an old label is Rarog's for every reader. {@link createLabelMigration}
 * is the pass that rewrites old labels in herdr to the current format, called by the supervisor
 * whenever herdr answers. It writes nothing but `pane.rename` on a pane whose old label a fresh read
 * has just confirmed, so it never meets another writer on the same label: every other writer
 * confirms a label in the current format or no label at all.
 */
import { HerdrUnavailableError } from './socket.ts';
import { HerdrReadOnlyError } from './types.ts';
import type { HerdrLaunchClient, HerdrPaneInfo } from './types.ts';
import {
  claudeLabelSuffix, descriptionOk, joinLabel, keyCodeOf, termLabelSuffix,
} from './label-code.ts';

const LEGACY_TERM_RE = /^(?:(.+) · )?rarog-term ([0-9a-f]{16})$/;
const LEGACY_CLAUDE_RE = /^(?:(.+) · )?rarog-claude ([0-9a-f]{16}) ([0-9a-f]{8})$/;

/**
 * An old-format label → the same provenance in the current format, the description verbatim; any
 * other label comes back unchanged. The terminal id and the trace stay whole, the project key
 * becomes its code (the current format carries no more of it).
 */
export function legacyToCurrent(label: string): string {
  const term = LEGACY_TERM_RE.exec(label);
  if (term?.[2] !== undefined && descriptionOk(term[1])) {
    return joinLabel(term[1] ?? '', termLabelSuffix(term[2]));
  }
  const claude = LEGACY_CLAUDE_RE.exec(label);
  if (claude?.[2] !== undefined && claude[3] !== undefined && descriptionOk(claude[1])) {
    return joinLabel(claude[1] ?? '', claudeLabelSuffix(keyCodeOf(claude[2]), claude[3]));
  }
  return label;
}

/** The label is in the old format: the migration pass is the one to rewrite it. */
export function isLegacyPaneLabel(label: string | null): boolean {
  return label !== null && legacyToCurrent(label) !== label;
}

export interface LabelMigrationConfig {
  client: Pick<HerdrLaunchClient, 'listPanes' | 'renamePane'>;
  /** The write channel is open: `RAROG_HERDR_SEND` and the socket gate. */
  writable: () => boolean;
  log: (line: string) => void;
}

export interface LabelMigration {
  /**
   * One pass over the whole `pane.list` when one is due, shared by concurrent callers; never
   * rejects. Due at start, after {@link requestPass}, and after a pass that could not finish
   * (herdr unreadable, a timeout, the write gate); a pass that left no old label clears it.
   */
  run(): Promise<void>;
  /** herdr came back: the next {@link run} reads the panes again. */
  requestPass(): void;
  dispose(): void;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createLabelMigration(config: LabelMigrationConfig): LabelMigration {
  const { client, writable, log } = config;
  let due = true;
  let disposed = false;
  let inFlight: Promise<void> | null = null;
  /** `pane|label` that herdr refused to rename (pane gone, a label the socket rejects): not retried. */
  const refused = new Set<string>();
  const logged = new Set<string>();
  const logOnce = (tag: string, line: string): void => {
    if (logged.has(tag)) return;
    logged.add(tag);
    log(line);
  };

  const pass = async (): Promise<void> => {
    if (!writable()) {
      logOnce('read-only', 'herdr: pane label migration on hold — write channel closed (RAROG_HERDR_SEND=0)');
      return;
    }
    due = false;
    let panes: HerdrPaneInfo[];
    try {
      panes = await client.listPanes();
    } catch (err) {
      due = true;
      log(`herdr: pane label migration could not read the panes (${messageOf(err)})`);
      return;
    }
    const old = panes.filter((pane) => isLegacyPaneLabel(pane.label)
      && !refused.has(`${pane.paneId}|${pane.label ?? ''}`));
    if (old.length === 0) return;
    let rewritten = 0;
    for (const pane of old) {
      if (disposed) return;
      if (!writable()) {
        due = true;
        break;
      }
      const label = pane.label ?? '';
      let current: string | null | undefined;
      try {
        current = (await client.listPanes()).find((candidate) => candidate.paneId === pane.paneId)?.label;
      } catch (err) {
        due = true;
        log(`herdr: pane ${pane.paneId} not confirmed before its label rewrite (${messageOf(err)})`);
        break;
      }
      if (disposed) return;
      // Addresses are positional and a human may rename a pane: only the label read above is rewritten.
      if (current !== label) {
        // A pane gone from its address may live on under another one: the next pass reads the whole list again.
        if (current === undefined || isLegacyPaneLabel(current)) due = true;
        log(`herdr: pane ${pane.paneId} changed before its label rewrite — skipping`);
        continue;
      }
      try {
        await client.renamePane(pane.paneId, legacyToCurrent(label));
        rewritten += 1;
      } catch (err) {
        if (err instanceof HerdrReadOnlyError || err instanceof HerdrUnavailableError) {
          // The write gate, or a timeout that does not say whether the rename landed: the next pass reads again.
          due = true;
          log(`herdr: label rewrite of pane ${pane.paneId} — not done or result unknown (${messageOf(err)})`);
          break;
        }
        refused.add(`${pane.paneId}|${label}`);
        log(`herdr: label rewrite of pane ${pane.paneId} failed (${messageOf(err)})`);
      }
    }
    log(`herdr: pane label migration — ${String(rewritten)} of ${String(old.length)} old-format pane labels rewritten`);
  };

  return {
    run(): Promise<void> {
      if (inFlight !== null) return inFlight;
      if (disposed || !due) return Promise.resolve();
      const current: Promise<void> = pass()
        .catch((err: unknown) => {
          due = true;
          log(`herdr: pane label migration threw an error — ${messageOf(err)}`);
        })
        .finally(() => {
          if (inFlight === current) inFlight = null;
        });
      inFlight = current;
      return current;
    },
    requestPass(): void {
      due = true;
    },
    dispose(): void {
      disposed = true;
    },
  };
}
