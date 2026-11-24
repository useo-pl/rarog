/**
 * Forgetting cards. A closed card (`done`) stays in memory with its transcript so the phone can resume its
 * conversation; this module caps how many stay ({@link DONE_CARDS_MAX}) and picks the ones over the cap, says when a
 * forgotten card ends its conversation for the consent cycle, and snapshots the indexes a forget undoes. The manager
 * forgets the picked cards by the Hide path and sends the fresh list; this module sends nothing and keeps no state.
 */
import type { Session } from './session.ts';

/** Closed cards the server keeps for resuming; each holds up to two transcript budgets (`ring-buffer.ts`). */
export const DONE_CARDS_MAX = 100;

/** The card fields the cap reads. */
export type RetainedCard = Pick<Session, 'id' | 'state' | 'driver' | 'herdrKey' | 'lastActivityAt'>;

/** `true` when the pane index (`HerdrAgent.key` → card id) still points at this card: its pane is alive. */
export function ownsPaneKey<C extends Pick<Session, 'id' | 'herdrKey'>>(
  herdrByKey: ReadonlyMap<string, string>, card: C,
): card is C & { herdrKey: string } {
  return card.herdrKey !== undefined && herdrByKey.get(card.herdrKey) === card.id;
}

/**
 * Closed cards over the cap, the oldest `lastActivityAt` first. A card with a driver or a live pane and a card whose
 * restart is in progress neither counts nor goes; a `resumable` card is not closed.
 */
export function doneCardsOver<S extends RetainedCard>(
  sessions: ReadonlyMap<string, S>, herdrByKey: ReadonlyMap<string, string>,
  restarts: ReadonlyMap<string, unknown>, max: number = DONE_CARDS_MAX,
): S[] {
  const closed = [...sessions.values()].filter((card) => card.state === 'done' && card.driver === null
    && !ownsPaneKey(herdrByKey, card) && !restarts.has(card.id));
  if (closed.length <= max) return [];
  closed.sort((a, b) => Date.parse(a.lastActivityAt) - Date.parse(b.lastActivityAt));
  return closed.slice(0, closed.length - max);
}

/**
 * The card was forgotten while its conversation has no live process and no other card: the consent cycle may drop
 * the conversation's entries (`forgotten`). Called after the card left `sessions`.
 */
export function forgetConversation(
  card: Pick<Session, 'engineSessionId'>, sessions: ReadonlyMap<string, Pick<Session, 'engineSessionId'>>,
  forgotten: ((engineSessionId: string) => void) | undefined,
): void {
  const engine = card.engineSessionId;
  if (forgotten === undefined || engine === undefined || engine === '') return;
  for (const other of sessions.values()) if (other.engineSessionId === engine) return;
  forgotten(engine);
}

/** What {@link snapshotIndexes} restores: the manager's maps and the watchers a card in `sessions` has. */
export interface IndexSnapshotPort {
  readonly sessions: Map<string, Session>;
  readonly herdrByKey: Map<string, string>;
  readonly byEngineSession: Map<string, string>;
  /** PR status and git watchers of a card put back (`SessionPrStatus.sync`, `SessionGit.watch`). */
  readonly watch: (session: Session) => void;
}

/**
 * Zapamiętuje, w których indeksach stoi ta karta, i oddaje funkcję COFAJĄCĄ `#forget…`.
 *
 * Odtwarzamy dokładnie to, co było — a nie „co powinno być": `#indexEngineSession` pomija
 * sesje `done`, więc bezwarunkowe wołanie go po rollbacku dokładałoby wpis, którego przed
 * kasowaniem nie było. Jedyne, czego nie wskrzeszamy, to czekający z `AttachSlots`: to obietnice
 * czekających na podpięcie drivera, a po nieudanym wznowieniu nie ma do czego ich podpiąć.
 * Nowa karta pod tym samym id (gdyby `create()` zdążył ją wstawić) ma pierwszeństwo.
 */
export function snapshotIndexes(port: IndexSnapshotPort, session: Session): () => void {
  const key = session.herdrKey;
  const engineSessionId = session.engineSessionId;
  const hadKey = ownsPaneKey(port.herdrByKey, session);
  const hadEngine = engineSessionId !== undefined
    && port.byEngineSession.get(engineSessionId) === session.id;
  return () => {
    if (port.sessions.has(session.id)) return;
    port.sessions.set(session.id, session);
    port.watch(session);
    if (hadKey && key !== undefined) port.herdrByKey.set(key, session.id);
    if (hadEngine && engineSessionId !== undefined) port.byEngineSession.set(engineSessionId, session.id);
  };
}
