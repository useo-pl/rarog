/**
 * Przegląd dowodów kanału zgód w transkrypcie (warstwa 1), poza oknem followera: fakty jednej tury wątku
 * głównego (wywołania, wyniki z rozstrzygnięciem dialogu, koniec tury), z których `dialogs/layer1/bind.ts` wiąże
 * klucze hooka z wywołaniami, a `dialogs/layer1/cycle.ts` rozlicza skutek. Opis: `docs/dialogs.md`, „Channel cycle”.
 *
 * Follower trzyma ogon pliku (`HISTORY_MAX_BYTES`) i podaje wpisy przyrostowo, więc dowód sprzed jego okna, po
 * restarcie serwera albo po przyroście większym niż okno byłby niewidoczny. Ten moduł czyta plik strumieniowo od
 * checkpointu ({@link ConsentCheckpoint}: plik, sesja, `inode`, bajt początku pełnej linii):
 *
 * - {@link locateConsentCheckpoint}: przy pierwszym tiku klucza szuka wstecz od pozycji followera
 *   (`transcriptOffset`) pierwszej linii tury — wpisu człowieka z `promptId` tury (nie wyniku, nie wpisu silnika,
 *   nie przerwania). Bez pewnego początku w {@link CONSENT_LOCATE_MAX_BYTES} checkpoint wskazuje początek pliku.
 * - {@link locateConsentCall}: the line of one call in the main thread (the `Agent` call that started a subagent, for
 *   the observation in `consent-subagent.ts`), searched backward from the end of the file the same way.
 * - {@link createConsentEvidenceScanner}: przebiegi przeglądu z sufitem bajtów odczytu; każdy kolejny czyta dalej
 *   od miejsca, w którym skończył poprzedni, a niedokończona linia (także dłuższa niż sufit) czeka w pamięci
 *   przeglądu na resztę (postęp gwarantowany). Po restarcie przegląd rusza od checkpointu, czyli od pełnej linii.
 *   Inny plik, inny `inode` albo plik krótszy niż przeczytana pozycja = przegląd od początku pliku; przegląd, który
 *   zaczął się w środku tury, też wraca na początek pliku.
 *
 * - {@link createConsentEvidenceReview}: przegląd w serwerze, na tiku cyklu. Rekord bez checkpointu dostaje go
 *   pierwszym tikiem (szukanie wstecz od końca pliku, czyli od miejsca, do którego doszedł transkrypt), a tura
 *   z rekordami bez dowodu dostaje przebieg od razu, potem co {@link CONSENT_EVIDENCE_SCAN_INTERVAL_MS}, a póki
 *   przebieg nie doczytał pliku albo tura ma kartę na urządzeniach (`live`) — na każdym tiku. Fakty idą do
 *   `ConsentCycle.applyTurn`.
 *
 * Tura `promptId` zaczyna się pierwszym wpisem `user` wątku głównego z tym `promptId`, a kończy wpisem
 * `system/turn_duration` albo wpisem człowieka z innym `promptId`. Wpisy `tool_use` nie niosą `promptId`:
 * należą do tury, w której stoją. Wpisy subagentów (`isSidechain`) tura wątku głównego pomija.
 *
 * Tura subagenta (cel z `agentId`, 5.2 i 5.6): wywołania i wyniki z jego pliku (także pliku agenta
 * workflow, `agentFileOf`) czyta `consent-subagent.ts`, a ten moduł dokłada fakty pliku głównego o tym agencie ({@link ConsentAgentTurn}), od
 * checkpointu tury głównej `promptId` do końca pliku, bez zatrzymania na końcu tury głównej (subagent w tle kończy
 * po niej): start w tle (wynik `Agent` ze statusem `async_launched` albo `forked` z `background: true`), koniec
 * z pierwszego planu (wynik `Agent` z `agentId` i statusem końcowym albo `forked` bez `background: true`) i meldunek
 * `<task-notification>` z `<task-id>` agenta i statusem końcowym w każdym nośniku (wpis `user` z gołym napisem,
 * kolejka promptów, załącznik), także postój. Kształty: `background/cli-shapes.ts` i pomiar na CLI 2.1.319.
 * Pełna linia pliku głównego w tym zakresie, której nie dało się sparsować, niczego do faktów nie dokłada, ale
 * przebieg oddaje ją jako `unparsedLine` (5.3: nieczytelny JSON = plik nieznany do końca).
 * Plik główny idzie przed plikiem subagenta, więc wynik zapisany przed końcem agenta jest w tym samym przebiegu.
 * Przy `agentFiles: false` (`RAROG_AGENT_FILES=0`) przegląd celów subagentów nie czyta niczego.
 */
