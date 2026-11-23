// Tabela degradacji Swift = klucze `DEGRADATIONS` z `shared/src/decode.ts`.
//
// Skąd klucze TS: z pola `degrades` manifestu złotych ramek, NIE z parsowania `decode.ts`.
// Powód: manifest to JSON (zero heurystyk na składni TS, komentarzach i formatowaniu), a suma
// `degrades` jest RÓWNA kluczom `DEGRADATIONS` z konstrukcji — pilnuje tego test TS
// (`sse-fixtures.test.ts`: „każda pozycja DEGRADATIONS ma ramkę degraded" i „etykieta spoza
// DEGRADATIONS"), który jedzie w tym samym `pnpm run check`. Wartości zapasowe sprawdzają złote
// ramki `degraded` (pole `result`) w `GoldenFramesTests`.
import RarogContract
import RarogContractFixtures
import Testing

@Suite("tabela degradacji: lustro DEGRADATIONS")
struct DegradationTableTests {
  @Test("klucze Swift == klucze DEGRADATIONS (suma `degrades` manifestu)")
  func keysMatchTypeScript() {
    let fromManifest = Set(GoldenFrames.shared.entries.values.flatMap { $0.degrades ?? [] })
    let swift = Set(DegradationKey.allCases.map(\.rawValue))
    #expect(swift.subtracting(fromManifest).sorted() == [], "klucze tylko w Swift")
    #expect(fromManifest.subtracting(swift).sorted() == [], "klucze DEGRADATIONS bez odpowiednika w Swift")
    // 34 = the size of `DEGRADATIONS` today (the last one: who picked up a result, `seenBy`). A new entry in TS = a new
    // one here.
    #expect(swift.count == 34)
  }

  @Test("każda wartość zapasowa daje się zbudować w typie pola")
  func fallbacksFitTheirTypes() {
    let typed: [DegradationKey: (String) -> Bool] = [
      .state: { SessionState(rawValue: $0) != nil },
      .effort: { EffortLevel(rawValue: $0) != nil },
      .herdrMode: { HerdrMode(rawValue: $0) != nil },
      .engine: { Engine(rawValue: $0) != nil },
      .contextSource: { ContextSource(rawValue: $0) != nil },
      .backgroundTasksKind: { BackgroundTaskKind(rawValue: $0) != nil },
      .messageRole: { MessageRole(rawValue: $0) != nil },
      .attachmentsKind: { AttachmentKind(rawValue: $0) != nil },
      .risk: { Risk(rawValue: $0) != nil },
      .permissionResolvedDecision: { PermissionResolution(rawValue: $0) != nil },
      .subject: { DecisionSubject(rawValue: $0) != nil },
      .waitingForSubject: { DecisionSubject(rawValue: $0) != nil },
      .activityDelegation: { Delegation(rawValue: $0) != nil },
      .blockDelegation: { Delegation(rawValue: $0) != nil },
      .optionRole: { OptionRole(rawValue: $0) != nil },
      .noticeKind: { NoticeKind(rawValue: $0) != nil },
      .fileDetailsKind: { GitFileChangeKind(rawValue: $0) != nil },
      .permissionState: { ConsentCardState(rawValue: $0) != nil },
      .permissionUnavailable: { ConsentUnavailableReason(rawValue: $0) != nil },
      .permissionNotes: { ConsentNote(rawValue: $0) != nil },
      // `block.type` → `Block.unsupported` (przypadek enuma, nie łańcuch typu pola).
      .blockType: { $0 == "unsupported" },
    ]
    for key in DegradationKey.allCases {
      guard let fallback = key.fallbackRawValue else {
        #expect(typed[key] == nil, "\(key.rawValue): pole znika, a tabela typów zna wartość")
        continue
      }
      let fits = typed[key]?(fallback) ?? false
      #expect(fits, "\(key.rawValue): „\(fallback)” spoza typu pola")
    }
  }
}
