/**
 * Zdania obszaru `herdr`: błędy gniazda herdr i klas `HerdrError`, status połączenia.
 *
 * Kod ma postać `herdr.<nazwa>` w kebab-case. Format wpisu, rodzaje argumentów i reguła „opublikowany kod nie
 * zmienia znaczenia, argumentów ani szablonu”: `index.ts`. Zdanie własne dla apki powstaje wyłącznie przez `say`
 * z kodem z tego pliku.
 */
import type { SentenceArea } from './index.ts';

export const HERDR_SENTENCES = {
  'herdr.pane-cap': { en: 'Rarog pane limit reached. Close a session and try again.' },
  'herdr.agent-gone': { en: 'Agent {key} no longer exists in herdr.', args: ['key:text'] },
  'herdr.agent-name-failed': { en: "herdr: couldn't name the agent." },
  'herdr.agent-vanished': { en: 'The `claude` agent disappeared right after starting.' },
  'herdr.agent-vanished.screen': {
    en: 'The `claude` agent disappeared right after starting: {screen}',
    args: ['screen:text'],
  },
  'herdr.argv-effort': { en: '`--effort` has a value outside the list of levels.' },
  'herdr.argv-empty': { en: 'The `claude` argument list is empty. At least `--session-id` is missing.' },
  'herdr.argv-fork-without-resume': { en: '`--fork-session` without `--resume` has nothing to fork.' },
  'herdr.argv-missing-position': { en: "There's no argument at position {position}.", args: ['position:int'] },
  'herdr.argv-model-shape': { en: "`--model` isn't shaped like a model ID." },
  'herdr.argv-no-value.quoted': { en: 'The flag “{flag}” has no value.', args: ['flag:text'] },
  'herdr.argv-not-allowed.by-length': {
    en: "The argument at position {position} (of length {length}) isn't an allowed `claude` flag.",
    args: ['position:int', 'length:int'],
  },
  'herdr.argv-not-allowed.quoted': {
    en: "The argument at position {position} (“{flag}”) isn't an allowed `claude` flag.",
    args: ['position:int', 'flag:text'],
  },
  'herdr.argv-permission-mode': { en: '`--permission-mode` has a value outside the list of modes.' },
  'herdr.argv-repeated.quoted': {
    en: 'The argument “{flag}” is repeated (position {position}).',
    args: ['flag:text', 'position:int'],
  },
  'herdr.argv-resume-same': { en: '`--resume` points to the same session as `--session-id`.' },
  'herdr.argv-resume-shape': { en: "`--resume` isn't shaped like a session ID." },
  'herdr.argv-session-id-shape': { en: "`--session-id` isn't shaped like a session ID." },
  'herdr.argv-ultracode-effort': {
    en: 'Ultracode starts at the `xhigh` level, so any other `--effort` conflicts with it.',
  },
  'herdr.argv-value-charset.quoted': {
    en: "The value of the flag “{flag}” has characters outside the allowed set (arguments go to the pane's shell).",
    args: ['flag:text'],
  },
  'herdr.argv-value-like-flag.quoted': { en: 'The value of the flag “{flag}” looks like a flag.', args: ['flag:text'] },
  'herdr.client-closed': { en: 'The herdr client was closed.' },
  'herdr.closed-without-response': { en: 'herdr closed the connection without responding.' },
  'herdr.connect-timeout': { en: 'Timed out connecting to herdr (2 s).' },
  'herdr.frame-too-long': {
    en: { one: 'A herdr frame is longer than {max} character with no line ending. Protocol error.', other: 'A herdr frame is longer than {max} characters with no line ending. Protocol error.' },
    args: ['max:plural'],
  },
  'herdr.label-control-char': {
    en: 'The label for `{method}` contains a control character.',
    args: ['method:text'],
  },
  'herdr.label-empty': { en: 'The label for `{method}` is empty.', args: ['method:text'] },
  'herdr.launch-off-panels': { en: 'Creating panes from Rarog is turned off (RAROG_HERDR_LAUNCH=0).' },
  'herdr.launch-timeout': {
    en: "The agent didn't report ready within {seconds} s. The pane is still running; check it in herdr.",
    args: ['seconds:int'],
  },
  'herdr.launch-timeout.screen': {
    en: "The agent didn't report ready within {seconds} s. The pane is still running; check it in herdr. Screen: {screen}",
    args: ['seconds:int', 'screen:text'],
  },
  'herdr.method-not-allowed': { en: "The method {method} isn't on the Rarog allow list.", args: ['method:text'] },
  'herdr.pane-id-missing': { en: 'No pane ID for `{method}`.', args: ['method:text'] },
  'herdr.protocol-missing': { en: "herdr didn't provide a protocol number." },
  'herdr.protocol-too-old': {
    en: 'herdr protocol {protocol} is older than the tested {oldest}',
    args: ['protocol:text', 'oldest:text'],
  },
  'herdr.protocol-too-old.disabled': {
    en: 'herdr protocol {protocol} is older than the tested {oldest}. Integration is turned off.',
    args: ['protocol:text', 'oldest:text'],
  },
  'herdr.protocol-unknown': {
    en: 'herdr protocol {protocol} is unknown (tested: {tested}), read-only',
    args: ['protocol:text', 'tested:text'],
  },
  'herdr.response-bad-shape': { en: 'The `{method}` response has an unknown shape.', args: ['method:text'] },
  'herdr.response-foreign-id': {
    en: 'A herdr response with an unexpected ID (expected {expected}). Protocol error.',
    args: ['expected:text'],
  },
  'herdr.response-no-agents': { en: 'The `agent.list` response has no list of agents.' },
  'herdr.response-no-ids': { en: 'The `{method}` response has no tab or pane ID.', args: ['method:text'] },
  'herdr.response-no-pane-rows': {
    en: 'The `pane.list` response has no rows for pane {pane}.',
    args: ['pane:text'],
  },
  'herdr.response-no-panes': { en: 'The `pane.list` response has no list of panes.' },
  'herdr.response-no-result': { en: 'A herdr response with neither a `result` nor an `error` field.' },
  'herdr.response-no-workspaces': { en: 'The `workspace.list` response has no list of workspaces.' },
  'herdr.response-not-json': { en: "herdr replied with something that isn't JSON." },
  'herdr.response-not-object': { en: "herdr replied with a value that isn't an object." },
  'herdr.response-timeout': { en: 'Timed out waiting for a herdr response ({method}).', args: ['method:text'] },
  'herdr.send-off': { en: 'write channel turned off (RAROG_HERDR_SEND=0)' },
  'herdr.session-id-mismatch': {
    en: "herdr reported a different session than the one passed in `--session-id`, so Rarog doesn't know the transcript file.",
  },
  'herdr.socket-error': { en: 'herdr socket error: {reason}', args: ['reason:text'] },
  'herdr.socket-error.unknown': { en: 'herdr socket error: unknown' },
  'herdr.socket-open-failed': { en: "Couldn't open the herdr socket: {reason}", args: ['reason:text'] },
  'herdr.stream-closed': { en: 'herdr closed the stream' },
  'herdr.stream-connect-timeout': { en: 'timed out connecting' },
  'herdr.stream-open-failed': { en: "couldn't open the socket: {reason}", args: ['reason:text'] },
  'herdr.stream-socket-error': { en: 'socket error: {reason}', args: ['reason:text'] },
  'herdr.stream-socket-error.unknown': { en: 'socket error: unknown' },
  'herdr.subscribe-foreign-frame': { en: "herdr didn't confirm the subscription (unexpected first frame)" },
  'herdr.subscribe-refused': { en: 'herdr refused the subscription: {code}', args: ['code:text'] },
  'herdr.subscribe-timeout': { en: "herdr didn't confirm the subscription within 5 s" },
  'herdr.subscription-broken': { en: 'herdr dropped the subscription: {code}', args: ['code:text'] },
  'herdr.tab-id-missing': { en: 'No tab ID for `{method}`.', args: ['method:text'] },
  'herdr.tab-unknown': { en: 'The tab address of this pane is unknown.' },
} as const satisfies SentenceArea;