import { open, stat } from 'node:fs/promises';
import { CLI_SHAPES } from './background/cli-shapes.ts';
import {
  isAgentStandby, isTaskNotification, notificationFingerprint, parseTaskNotification,
} from './background/notification.ts';
import { agentFileOf, createSubagentTurnScanner } from './consent-subagent.ts';
import { canonicalSha256 } from './dialogs/hook/canon.ts';
import type {
  ConsentAgentEnd, ConsentAgentTurn, ConsentTurnFacts, TurnToolResult, TurnToolUse,
} from './dialogs/layer1/bind.ts';
import { CONSENT_EVIDENCE_SCAN_INTERVAL_MS, CONSENT_EVIDENCE_SCAN_MAX_BYTES } from './dialogs/layer1/contract.ts';
import type { ConsentCheckpoint } from './dialogs/layer1/contract.ts';
import type { ConsentCycle, ConsentEvidenceTarget } from './dialogs/layer1/cycle.ts';
import { isTurnEnd, parseJsonlEntry, toolResultDecisions, turnPromptOf, turnToolUses } from './jsonl-pending.ts';

/** Najdalej wstecz od podpowiedzi szuka {@link locateConsentCheckpoint}; dalej checkpoint = początek pliku. */
export const CONSENT_LOCATE_MAX_BYTES = 64 * 1024 * 1024;

/** Pierwsze okno szukania wstecz; każde kolejne dwa razy większe. */
const LOCATE_FIRST_WINDOW = 256 * 1024;

/** Ile za podpowiedzią czyta szukanie (follower mógł nie doczytać wpisu początku tury). */
const LOCATE_FORWARD_BYTES = 4 * 1024 * 1024;

/** Kawałek jednego odczytu przebiegu. */
const READ_CHUNK = 1024 * 1024;

/** Dysk przeglądu; testy podmieniają go, żeby policzyć bajty przebiegu. */
export interface ConsentEvidenceIo {
  stat(path: string): Promise<{ readonly ino: number; readonly size: number } | null>;
  read(path: string, start: number, length: number): Promise<Buffer | null>;
}

export const nodeConsentEvidenceIo: ConsentEvidenceIo = {
  async stat(path) {
    try {
      const info = await stat(path);
      return info.isFile() ? { ino: info.ino, size: info.size } : null;
    } catch {
      return null;
    }
  },
  async read(path, start, length) {
    if (length <= 0) return Buffer.alloc(0);
    let handle;
    try {
      handle = await open(path, 'r');
    } catch {
      return null;
    }
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.subarray(0, bytesRead);
    } catch {
      return null;
    } finally {
      await handle.close().catch(() => undefined);
    }
  },
};

/** Linia jsonl z bajtem początku i bajtem za jej `\n`. */
interface Line {
  readonly start: number;
  readonly next: number;
  readonly text: string;
}

/** Pełne linie z bufora czytanego od `base`; `aligned` = `base` jest początkiem linii (inaczej pierwsza wypada). */
function linesOf(buffer: Buffer, base: number, aligned: boolean): { lines: Line[]; end: number } {
  const lines: Line[] = [];
  let from = 0;
  if (!aligned) {
    const first = buffer.indexOf(0x0a);
    if (first === -1) return { lines, end: base };
    from = first + 1;
  }
  for (;;) {
    const cut = buffer.indexOf(0x0a, from);
    if (cut === -1) break;
    lines.push({ start: base + from, next: base + cut + 1, text: buffer.subarray(from, cut).toString('utf8') });
    from = cut + 1;
  }
  return { lines, end: base + from };
}

/** Pierwsza linia tury: wpis człowieka z tym `promptId`, nie wynik i nie przerwanie. */
function isTurnOpening(entry: unknown, promptId: string): boolean {
  const turn = turnPromptOf(entry);
  return turn !== null && turn.promptId === promptId && turn.human && !turn.result && !turn.interruption;
}

/**
 * Checkpoint tury `promptId` w pliku `file`: bajt jej pierwszej linii, szukany wstecz od `hint` (pozycja followera)
 * oknami rosnącymi do {@link CONSENT_LOCATE_MAX_BYTES}. Bez pewnego początku albo bez podpowiedzi — `lineStart: 0`.
 * `null` = pliku nie ma.
 */
