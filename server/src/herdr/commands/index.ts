/**
 * Slash-komendy w Rarogu — publiczne wejście katalogu `server/src/herdr/commands/`.
 *
 * Wszystko, co Rarog wie o komendach Claude Code („/compact", „/clear", skille), mieszka w tym
 * katalogu: allow-lista, strażnik tekstu przed wysyłką, reguła rozpoznania komendy, odkrywanie
 * skilli z dysku i rejestr literałów CLI. Wołający (nadzorca herdr, fasada drivera, manager przez
 * `herdr/index.ts`, import transkryptu, `server/src/index.ts`) biorą stąd gotowe decyzje; katalog nie
 * importuje ani fasady drivera, ani managera.
 *
 * Opis, źródła prawdy i procedura po aktualizacji Claude Code: `docs/slash-commands.md`.
 *
 * Mapa modułów:
 *
 * - `guard.ts` — bramka tekstu przed wysyłką do panelu (`assertSendable`): rozmiar, prefiks `!`,
 *   allow-lista slash-komend z katalogu sesji, tryb panelu, sanityzacja; throttle wysyłek
 *   (`createSendThrottle`).
 * - `shape.ts` — reguła rozpoznania komendy w tekście (`classifySlashText`) i kształt Raroga dla
 *   nazwy komendy, jedna definicja dla strażnika managera i drivera.
 * - `catalog.ts` — migawka katalogu sesji per `(cwd, wersja CLI)` z `revision` (`createCommandCatalogs`,
 *   `registryCatalog`) i lista dla apki z migawki (`commandListOf`, `GET /api/sessions/:id/commands`).
 * - `discover.ts` — skille i komendy z dysku w wąskim, jawnym podzbiorze źródeł CLI.
 * - `transcript.ts` — wpis komendy w pliku rozmowy → wiadomość transkryptu (notka `system` komendy lokalnej
 *   i jej wyniku, wiadomość `user` komendy typu prompt), bezstanowo; tu też rozpoznanie promptu
 *   zablokowanego przez hook `UserPromptSubmit` (część `prompt-blocked`) i treść jego notki.
 * - `registry.ts` — JEDYNE miejsce literałów CLI o komendach: komendy wbudowane, ich aliasy i allow-lista,
 *   wbudowane skille, słowa wyjścia, układ katalogów skilli i pluginów, znaczniki pliku rozmowy; każdy fakt
 *   z dowodem (docs, katalog sondy, pomiar żywy) i jego wersją CLI i datą.
 * - `index.ts` — to wejście.
 */
export {
  DENIED_PREFIXES, HERDR_SEND_HOURLY_CAP, HERDR_SEND_MIN_INTERVAL_MS, HerdrCommandRefusedError,
  HerdrPromptRejectedError, assertSendable, createSendThrottle,
} from './guard.ts';
export type {
  SendSlotOptions, SendThrottle, SendThrottleOptions, SendableOptions, SendableText,
} from './guard.ts';

export { classifySlashText, sameSlash, slashOf } from './shape.ts';
export type { ClassifyDeps, SlashClassification, SlashCommand } from './shape.ts';

export {
  CATALOG_CHECK_MS, CATALOG_RESCAN_MS, buildCatalog, commandListOf, createCommandCatalogs, registryCatalog,
} from './catalog.ts';
export type {
  CatalogCommand, CatalogKind, CatalogSource, CommandCatalog, CommandCatalogs, CommandCatalogsOptions, KnownName,
} from './catalog.ts';

export { discoverCommands } from './discover.ts';
export type { DiscoverResult } from './discover.ts';

export {
  COMMAND_OUTPUT_CLIP, COMMAND_OUTPUT_MAX_BYTES, FileEchoPairing, clipCommandOutput, plainFileEchoOf, promptBlockedField,
  promptBlockedText, silentInTurn, systemEntryNote, userEntryNote,
} from './transcript.ts';
export type {
  CommandEntryResult, CommandNote, CommandNotePart, FileEchoMark, PromptBlock, SystemEntryOptions,
} from './transcript.ts';

export {
  CLI_PLUMBING_TAGS, INTERNAL_SLASH_COMMANDS, TRANSCRIPT_TAGS, ULTRACODE_COMMANDS,
} from './registry.ts';
