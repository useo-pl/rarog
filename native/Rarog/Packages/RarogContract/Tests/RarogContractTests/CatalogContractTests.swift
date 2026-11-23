// Odpowiedzi katalogu projektów i zakładania sesji: ta sama granica tolerancji co reszta
// REST. Złotych odpowiedzi dla tych tras serwer jeszcze nie produkuje (`shared/fixtures/rest/`),
// więc próbki są kształtem z `shared/src/protocol.ts` (`recentProjectsSchema`,
// `createSessionResponseSchema`) i z odpowiedzi serwera demo.
import Foundation
import RarogContract
import Testing

@Suite("kontrakt REST: projekty i nowa sesja")
struct CatalogContractTests {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
  }

  @Test("lista projektów i odpowiedź 202; nieznane klucze odcięte, brak trustPrompt = false")
  func accepted() throws {
    let list = try decode(RecentProjectList.self, #"""
      {"projects":[{"cwd":"/Users/demo/Projects/willow","mtime":"2026-10-04T22:22:43.682Z","nowe":1}]}
      """#)
    #expect(list.projects.first?.cwd == "/Users/demo/Projects/willow")
    let created = try decode(CreateSessionResponse.self, #"{"sessionId":"w0:d4","state":"starting"}"#)
    #expect(created.sessionId == "w0:d4" && !created.trustPrompt)
  }

  @Test("odrzucenia: pusty katalog, null w mtime, brak listy, null w trustPrompt")
  func rejected() {
    let samples: [(String, any Decodable.Type)] = [
      (#"{"projects":[{"cwd":"","mtime":"t"}]}"#, RecentProjectList.self),
      (#"{"projects":[{"cwd":"/x","mtime":null}]}"#, RecentProjectList.self),
      (#"{}"#, RecentProjectList.self),
      (#"{"sessionId":"a","trustPrompt":null}"#, CreateSessionResponse.self),
      (#"{"state":"starting"}"#, CreateSessionResponse.self),
    ]
    for (json, type) in samples {
      #expect(throws: (any Error).self, "\(json)") { _ = try JSONDecoder().decode(type, from: Data(json.utf8)) }
    }
  }
}