export async function locateConsentCheckpoint(
  file: string, sessionId: string, promptId: string, hint: number | null,
  io: ConsentEvidenceIo = nodeConsentEvidenceIo,
): Promise<ConsentCheckpoint | null> {
  const info = await io.stat(file);
  if (info === null) return null;
  const at = (lineStart: number): ConsentCheckpoint => ({ file, sessionId, inode: info.ino, lineStart });
  if (hint === null) return at(0);
  const anchor = Math.min(Math.max(0, hint), info.size);
  const end = Math.min(info.size, anchor + LOCATE_FORWARD_BYTES);
  for (let back = LOCATE_FIRST_WINDOW; ; back *= 2) {
    const start = Math.max(0, anchor - back);
    const buffer = await io.read(file, start, end - start);
    if (buffer === null) return at(0);
    const { lines } = linesOf(buffer, start, start === 0);
    // Wpisy tury stoją w pliku jeden za drugim, więc pierwszy wpis z jej `promptId` w oknie jest jej początkiem
    // albo okno zaczyna się w jej środku.
    const first = lines.find((line) => turnPromptOf(parseJsonlEntry(line.text))?.promptId === promptId);
    if (first !== undefined && isTurnOpening(parseJsonlEntry(first.text), promptId)) return at(first.start);
    // Okno od środka tury albo bez niej: szersze okno, a na końcu początek pliku (przegląd od zera jest wolniejszy,
    // ale niczego nie gubi).
    if (start === 0 || back >= CONSENT_LOCATE_MAX_BYTES) return at(0);
  }
}

/**
 * Checkpoint at the main-thread line with the call `toolUseId` (an assistant `tool_use` entry), searched backward from
 * the end of `file` in windows growing to {@link CONSENT_LOCATE_MAX_BYTES}; `null` = no file, or no such line within
 * them (the caller then takes {@link locateConsentCheckpoint}).
 */
export async function locateConsentCall(
  file: string, sessionId: string, toolUseId: string, io: ConsentEvidenceIo = nodeConsentEvidenceIo,
): Promise<ConsentCheckpoint | null> {
  const info = await io.stat(file);
  if (info === null) return null;
  for (let back = LOCATE_FIRST_WINDOW; ; back *= 2) {
    const start = Math.max(0, info.size - back);
    const buffer = await io.read(file, start, info.size - start);
    if (buffer === null) return null;
    const { lines } = linesOf(buffer, start, start === 0);
    // Text sieve first: a line without the id holds no call with it.
    const found = lines.find((line) => line.text.includes(toolUseId)
      && turnToolUses(parseJsonlEntry(line.text)).some((use) => use.id === toolUseId));
    if (found !== undefined) return { file, sessionId, inode: info.ino, lineStart: found.start };
    if (start === 0 || back >= CONSENT_LOCATE_MAX_BYTES) return null;
  }
}

/** Faza przeglądu jednej tury. */
type Phase = 'before' | 'inside' | 'ended';

/** Stan przeglądu jednej tury między przebiegami (w pamięci; po restarcie przegląd rusza od checkpointu). */
interface TurnScan {
  file: string;
  inode: number;
  lineStart: number;
  /** Bajt za ostatnią przetworzoną pełną linią. */
  position: number;
  /** Bajt, do którego przegląd przeczytał plik; między `position` a nim leży niedokończona linia `carry`. */
  readAt: number;
  carry: Buffer;
  phase: Phase;
  partial: boolean;
  line: number;
  toolUses: TurnToolUse[];
  results: TurnToolResult[];
}

export interface ConsentEvidenceTargetInput {
  readonly sessionId: string;
  /** Subagent tury (5.2); `null` albo brak = wątek główny. */
  readonly agentId?: string | null;
  readonly promptId: string;
  /** Bieżąca ścieżka pliku wątku głównego (follower albo `transcript-path.ts`). */
  readonly file: string;
  readonly checkpoint: ConsentCheckpoint | null;
}

export type ConsentEvidencePass =
  | { readonly status: 'missing' }
  | {
    readonly status: 'ok';
    readonly facts: ConsentTurnFacts;
    readonly checkpoint: ConsentCheckpoint;
    /** Przebieg doczytał do końca pliku (bez niedokończonej linii za pozycją albo z nią). */
    readonly caughtUp: boolean;
    /** Bajty przeczytane w tym przebiegu. */
    readonly bytes: number;
    /**
     * Tylko cel z `agentId`: od checkpointu do pozycji przebiegu stoi pełna linia pliku głównego, której nie dało się
     * sparsować (także w przebiegu wcześniejszym tego przeglądu). Cel wątku głównego pola nie ma.
     */
    readonly unparsedLine?: boolean;
  };

