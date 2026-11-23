// Frozen decoders of the old app, whose contract has no sentence codes. `LegacyDecoderTests` uses them to prove that
// such an app reads responses and frames of a server with sentence codes (fields `*Ref`, `placeholder`,
// `truncation`) without rejections and shows the server text (in English) as it came.
//
// Zasady kopii:
// - Każdy dekoder tej przestrzeni nazw to dosłowna kopia `init(from:)` (albo `decode`) starego typu z
//   `Sources/RarogContract`: te same klucze, te same reguły `ContractContainer`, ten sam kształt enumów
//   (`Block.text(String)`, `TerminalServerFrame.error(message:)`). Kopii NIE poprawia się razem ze źródłami: każda
//   zmiana kontraktu ma właśnie przejść przez ten stary kod.
// - Kopią jest typ, który kody zdań zmieniają, z typami zagnieżdżonymi, które też zmieniają (`Block`, `ToolCallBlock`,
//   `ImageBlock`). Kodowania kopie nie mają: stara apka tych typów nie wysyła.
// - Współdzielone ze źródłami (kody zdań ich nie zmieniają, więc kopia byłaby tym samym kodem):
//   - reguły dekodowania: `ContractContainer`, `contractViolation`, `ContractEnum.wire`, `DegradationKey`,
//     `WireFormat.isImageDataURL`, `WireFormat.isTerminalId`, `PushCrypto.plaintextMaxBytes`;
//   - wyliczenia: `SessionState`, `EffortLevel`, `HerdrMode`, `KnownDialogID`, `RefuseReason`,
//     `CliDialogClass`, `Engine`, `MessageRole`, `DetailKind`, `Delegation`, `InputKind`, `ApnsPushKind`;
//   - bloki podsumowania sesji: `GitFileKinds`, `GitCommit`, `SessionUsage`, `ContextLimitState`, `Activity`,
//     `BackgroundTask`, `SessionArtifact`, `WaitingFor`, `CliUpdate`, `SessionPromptBlocked`;
//   - części wiadomości: `MessageAttachment`, `TranscriptNotice`, `TranscriptPromptBlocked`.
//   Gdy któryś z nich dostanie pole albo regułę kodów zdań, trafia tu jako kopia w tym samym commicie.

/// Przestrzeń nazw zamrożonych typów starej apki (jej `SessionSummary` obok bieżącego).
enum OldApp {}
