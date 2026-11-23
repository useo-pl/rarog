/**
 * Publiczne wejście integracji herdr — jedyny import, jakiego potrzebuje manager.
 *
 * Manager składa integrację JEDNĄ funkcją: `createHerdrSupervisor(config, deps)`. Wszystko
 * poniżej niej (gniazdo, allow-listy, bramka protokołu, audit log, tożsamość) jest szczegółem
 * implementacji tej fabryki i nie ma prawa wyciec do `sessions/`.
 *
 * Reeksporty pojedynczych funkcji są tu dla managera i routera, które MUSZĄ ich użyć na swojej
 * ścieżce: `assertSendable` z katalogiem komend sesji + throttle przed przejściem stanu
 * (400/429 wraca na POST, nie do transkryptu) oraz `sessionIdFor` do deterministycznego id sesji.
 */
export {
  createHerdrSupervisor, HERDR_IDLE_GRACE_MS, HERDR_RESYNC_MS, LAUNCH_ADOPT_TIMEOUT_MS,
} from './supervisor.ts';
export type {
  HerdrAttachContext, HerdrDriverFactory, HerdrSupervisorConfig, HerdrSupervisorDeps,
  HerdrSupervisorHandle, HerdrTransport,
} from './supervisor.ts';

export {
  createHerdrClient, createHerdrLaunchClient, normalizeAgentInfo,
  normalizePaneInfo, parseAgentList, parsePaneList,
} from './client.ts';
export type { HerdrRequester } from './client.ts';

export {
  ALLOWED_METHODS, HerdrMethodNotAllowedError, HerdrRemoteError, HerdrUnavailableError,
  MUTATING_METHODS, TESTED_PROTOCOL, createHerdrSocket,
} from './socket.ts';
export type {
  HerdrSocket, HerdrSocketStatus, HerdrStreamEvent, HerdrSubscription, HerdrSubscriptionSpec,
} from './socket.ts';

export { ALLOWED_KEYS, HerdrKeyNotAllowedError, assertAllowedKeys } from './dialogs/send/keys.ts';
export { FORM_SUBMIT_KEY, assertFormSubmitKeys, confirmFormSubmit } from './dialogs/send/form-submit.ts';

export {
  DENIED_PREFIXES, HERDR_SEND_HOURLY_CAP, HERDR_SEND_MIN_INTERVAL_MS, HerdrCommandRefusedError,
  HerdrPromptRejectedError, assertSendable, createCommandCatalogs, createSendThrottle, registryCatalog,
} from './commands/index.ts';
export type {
  CommandCatalog, CommandCatalogs, SendThrottle, SendableOptions, SendableText, SlashCommand,
} from './commands/index.ts';

export { ASK_USER_QUESTION_TOOL, resolveOptions } from './dialogs/screen/resolve.ts';
export { parseOptions } from './dialogs/screen/parse.ts';
export { KNOWN_DIALOGS, matchKnownDialog } from './dialogs/screen/known.ts';
export { OPTION_LABEL_MAX_CHARS, canonicalLabel } from './dialogs/screen/options.ts';
export { MODE_FOOTER_LINES, parseMode } from './dialogs/screen/mode-footer.ts';
export { snippet } from './dialogs/screen/snippet.ts';
export { stripTerminalControl } from './dialogs/screen/text.ts';
export type { DecisionResolution, ExpectedDecision } from './dialogs/screen/resolve.ts';
export type { ScreenDialog } from './dialogs/screen/parse.ts';
export type { KnownDialogId } from './dialogs/screen/known.ts';
export type { ScreenDialogKind } from './dialogs/screen/kinds.ts';
export type { ScreenOption } from './dialogs/screen/options.ts';
export type { HerdrSnippet } from './dialogs/screen/snippet.ts';

export { HERDR_AUDIT_MAX_BYTES, createHerdrAuditLog, herdrAuditPath } from './audit.ts';
export type { HerdrAuditEvent, HerdrAuditLog } from './audit.ts';

export {
  HERDR_ALIAS_LIMIT, HERDR_SEEN_LIMIT, HERDR_SESSION_NAMESPACE, createHiddenStore,
  hiddenStorePath, sessionIdFor, uuidV5,
} from './identity.ts';
export type { HiddenStore, SeenEntry } from './identity.ts';

export * from './types.ts';