export interface ConsentEvidenceScanner {
  /**
   * Jeden przebieg przeglądu tury (sufit bajtów z opcji osobno dla każdego pliku). Cel z `agentId`: plik główny
   * (fakty o agencie), potem plik subagenta; brak pliku głównego albo `agentFiles: false` = `missing`.
   */
  pass(target: ConsentEvidenceTargetInput): Promise<ConsentEvidencePass>;
  /** Zapomina stan przeglądu tury (tura rozliczona). */
  forget(sessionId: string, promptId: string, agentId?: string | null): void;
}

export interface ConsentEvidenceScannerOptions {
  readonly io?: ConsentEvidenceIo;
  /** Sufit bajtów jednego przebiegu (domyślnie {@link CONSENT_EVIDENCE_SCAN_MAX_BYTES}). */
  readonly maxBytes?: number;
  /** Pliki subagentów (`RAROG_AGENT_FILES`); `false` = cele subagentów bez odczytu. Domyślnie `true`. */
  readonly agentFiles?: boolean;
}

function digestOf(input: unknown): string | null {
  try {
    return canonicalSha256(input);
  } catch {
    return null;
  }
}

/** Faza po `noteLine` (funkcja, bo zawężenie typu z warunku pętli nie widzi zmiany w `noteLine`). */
function isEnded(scan: TurnScan): boolean {
  return scan.phase === 'ended';
}

function freshScan(file: string, inode: number, lineStart: number): TurnScan {
  return {
    file, inode, lineStart, position: lineStart, readAt: lineStart, carry: Buffer.alloc(0), phase: 'before',
    partial: false, line: 0, toolUses: [], results: [],
  };
}

/** Jeden wpis w stanie przeglądu tury `promptId`. */
function noteLine(scan: TurnScan, promptId: string, text: string): void {
  const entry = parseJsonlEntry(text);
  if (entry === null) return;
  scan.line += 1;
  const turn = turnPromptOf(entry);
  if (scan.phase === 'before') {
    if (turn?.promptId !== promptId) return;
    scan.phase = 'inside';
    // Pierwszy wpis tury, który jej nie otwiera, znaczy przegląd od środka tury (poza początkiem pliku).
    if (!isTurnOpening(entry, promptId) && scan.lineStart > 0) scan.partial = true;
  }
  if (scan.phase !== 'inside') return;
  if (isTurnEnd(entry) || (turn !== null && turn.promptId !== promptId && turn.human && !turn.result)) {
    scan.phase = 'ended';
    return;
  }
  for (const use of turnToolUses(entry)) {
    if (scan.toolUses.some((known) => known.id === use.id)) continue;
    scan.toolUses.push({ id: use.id, name: use.toolName, inputSha256: digestOf(use.input), line: scan.line });
  }
  for (const result of toolResultDecisions(entry)) {
    if (scan.results.some((known) => known.toolUseId === result.toolUseId)) continue;
    scan.results.push({
      toolUseId: result.toolUseId, line: scan.line, at: result.at, decision: result.decision, source: result.source,
      interrupted: result.interrupted,
    });
  }
}

// Literały CLI pod krótkimi nazwami — wartości i pomiary stoją w rejestrze `background/cli-shapes.ts`.
const TOOL_RESULT = CLI_SHAPES.toolResult.literals.field;
const START = CLI_SHAPES.taskStart.literals;
const FOREGROUND = CLI_SHAPES.foregroundEnd.literals;
const CARRIERS = CLI_SHAPES.notificationCarriers.literals;
const TERMINAL_STATUSES: readonly string[] = Object.values(CLI_SHAPES.terminalStatuses.literals);

/**
 * Status wyniku `Agent` przy starcie subagenta w tle (pomiar na CLI 2.1.319: `isAsync: true`, `agentId`,
 * 1596–2005 ms przed startem hooka; fixture `background-hidden-1.glowny.jsonl`). Rejestr `cli-shapes.ts` go nie niesie: reduktor
 * zadań liczy każdy status spoza końcowych jako start.
 */
const BG_START_STATUS = 'async_launched';

/** Najwięcej końców jednego agenta w pamięci przeglądu (wznowienia `SendMessage`); dalej wypadają najstarsze. */
const AGENT_ENDS_MAX = 256;

