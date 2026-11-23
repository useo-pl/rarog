/**
 * Deferred echo of a send made during a turn (`RAROG_QUEUE_ECHO`): the message waits in the session until
 * the transcript file shows that the CLI took the prompt, or it goes to the end of the transcript (flush).
 * Functions over one session; the state lives in the session fields `heldEchoes`, `heldFlushTimer` and
 * `heldCheckOp`. The manager passes {@link HeldEchoDeps} and keeps the send path and the driver event switch.
 * While a queue take-back of the session runs ({@link pauseHeldFlush}), the flush at the turn end appends nothing,
 * because the take-back may be taking those messages, and a send waits for its answer ({@link whenTakeBackSettles});
 * after it answers, the turn end flush is armed again for what it left. This module does not import `manager.ts`.
 */
import type { ServerSystem } from '@rarog/shared/rest';
import type { MessageAttachment, TranscriptMessage } from '@rarog/shared';
import type { HeldLeftover, InternalBlock, SessionDriver } from '../drivers/types.ts';
import { ECHO_TTL_MS, ECHO_WINDOW } from '../herdr/jsonl-follow.ts';
import type { SlashCommand } from '../herdr/commands/index.ts';
import type { HeldEcho, MessageExtra, Session } from './session.ts';
import { WORKING_STATES, heldNotTakenText, heldUnconfirmedText, heldUnseenText, inTurn } from './state-sentences.ts';

/**
 * Sufit wiadomości z echem odroczonym na sesję: tyle, ile mieści okno echa followera.
 * Dziewiąta wysyłka dostaje echo od razu (staje nad ośmioma czekającymi — świadomie przyjęte).
 */
const HELD_ECHO_MAX = ECHO_WINDOW;
/**
 * Ile po wyjściu sesji z tury (praca albo decyzja) czekają wiadomości z echem odroczonym, zanim
 * pójdą na koniec transkryptu. CLI bierze prompt z kolejki od razu po turze (`dequeue`,
 * zmierzone na 2.1.299), więc 10 s to zapas na followera, nie na model.
 */
const HELD_ECHO_IDLE_FLUSH_MS = 10_000;

/** Przedrostek linii spłukania wstrzymanych wiadomości: `queue: <sesja> flushed <n>: <powód>`. */
export const HELD_QUEUE_LOG = 'queue:';
/** Słowo linii spłukania wstrzymanych wiadomości, po identyfikatorze sesji (wzór przy {@link HELD_QUEUE_LOG}). */
export const HELD_FLUSHED_LOG = 'flushed';

