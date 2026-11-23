import Foundation
import RarogContract
import RarogTransport
import Testing

// Tolerancja ciała odmowy. Właściciel: łączność.

@Suite("odmowa serwera: nieznany kod i kształt ciała to zdanie, nie awaria")
struct ErrorToleranceTests {
  private func failure(_ body: String, status: Int = 409) async -> TransportError? {
    let harness = MockHarness { _ in .json(status, body) }
    return await #expect(throws: TransportError.self) {
      try await harness.client.decidePermission(sessionId: "s", permId: "p", PermissionDecisionBody(decision: .deny))
    }
  }

  @Test("kod z przyszłości zostaje łańcuchem, zdanie serwera wprost")
  func unknownCode() async {
    let error = await failure(#"{"error":"nowy-kod-z-przyszlosci","message":"Zdanie serwera.","extra":{"a":1}}"#)
    #expect(error == .http(APIFailure(status: 409, code: "nowy-kod-z-przyszlosci", message: "Zdanie serwera.")))
  }

  @Test("ciało spoza ścisłego kształtu: zdanie przeżywa brak kodu i kod nie-łańcuch")
  func lenientShapes() async {
    #expect(await failure(#"{"message":"Bez kodu."}"#) == .http(APIFailure(status: 409, message: "Bez kodu.")))
    #expect(await failure(#"{"error":42,"message":"Kod liczbą."}"#) == .http(APIFailure(status: 409, message: "Kod liczbą.")))
    #expect(await failure(#"{"error":"x","message":"  "}"#) == .http(APIFailure(status: 409, code: "x")), "pusty łańcuch to nie zdanie")
    #expect(await failure(#"{"error":"x","message":null}"#) == .http(APIFailure(status: 409, code: "x")))
    #expect(await failure("<html>bramka</html>", status: 502) == .http(APIFailure(status: 502)))
  }

  // MARK: - Zdanie z kodem: `failure` tłumaczy `message` rendererem klienta (tu `pl`)

  @Test("404 z `messageRef` (złoty plik) → zdanie po polsku; kod zdania spoza rejestru → tekst serwera")
  func translated() async throws {
    let notFound = try goldenRest("error.not-found.json")
    #expect(await failure(notFound, status: 404)
      == .http(APIFailure(status: 404, code: "not-found", message: "Nie ma takiej sesji.")))
    let future = #"{"error":"x","message":"A sentence from the future.","messageRef":{"code":"rest.z-przyszlosci"}}"#
    #expect(await failure(future) == .http(APIFailure(status: 409, code: "x", message: "A sentence from the future.")))
  }

  @Test("`messageRef` null albo uszkodzony: zdanie z `message` bez zmian, kod zostaje, bez wyjątku")
  func brokenRef() async {
    for ref in ["null", #"{"code":""}"#, #"{"code":"rest.session-not-found","args":[1]}"#, #""rest.session-not-found""#,
                #"{"args":[]}"#] {
      let body = #"{"error":"not-found","message":"That session doesn't exist.","messageRef":"# + ref + "}"
      #expect(await failure(body, status: 404)
        == .http(APIFailure(status: 404, code: "not-found", message: "That session doesn't exist.")), "\(ref)")
    }
  }

  @Test("ciało spoza ścisłego kształtu z poprawnym `messageRef`: zdanie i tak po polsku")
  func lenientShapeTranslated() async {
    let body = #"{"error":42,"message":"That session doesn't exist.","messageRef":{"code":"rest.session-not-found"}}"#
    #expect(await failure(body, status: 404) == .http(APIFailure(status: 404, message: "Nie ma takiej sesji.")))
  }
}