/** Najwięcej odcisków meldunków (kopie jednego meldunku w 2–3 nośnikach) w pamięci przeglądu jednego agenta. */
const AGENT_SEEN_MAX = 1024;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Zdarzenie pliku głównego o agencie: start w tle albo koniec biegu (z odciskiem kopii meldunku). */
type AgentEvent =
  | { readonly kind: 'launch'; readonly at: number | null }
  | { readonly kind: 'end'; readonly end: ConsentAgentEnd; readonly print: string | null };

/** Tekst meldunku z nośnika: wpis `user` z gołym napisem, kolejka promptów albo załącznik `queued_command`. */
function carriedText(entry: Record<string, unknown>): string {
  const type = entry['type'];
  if (type === 'user') return asText(asRecord(entry['message'])?.['content']);
  if (type === CARRIERS.queueType) return asText(entry[CARRIERS.queueText]);
  if (type === CARRIERS.attachmentType) {
    const attachment = asRecord(entry[CARRIERS.attachmentField]);
    if (attachment?.['type'] === CARRIERS.queuedCommand) return asText(attachment[CARRIERS.queuedText]);
  }
  return '';
}

/**
 * Zdarzenie wpisu pliku głównego o agencie `agentId` albo `null` (opis modułu). Wpis subagenta (`isSidechain`) i koniec
 * bez czytelnego `timestamp` zdarzeniem nie są.
 */
function agentEventOf(value: unknown, agentId: string): AgentEvent | null {
  const entry = asRecord(value);
  if (entry === null || entry['isSidechain'] === true) return null;
  const parsedAt = Date.parse(asText(entry['timestamp']));
  const at = Number.isFinite(parsedAt) ? parsedAt : null;
  const text = carriedText(entry);
  if (text !== '') {
    if (!isTaskNotification(text)) return null;
    const notification = parseTaskNotification(text);
    if (notification.id !== agentId || !TERMINAL_STATUSES.includes(notification.status) || at === null) return null;
    return {
      kind: 'end', print: notificationFingerprint(text),
      end: { at, status: notification.status, via: 'notification', standby: isAgentStandby(notification) },
    };
  }
  if (entry['type'] !== 'user') return null;
  const result = asRecord(entry[TOOL_RESULT]);
  if (result === null || asText(result[START.agentId]) !== agentId) return null;
  const status = asText(result[FOREGROUND.status]);
  const background = result[FOREGROUND.background] === true;
  if (status === BG_START_STATUS || (status === FOREGROUND.forked && background)) return { kind: 'launch', at };
  if (at !== null && (TERMINAL_STATUSES.includes(status) || status === FOREGROUND.forked)) {
    return { kind: 'end', print: null, end: { at, status, via: 'result', standby: false } };
  }
  return null;
}

/** Stan przeglądu pliku głównego dla jednego agenta (od checkpointu tury głównej do końca pliku). */
interface AgentScan {
  file: string;
  inode: number;
  lineStart: number;
  readAt: number;
  carry: Buffer;
  launch: { at: number | null } | null;
  ends: ConsentAgentEnd[];
  seen: Set<string>;
  /** Pełna linia od checkpointu, której nie dało się sparsować. */
  unparsed: boolean;
}

function freshAgentScan(file: string, inode: number, lineStart: number): AgentScan {
  return {
    file, inode, lineStart, readAt: lineStart, carry: Buffer.alloc(0), launch: null, ends: [], seen: new Set(),
    unparsed: false,
  };
}

/** Jedna pełna linia pliku głównego w stanie przeglądu agenta. */
function noteAgentLine(scan: AgentScan, agentId: string, text: string): void {
  if (text.trim() === '') return;
  const entry = parseJsonlEntry(text);
  if (entry === null) {
    // Linia mogła nieść start albo koniec agenta: bez niej plik główny nie jest znany do końca.
    scan.unparsed = true;
    return;
  }
  // Sito tekstowe: linia bez id agenta nie niesie ani jego startu, ani końca.
  if (!text.includes(agentId)) return;
  const event = agentEventOf(entry, agentId);
  if (event === null) return;
  if (event.kind === 'launch') {
    scan.launch ??= { at: event.at };
    return;
  }
  if (event.print !== null) {
    // Jeden meldunek stoi w 2–3 nośnikach o identycznej treści; liczy się pierwsza kopia.
    if (scan.seen.has(event.print)) return;
    if (scan.seen.size >= AGENT_SEEN_MAX) scan.seen.clear();
    scan.seen.add(event.print);
  }
  scan.ends.push(event.end);
  if (scan.ends.length > AGENT_ENDS_MAX) scan.ends.shift();
}