/** Queue take-backs in flight of one session, and the promise that settles when the last of them answered. */
interface TakeBacksRunning {
  count: number;
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

/** Queue take-backs in flight per session ({@link pauseHeldFlush}). */
const takeBacksRunning = new WeakMap<Session, TakeBacksRunning>();

/** What the deferred-echo functions need from the manager. */
export interface HeldEchoDeps {
  /** Manager configuration, read at call time. */
  readonly config: { readonly queueEcho?: boolean; readonly logger?: (line: string) => void };
  readonly system: () => ServerSystem;
  readonly now: () => number;
  readonly sessions: ReadonlyMap<string, Session>;
  /** A restart reservation of this session is open. */
  readonly restarting: (sessionId: string) => boolean;
  readonly appendMessage: (
    session: Session, role: TranscriptMessage['role'], blocks: readonly InternalBlock[], at?: string,
    attachments?: readonly MessageAttachment[], extra?: MessageExtra,
  ) => number;
  readonly emitSessionChanged: (session: Session) => void;
  readonly noteTurnInput: (session: Session) => void;
}

/**
 * Czy echo tej wysyłki czeka, aż CLI weźmie prompt, zamiast stanąć w transkrypcie od razu.
 *
 * Wszystkie warunki naraz: preferencja serwera, klient umiejący czekać (`queueAware`
 * i `clientMessageId`, po którym zgasi swój wpis), sesja w pracy (prompt idzie do kolejki CLI),
 * sam tekst (podpis z załącznikami nie zgodziłby się po restarcie serwera), driver, który
 * rozpozna wpis promptu w pliku (`defersEcho`), i miejsce w oknie echa. Pomyłka oceny „pracuje”
 * w obie strony kończy się widokiem bez wstrzymania, nie błędem.
 */
export function defersEcho(
  session: Session, clean: string, slash: SlashCommand | null, hasAttachments: boolean,
  clientMessageId: string | undefined, queueAware: boolean, deps: HeldEchoDeps,
): boolean {
  return deps.config.queueEcho === true && queueAware && clientMessageId !== undefined
    && !hasAttachments && WORKING_STATES.includes(session.state)
    && session.heldEchoes.length < HELD_ECHO_MAX
    && session.driver?.defersEcho?.(clean, slash) === true;
}

/** Wstrzymana wiadomość z tym tokenem, wyjęta z kolejki sesji; `undefined` = już jej nie ma. */
export function takeHeld(session: Session, token: string): HeldEcho | undefined {
  const index = session.heldEchoes.findIndex((h) => h.token === token);
  if (index === -1) return undefined;
  const [held] = session.heldEchoes.splice(index, 1);
  if (session.heldEchoes.length === 0) disarmHeldFlush(session);
  return held;
}

/** Wiadomość z echem odroczonym w transkrypcie: z `clientMessageId`, po którym klient gasi wpis. */
export function appendHeld(session: Session, held: HeldEcho, deps: HeldEchoDeps, at?: string): void {
  deps.appendMessage(session, 'user', held.blocks, at, undefined, { clientMessageId: held.clientMessageId });
}

/**
 * Wpis wstrzymanego promptu stanął w pliku rozmowy: wiadomość wchodzi W TYM MIEJSCU, z `seq`
 * chwili przetworzenia. Token nieznany = wiadomość już spłukana, a wpis z pliku jest jej
 * duplikatem — przepada jak każde echo. W obu razach to wejście tury.
 */
export function placeHeld(session: Session, token: string, deps: HeldEchoDeps): void {
  const held = takeHeld(session, token);
  deps.noteTurnInput(session);
  if (held === undefined) return;
  appendHeld(session, held, deps);
  deps.emitSessionChanged(session);
}

/**
 * Wstrzymane wiadomości (wszystkie albo ta jedna) na koniec transkryptu TERAZ — plik ich nie
 * przyniesie. Nic nie ginie: dymek staje najpóźniej tam, gdzie stanąłby bez wstrzymania.
 */
export function flushHeld(session: Session, reason: string, deps: HeldEchoDeps, token?: string): void {
  const flushed = token === undefined
    ? session.heldEchoes.splice(0)
    : [takeHeld(session, token)].filter((h): h is HeldEcho => h !== undefined);
  if (session.heldEchoes.length === 0) disarmHeldFlush(session);
  if (flushed.length === 0) return;
  deps.config.logger?.(`${HELD_QUEUE_LOG} ${session.id} ${HELD_FLUSHED_LOG} ${String(flushed.length)}: ${reason}`);
  if (session.state === 'done') return;
  for (const held of flushed) appendHeld(session, held, deps);
  deps.emitSessionChanged(session);
}

/**
 * Po wyjściu z tury: za {@link HELD_ECHO_IDLE_FLUSH_MS} odczyt pola i spłukanie ({@link flushHeldAfterTurn}),
 * chyba że tura wróci.
 */
export function armHeldFlush(session: Session, deps: HeldEchoDeps): void {
  if (session.heldEchoes.length === 0 || session.heldFlushTimer !== null) return;
  const timer = setTimeout(() => {
    session.heldFlushTimer = null;
    // A take-back in flight arms the flush again when it answers.
    if (inTurn(session.state) || takingBack(session)) return;
    flushHeldAfterTurn(session, deps);
  }, HELD_ECHO_IDLE_FLUSH_MS);
  if (typeof timer.unref === 'function') timer.unref();
  session.heldFlushTimer = timer;
}

/*
 * Prompt wysłany w trakcie tury i zablokowany przez hook (`docs/dialogs.md`, „Prompt blocked by a hook”). Hook
 * biegnie od razu przy wysyłce, CLI nie zapisuje ŻADNEGO wpisu, a tekst wraca do pola promptu i stoi tam po turze.
 * Wstrzymana wiadomość nie dostanie więc wpisu z pliku i bez tej kontroli spłukałaby się jako dymek dostarczony, a
 * następna wysyłka z Raroga dokleiłaby się do tekstu w polu. Rozstrzyga pole po turze, po TREŚCI
 * (`SessionDriver.checkHeldLeftover`): pole równe tekstowi wiadomości → notka „nie doszedł” i zgoda drivera na
 * wyczyszczenie pola przed następną wysyłką; pole z innym tekstem → notka „nie potwierdziłem”, pola nie ruszamy; pole
 * puste albo nieczytelne → zwykłe spłukanie, a przy wiadomości, której tekstu driver po wklejeniu nie zobaczył w
 * polu (`unseen`), z notką o wysyłce bez potwierdzenia. Nigdy przycisk ponownej wysyłki: powodu odmowy nie ma.
 */

/**
 * Koniec tury bez wzięcia promptu (timer {@link armHeldFlush}): odczyt pola, potem spłukanie z notkami.
 *
 * Timer zeruje `heldFlushTimer` przed pracą, więc `disarmHeldFlush` trwającego odczytu nie zatrzyma —
 * dlatego numer operacji (`heldCheckOp`), driver i stan sprawdzane po odczycie. Unieważniony odczyt (powrót
 * w turę, inny driver, rezerwacja restartu, nowszy odczyt z wysyłki) niczego nie dopisuje i nie ustawia flag
 * w driverze; wiadomości czekają dalej na następne wyjście z tury albo na dawne ścieżki (odpięcie, wiek).
 * Driver bez odczytu (`RAROG_PROMPT_BLOCK=0`, demo) = spłukanie od razu, jak przed odczytem.
 */
function flushHeldAfterTurn(session: Session, deps: HeldEchoDeps): void {
  const reason = 'turn ended without taking the prompt';
  const driver = session.driver;
  const items = session.heldEchoes.map((held) => ({ token: held.token, text: held.text }));
  const op = ++session.heldCheckOp;
  // A take-back that starts during the field read voids it; the flush is armed again when the take-back answers.
  const valid = (): boolean => heldCheckValid(session, driver, op, deps) && !inTurn(session.state)
    && !takingBack(session);
  // Bez drivera, w trakcie rezerwacji restartu albo po końcu sesji — spłukanie jak przed odczytem.
  const check = items.length > 0 && valid() ? driver?.checkHeldLeftover?.(items, valid) ?? null : null;
  if (check === null) {
    flushHeld(session, reason, deps);
    return;
  }
  void check.then((verdicts) => {
    if (verdicts === null || !valid()) return;
    const placed: HeldLeftover[] = [];
    for (const item of items) {
      // Wzięta w trakcie odczytu (wpis z pliku albo inne spłukanie): jej dymek już stoi, notki nie ma.
      const held = takeHeld(session, item.token);
      if (held === undefined) continue;
      const verdict = verdicts.get(item.token) ?? 'unknown';
      appendHeld(session, held, deps);
      noteHeldLeftover(session, held.text, verdict, deps);
      placed.push(verdict);
    }
    if (placed.length === 0) return;
    deps.config.logger?.(
      `${HELD_QUEUE_LOG} ${session.id} ${HELD_FLUSHED_LOG} ${String(placed.length)}: ${reason}`
        + ` (field: ${placed.join(', ')})`,
    );
    deps.emitSessionChanged(session);
  });
}

/**
 * Wysyłka z Raroga do sesji POZA turą, gdy czekają niewzięte wstrzymane wiadomości — wołane w części
 * synchronicznej `#sendToHerdr`, tuż przed nowym echem i przed `driver.send`. Dymki wstrzymanych wiadomości
 * stają teraz, nad nową wysyłką; odczyt ich pola idzie do kolejki drivera PRZED tą wysyłką, więc jej zadanie
 * widzi już zgodę ustawioną odczytem i czyści pole z niewziętego promptu, zanim dopisze swój tekst.
 * Notki przychodzą po odczycie, pod nowym dymkiem.
 *
 * Unieważnienie bez warunku „poza turą” (różnica wobec {@link flushHeldAfterTurn}): tę turę otwiera nasza
 * wysyłka zaraz po odczycie, który i tak stoi przed nią w kolejce. Unieważniony odczyt gubi tylko notki —
 * dymki już stoją. Driver bez odczytu = zachowanie sprzed odczytu: wiadomości czekają dalej.
 */
export function flushHeldBeforeSend(session: Session, driver: SessionDriver, deps: HeldEchoDeps): void {
  // The send waited for a running take-back ({@link whenTakeBackSettles}); this guard keeps a message it may take
  // out of the transcript should a send ever get here during one.
  if (inTurn(session.state) || session.heldEchoes.length === 0 || takingBack(session)) return;
  const items = session.heldEchoes.map((held) => ({ token: held.token, text: held.text }));
  const op = ++session.heldCheckOp;
  const check = driver.checkHeldLeftover?.(items, () => heldCheckValid(session, driver, op, deps)) ?? null;
  if (check === null) return;
  const flushed = session.heldEchoes.splice(0);
  disarmHeldFlush(session);
  deps.config.logger?.(
    `${HELD_QUEUE_LOG} ${session.id} ${HELD_FLUSHED_LOG} ${String(flushed.length)}: send from Rarog after the turn`,
  );
  for (const held of flushed) appendHeld(session, held, deps);
  void check.then((verdicts) => {
    if (verdicts === null || !heldCheckValid(session, driver, op, deps)) return;
    let noted = false;
    for (const held of flushed) {
      if (noteHeldLeftover(session, held.text, verdicts.get(held.token) ?? 'unknown', deps)) noted = true;
    }
    if (noted) deps.emitSessionChanged(session);
  });
}

/** Czy odczyt pola `op` dalej się liczy: ta sama karta, ten sam driver, ostatni numer, bez restartu i końca. */
function heldCheckValid(session: Session, driver: SessionDriver | null, op: number, deps: HeldEchoDeps): boolean {
  return deps.sessions.get(session.id) === session && session.driver === driver && driver !== null
    && session.heldCheckOp === op && session.state !== 'done' && !deps.restarting(session.id);
}

/** Notka pod dymkiem wstrzymanej wiadomości po odczycie pola; `true` = dopisana. */
function noteHeldLeftover(session: Session, text: string, verdict: HeldLeftover, deps: HeldEchoDeps): boolean {
  const line = verdict === 'not-taken' ? heldNotTakenText(text, deps.system()) : verdict === 'unconfirmed'
    ? heldUnconfirmedText(text, deps.system()) : verdict === 'unseen' ? heldUnseenText(text) : null;
  if (line === null) return false;
  deps.appendMessage(session, 'system', [{ type: 'text', text: line }]);
  return true;
}

/**
 * A queue take-back of the session starts: until the returned function runs, the turn end flush appends nothing and
 * a send waits ({@link whenTakeBackSettles}), so a message the take-back takes never stands in the transcript as sent.
 * The returned function (call it once, after the take-back's held echoes left the session) arms the turn end flush for
 * the held messages the take-back left, when the session is outside a turn (inside one, the next turn end arms it);
 * when it ends the last take-back of the session, the waiting sends go on.
 */
export function pauseHeldFlush(session: Session, deps: HeldEchoDeps): () => void {
  let running = takeBacksRunning.get(session);
  if (running === undefined) {
    let settle = (): void => {};
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    running = { count: 0, settled, settle };
    takeBacksRunning.set(session, running);
  }
  const mine = running;
  mine.count += 1;
  return () => {
    mine.count -= 1;
    if (mine.count > 0) return;
    takeBacksRunning.delete(session);
    if (deps.sessions.get(session.id) === session && !inTurn(session.state)) armHeldFlush(session, deps);
    mine.settle();
  };
}

/**
 * `null` when no queue take-back of the session runs; otherwise a promise that settles once none runs any more (200,
 * refusal or throw), a take-back started meanwhile included. A send awaits it before the flush before a send and its
 * own echo: until the take-back answers, it is unknown which held messages it takes and which ones their file entries
 * place, and the driver sends the new prompt only after the take-back step anyway. The take-back never sends through
 * the send path, so it never waits for a send.
 */
export function whenTakeBackSettles(session: Session): Promise<void> | null {
  const running = takeBacksRunning.get(session);
  return running === undefined ? null : running.settled.then(() => whenTakeBackSettles(session) ?? undefined);
}

function takingBack(session: Session): boolean {
  return takeBacksRunning.has(session);
}

export function disarmHeldFlush(session: Session): void {
  if (session.heldFlushTimer === null) return;
  clearTimeout(session.heldFlushTimer);
  session.heldFlushTimer = null;
}

/** Sufit wieku wstrzymanej wiadomości — ten sam co okna echa (follower wpis i tak wyrzucił). */
export function expireHeld(session: Session, deps: HeldEchoDeps): void {
  const now = deps.now();
  const old = session.heldEchoes.filter((h) => now - h.heldAtMs >= ECHO_TTL_MS);
  for (const held of old) flushHeld(session, 'age over the echo window cap', deps, held.token);
}
