/**
 * Lists of the conversation on a session card: background tasks, artifacts, pull requests and scheduled tasks. The
 * driver pays each out whole (`background-tasks`, `artifacts`, `pull-requests`, `scheduled-tasks`); the manager passes those events here and drops the
 * lists when the card stops showing the conversation they came from. Functions over one session with a narrow
 * {@link ConversationListsPort}; what counts as work is asked of `herdr/background/work.ts`. This module does not
 * import `manager.ts`.
 */
import type { DriverEvent } from '../drivers/types.ts';
import { holdsOwedDone, stuckWaits } from '../herdr/background/work.ts';
import type { StuckWaits } from '../herdr/background/work.ts';
import type { SessionPrStatus } from './pr-status-link.ts';
import type { Session } from './session.ts';

/** The driver events that carry one of the lists. */
export type ConversationListEvent = Extract<
  DriverEvent, { type: 'background-tasks' | 'artifacts' | 'pull-requests' | 'scheduled-tasks' }
>;

/** What the lists need from the manager. */
export interface ConversationListsPort {
  readonly emitSessionChanged: (session: Session) => void;
  /** Background silence without a turn end for the push scheduler (`NotifierLike.quiet`). */
  readonly quiet: (sessionId: string) => void;
  /** The waits of every task list swap for the stalled wait alarm (`StalledWaitListener`). */
  readonly stuckWaits: (session: Session, waits: StuckWaits) => void;
  readonly prStatus: Pick<SessionPrStatus, 'applyList' | 'clear'>;
}

/**
 * The stalled wait alarm as the manager sees it: `notify/stalled-wait.ts` behind the session facts assembled in
 * `bootstrap/push.ts`. `forget` goes on the roads that drop the session or its conversation outside a list swap.
 */
export interface StalledWaitListener {
  readonly stuckWaits: ConversationListsPort['stuckWaits'];
  readonly forget: (sessionId: string) => void;
}

export function applyConversationList(
  session: Session, event: ConversationListEvent, port: ConversationListsPort,
): void {
  switch (event.type) {
    /*
     * Zadania w tle — metadana karty, jak git: bez przejścia stanu i bez ring buffera.
     *
     * Pusta lista ZNIKA z pola zamiast jechać jako `[]`: „nic nie leci" i „nie wiem" znaczą
     * dla telefonu dokładnie to samo (plakietki nie ma), a jedna reprezentacja zamiast dwóch
     * to o jeden warunek mniej w każdym miejscu, które to czyta. Pusta przy polu, którego i tak
     * nie ma, nie rozgłasza karty: driver wysyła pierwszą listę po podpięciu także pustą (wymiana
     * drivera), a restart Raroga dawałby wtedy ramkę na każdy panel bez zadań.
     */
    case 'background-tasks': {
      const tasks = event.tasks.length > 0 ? event.tasks : undefined;
      if (tasks === undefined && session.backgroundTasks === undefined) return;
      const held = holdsOwedDone(session.backgroundTasks);
      const waits = stuckWaits(session.state, session.backgroundTasks, tasks);
      session.backgroundTasks = tasks;
      port.emitSessionChanged(session);
      /*
       * The stalled wait alarm on every swap, also without an edge: the alarm drops its tries and its memory of waits
       * that left the list. Before `quiet`, on the same swap; the alarm never touches the owed "done".
       */
      port.stuckWaits(session, waits);
      /*
       * Cisza w tle bez końca tury: lista przestała wstrzymywać
       * zaległe „gotowe" — skończyła się praca albo komenda subagenta w postoju. Raz na przejście,
       * nie na każdą ramkę: kolejna lista bez wstrzymania niczego nie zmienia. Czy uzbroić, decyduje
       * harmonogram (zaległość, stan sesji, obecność); tu tylko przejście, liczone w `work.ts`.
       */
      if (held && !holdsOwedDone(tasks)) port.quiet(session.id);
      return;
    }

    /*
     * Artefakty sesji — metadana karty jak zadania w tle: bez przejścia stanu, bez `seen`
     * i bez pusha. Pusta lista znika z pola. Pusta przy polu, którego i tak nie ma, nie rozgłasza
     * karty: follower wypłaca listę przy KAŻDYM podpięciu, także pustą, a restart Raroga dawałby
     * wtedy ramkę na każdy panel bez artefaktów.
     */
    case 'artifacts': {
      const artifacts = event.artifacts.length > 0 ? event.artifacts : undefined;
      if (artifacts === undefined && session.artifacts === undefined) return;
      session.artifacts = artifacts;
      port.emitSessionChanged(session);
      return;
    }

    // Pull requesty sesji: reguła artefaktów, lista i jej stan na GitHubie w `pr-status-link.ts`.
    case 'pull-requests':
      port.prStatus.applyList(session, event.pullRequests, event.windowStart);
      return;

    /*
     * Scheduled tasks: the artifacts rule. An empty list clears the field; an empty one over an absent field sends
     * no card (the driver pays the first list out also empty, at every attach).
     */
    case 'scheduled-tasks': {
      const scheduledTasks = event.scheduledTasks.length > 0 ? event.scheduledTasks : undefined;
      if (scheduledTasks === undefined && session.scheduledTasks === undefined) return;
      session.scheduledTasks = scheduledTasks;
      port.emitSessionChanged(session);
      return;
    }
  }
}

/** Drops every list of the conversation from the card (another conversation, or the pane left the scope). */
export function dropConversationLists(session: Session, port: Pick<ConversationListsPort, 'prStatus'>): void {
  session.backgroundTasks = undefined;
  session.artifacts = undefined;
  session.scheduledTasks = undefined;
  port.prStatus.clear(session);
}