export function createConsentEvidenceScanner(options: ConsentEvidenceScannerOptions = {}): ConsentEvidenceScanner {
  const io = options.io ?? nodeConsentEvidenceIo;
  const maxBytes = Math.max(1, options.maxBytes ?? CONSENT_EVIDENCE_SCAN_MAX_BYTES);
  const agentFiles = options.agentFiles ?? true;
  const scans = new Map<string, TurnScan>();
  const agentScans = new Map<string, AgentScan>();
  // Every run of the agent file, with run boundaries: a key binds only a call of its own run (rule 6 of `bind.ts`).
  const subagents = createSubagentTurnScanner(io, 'file');
  /** Plik subagenta ostatniego przebiegu celu (do `forget`). */
  const subagentFiles = new Map<string, string>();
  const slot = (sessionId: string, promptId: string): string => `${sessionId}\n${promptId}`;
  const agentSlot = (sessionId: string, agentId: string, promptId: string): string =>
    `${sessionId}\n${agentId}\n${promptId}`;

  /** Przebieg celu subagenta: plik główny (fakty o agencie), potem plik subagenta (opis modułu). */
  async function agentPass(target: ConsentEvidenceTargetInput, agentId: string): Promise<ConsentEvidencePass> {
    if (!agentFiles) return { status: 'missing' };
    const info = await io.stat(target.file);
    if (info === null) return { status: 'missing' };
    const id = agentSlot(target.sessionId, agentId, target.promptId);
    let scan = agentScans.get(id);
    const point = target.checkpoint;
    if (scan === undefined) {
      const usable = point !== null && point.file === target.file && point.sessionId === target.sessionId
        && point.inode === info.ino && point.lineStart <= info.size;
      scan = freshAgentScan(target.file, info.ino, usable ? point.lineStart : 0);
    }
    if (scan.file !== target.file || scan.inode !== info.ino || scan.readAt > info.size) {
      // Plik przeniesiony, podmieniony albo skrócony: pozycje sprzed zmiany nic nie znaczą.
      scan = freshAgentScan(target.file, info.ino, 0);
    }
    agentScans.set(id, scan);

    let bytes = 0;
    let carry: Buffer = scan.carry;
    let readAt = scan.readAt;
    while (readAt < info.size && bytes < maxBytes) {
      const chunk = await io.read(target.file, readAt, Math.min(READ_CHUNK, info.size - readAt, maxBytes - bytes));
      if (chunk === null || chunk.length === 0) break;
      readAt += chunk.length;
      bytes += chunk.length;
      const buffer = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      const base = readAt - buffer.length;
      const { lines, end } = linesOf(buffer, base, true);
      for (const line of lines) noteAgentLine(scan, agentId, line.text);
      carry = buffer.subarray(end - base);
    }
    scan.carry = Buffer.from(carry);
    scan.readAt = readAt;
    const mainCaughtUp = readAt >= info.size;

    // Plik subagenta albo agenta workflow (ten sam wybór co obserwacja; plik w dwóch przebiegach = brak faktów).
    const subFile = await agentFileOf(target.file, agentId, io);
    if (subFile !== null) subagentFiles.set(id, subFile);
    const sub = subFile === null ? null : await subagents.pass(subFile, agentId, maxBytes);
    const agent: ConsentAgentTurn = {
      agentId, launch: scan.launch === null ? null : { ...scan.launch }, ends: [...scan.ends],
      runStarts: sub === null ? [] : [...sub.runStarts], settled: sub?.settled ?? false,
    };
    const facts: ConsentTurnFacts = {
      promptId: target.promptId,
      ended: scan.ends.length > 0,
      partial: sub?.partial ?? true,
      toolUses: sub === null ? [] : [...sub.toolUses],
      results: sub === null ? [] : [...sub.results],
      agent,
    };
    const checkpoint: ConsentCheckpoint = {
      file: scan.file, sessionId: target.sessionId, inode: scan.inode, lineStart: scan.lineStart,
    };
    // Brak pliku subagenta: nic więcej do przeczytania do następnego przebiegu.
    const caughtUp = mainCaughtUp && (sub === null || sub.caughtUp);
    return {
      status: 'ok', facts, checkpoint, caughtUp, bytes: bytes + (sub?.bytes ?? 0), unparsedLine: scan.unparsed,
    };
  }

  async function pass(target: ConsentEvidenceTargetInput): Promise<ConsentEvidencePass> {
    const agentId = target.agentId ?? null;
    if (agentId !== null) return agentPass(target, agentId);
    const info = await io.stat(target.file);
    if (info === null) return { status: 'missing' };
    const id = slot(target.sessionId, target.promptId);
    let scan = scans.get(id);
    const point = target.checkpoint;
    if (scan === undefined) {
      const usable = point !== null && point.file === target.file && point.sessionId === target.sessionId
        && point.inode === info.ino && point.lineStart <= info.size;
      scan = freshScan(target.file, info.ino, usable ? point.lineStart : 0);
    }
    if (scan.file !== target.file || scan.inode !== info.ino || scan.readAt > info.size) {
      // Plik przeniesiony, podmieniony albo skrócony: pozycje sprzed zmiany nic nie znaczą.
      scan = freshScan(target.file, info.ino, 0);
    }
    scans.set(id, scan);

    let bytes = 0;
    let carry: Buffer = scan.carry;
    let readAt = scan.readAt;
    // Sufit przebiegu liczy bajty odczytu: linia dłuższa niż sufit dochodzi przez kilka przebiegów, w `carry`.
    while (scan.phase !== 'ended' && readAt < info.size && bytes < maxBytes) {
      const chunk = await io.read(target.file, readAt, Math.min(READ_CHUNK, info.size - readAt, maxBytes - bytes));
      if (chunk === null || chunk.length === 0) break;
      readAt += chunk.length;
      bytes += chunk.length;
      const buffer = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      const base = readAt - buffer.length;
      const { lines, end } = linesOf(buffer, base, true);
      for (const line of lines) {
        noteLine(scan, target.promptId, line.text);
        scan.position = line.next;
        if (isEnded(scan)) break;
      }
      carry = buffer.subarray(end - base);
      if (scan.partial) break;
    }
    // Kopia, żeby niedokończona linia nie trzymała całego bufora odczytu do następnego przebiegu.
    scan.carry = Buffer.from(carry);
    scan.readAt = readAt;

    let restarted = false;
    if (scan.partial && scan.lineStart > 0) {
      // Przegląd zaczął się w środku tury: wcześniejsze wywołania mogły umknąć, więc od początku pliku.
      scan = freshScan(target.file, info.ino, 0);
      scans.set(id, scan);
      restarted = true;
    }
    const checkpoint: ConsentCheckpoint = {
      file: scan.file, sessionId: target.sessionId, inode: scan.inode, lineStart: scan.lineStart,
    };
    const facts: ConsentTurnFacts = {
      promptId: target.promptId,
      ended: scan.phase === 'ended',
      partial: scan.partial || scan.phase === 'before',
      toolUses: [...scan.toolUses],
      results: [...scan.results],
    };
    const caughtUp = !restarted && (scan.phase === 'ended' || readAt >= info.size);
    return { status: 'ok', facts, checkpoint, caughtUp, bytes };
  }

  return {
    pass,
    forget(sessionId, promptId, agentId = null) {
      if (agentId === null) {
        scans.delete(slot(sessionId, promptId));
        return;
      }
      const id = agentSlot(sessionId, agentId, promptId);
      agentScans.delete(id);
      const subFile = subagentFiles.get(id);
      subagentFiles.delete(id);
      // One scan per agent file, shared by the agent's targets: it goes with the last of them.
      if (subFile !== undefined && ![...subagentFiles.values()].includes(subFile)) subagents.forget(subFile, agentId);
    },
  };
}

export interface ConsentEvidenceReviewOptions {
  readonly cycle: Pick<ConsentCycle, 'evidenceTargets' | 'setCheckpoint' | 'applyTurn'>;
  /**
   * Bieżąca ścieżka pliku wątku głównego sesji silnika albo `null` (pliku nie ma). `known` = ostatnio znana ścieżka
   * (poprzedni przebieg albo checkpoint rekordu po restarcie) albo `null`.
   */
  readonly locate: (sessionId: string, known: string | null) => Promise<string | null>;
  readonly scanner?: ConsentEvidenceScanner;
  readonly io?: ConsentEvidenceIo;
  readonly now?: () => number;
  /** Odstęp przebiegów tury, która doczytała plik (domyślnie {@link CONSENT_EVIDENCE_SCAN_INTERVAL_MS}). */
  readonly intervalMs?: number;
  /**
   * Pliki subagentów (`RAROG_AGENT_FILES`); `false` = cele subagentów bez odczytu (bez checkpointu i przebiegu).
   * Domyślnie `true`.
   */
  readonly agentFiles?: boolean;
  readonly log?: (line: string) => void;
}

export interface ConsentEvidenceReview {
  /**
   * Jeden tik przeglądu: checkpoint dla rekordów bez niego, potem przebieg tur, którym przypada, i ich fakty do cyklu.
   * Nie rzuca; tik w toku = następny wychodzi od razu.
   */
  tick(): Promise<void>;
}

/** Stan przebiegów jednej tury między tikami. */
interface TurnPace {
  at: number;
  caughtUp: boolean;
  readonly sessionId: string;
  readonly agentId: string | null;
  readonly promptId: string;
}

/** Podpowiedź dla {@link locateConsentCheckpoint}: koniec pliku (szukanie przytnie ją do rozmiaru). */
const FROM_END_OF_FILE = Number.MAX_SAFE_INTEGER;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createConsentEvidenceReview(options: ConsentEvidenceReviewOptions): ConsentEvidenceReview {
  const { cycle } = options;
  const io = options.io ?? nodeConsentEvidenceIo;
  const agentFiles = options.agentFiles ?? true;
  const scanner = options.scanner ?? createConsentEvidenceScanner({ io, agentFiles });
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? CONSENT_EVIDENCE_SCAN_INTERVAL_MS;
  const log = options.log ?? ((): void => {});
  /** Ostatnia znaleziona ścieżka pliku per sesja silnika. */
  const files = new Map<string, string>();
  const paces = new Map<string, TurnPace>();
  let running = false;
  const turnOf = (sessionId: string, agentId: string | null, promptId: string): string =>
    `${sessionId}\n${agentId ?? ''}\n${promptId}`;
  /** Cele, które przegląd czyta: bez plików subagentów (`agentFiles: false`) tylko wątek główny. */
  const targets = (): ConsentEvidenceTarget[] =>
    cycle.evidenceTargets().filter((target) => agentFiles || target.agentId === null);

  async function fileOf(sessionId: string, known: string | null): Promise<string | null> {
    const found = await options.locate(sessionId, files.get(sessionId) ?? known);
    if (found === null) files.delete(sessionId);
    else files.set(sessionId, found);
    return found;
  }

  /** Checkpoint pierwszym tikiem: każdy klucz tury bez niego dostaje początek tury (istniejący zostaje). */
  async function checkpoints(): Promise<void> {
    for (const target of targets()) {
      if (target.checkpoint !== null) continue;
      try {
        const file = await fileOf(target.sessionId, null);
        if (file === null) continue;
        const point = await locateConsentCheckpoint(file, target.sessionId, target.promptId, FROM_END_OF_FILE, io);
        if (point === null) continue;
        for (const key of target.keys) await cycle.setCheckpoint(target.sessionId, key, point);
      } catch (err) {
        log(`consent: transcript checkpoint of session ${target.sessionId} failed: ${errText(err)}`);
      }
    }
  }

  async function passes(): Promise<void> {
    const active = new Set<string>();
    for (const target of targets()) {
      const id = turnOf(target.sessionId, target.agentId, target.promptId);
      active.add(id);
      const pace = paces.get(id);
      // A turn with a card on the devices is read on every tick; the pass reads only new bytes.
      if (pace !== undefined && pace.caughtUp && target.live !== true && now() - pace.at < intervalMs) continue;
      try {
        const file = await fileOf(target.sessionId, target.checkpoint?.file ?? null);
        if (file === null) continue;
        const pass = await scanner.pass({ ...target, file });
        if (pass.status !== 'ok') continue;
        paces.set(id, {
          at: now(), caughtUp: pass.caughtUp, sessionId: target.sessionId, agentId: target.agentId,
          promptId: target.promptId,
        });
        await cycle.applyTurn(target.sessionId, target.promptId, pass.facts);
      } catch (err) {
        log(`consent: transcript check of session ${target.sessionId} failed: ${errText(err)}`);
      }
    }
    // Tura bez rekordów czekających na dowód: stan przeglądu w pamięci już nie jest potrzebny.
    for (const [id, pace] of [...paces]) {
      if (active.has(id)) continue;
      paces.delete(id);
      scanner.forget(pace.sessionId, pace.promptId, pace.agentId);
    }
  }

  return {
    async tick() {
      if (running) return;
      running = true;
      try {
        await checkpoints();
        await passes();
      } catch (err) {
        log(`consent: transcript check failed: ${errText(err)}`);
      } finally {
        running = false;
      }
    },
  };
}
