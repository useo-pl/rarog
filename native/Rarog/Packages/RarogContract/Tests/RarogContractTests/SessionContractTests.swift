// Sterowanie żywą sesją i diff: ta sama granica tolerancji co reszta REST. Złote
// odpowiedzi serwer produkuje dziś dla `/restart` i diffa per plik (`RestFixturesTests`); próbki
// tutaj to kształt z `shared/src/protocol.ts` (`modelListSchema`, `sessionModelResponseSchema`,
// `sessionDiffSchema`, `diffFileListSchema`, `diffFilePatchSchema`) i odpowiedzi serwera demo.
import Foundation
import RarogContract
import Testing

@Suite("kontrakt REST: model, tryb, restart i diff sesji")
struct SessionContractTests {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
  }

  private func encode(_ value: some Encodable) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    return String(decoding: try encoder.encode(value), as: UTF8.self)
  }

  @Test("lista modeli: pozycja domyślna konta, poziom effortu spoza apki wypada, obce klucze odcięte")
  func models() throws {
    let list = try decode(ModelList.self, #"""
      {"models":[
        {"value":"","label":"Model domyślny konta","description":"Bez flagi --model.","effortLevels":[]},
        {"value":"opus[1m]","label":"Opus","effortLevels":["low","high","ultra","max"],"nowe":true},
        {"value":"haiku","label":"Haiku","effortLevels":[]}
      ]}
      """#)
    #expect(list.models.map(\.value) == ["", "opus[1m]", "haiku"])
    #expect(list.models[0].description == "Bez flagi --model.")
    #expect(list.models[1].effortLevels == [.low, .high, .max])
    #expect(list.models[2].effortLevels.isEmpty)
    // Ultracode: brak pola = `false`, także u serwera, który pola nie zna.
    #expect(list.models.allSatisfy { !$0.ultracode })
  }

  @Test("lista modeli: `ultracode` czytane przy pozycji, brak = false; false, null i zły typ odrzucają listę")
  func modelsUltracode() throws {
    let list = try decode(ModelList.self, #"""
      {"models":[
        {"value":"opus[1m]","label":"Opus","effortLevels":["xhigh"],"ultracode":true},
        {"value":"haiku","label":"Haiku","effortLevels":[]}
      ]}
      """#)
    #expect(list.models.map(\.ultracode) == [true, false])
    #expect(!ModelChoice(value: "sonnet", label: "Sonnet", effortLevels: [.xhigh]).ultracode)
    #expect(ModelChoice(value: "sonnet", label: "Sonnet", effortLevels: [.xhigh], ultracode: true).ultracode)
    // Literał `true` jak w zod: `false` niczego nie mówi ponad brak pola, więc na drucie go nie ma.
    for broken in [#""ultracode":false"#, #""ultracode":null"#, #""ultracode":"true""#] {
      let json = #"{"models":[{"value":"x","label":"X","effortLevels":[],\#(broken)}]}"#
      #expect(throws: (any Error).self, "\(broken)") {
        _ = try JSONDecoder().decode(ModelList.self, from: Data(json.utf8))
      }
    }
  }

  @Test("202 zmiany modelu niesie ostrzeżenie; diff z literą spoza apki zostaje bez litery")
  func accepted() throws {
    let model = try decode(SessionModelAccepted.self, #"{"ok":true,"warning":"Zmiana leci do panelu."}"#)
    #expect(model.warning == "Zmiana leci do panelu.")
    _ = try decode(OkAck.self, #"{"ok":true}"#)
    let restart = try decode(RestartResponse.self, #"{"sessionId":"demo-willow"}"#)
    #expect(restart.sessionId == "demo-willow")

    let diff = try decode(SessionDiff.self, #"""
      {"files":[{"path":"src/a.ts","status":"M","linesAdded":3,"linesDeleted":1},
                {"path":"b.md","status":"R","linesAdded":0,"linesDeleted":0}],
       "patch":"diff --git a/src/a.ts b/src/a.ts\n","truncated":false}
      """#)
    #expect(diff.files.map(\.status) == [.modified, nil])
    #expect(diff.files[0].linesAdded == 3 && !diff.truncated)
  }

  @Test("diff per plik: litera spoza apki bez litery, liczniki i `binary` opcjonalne, obce klucze odcięte")
  func diffPerFile() throws {
    let list = try decode(DiffFileList.self, #"""
      {"files":[{"path":"src/a.ts","status":"M","linesAdded":3,"linesDeleted":1},
                {"path":"logo.png","status":"M","binary":true},
                {"path":"za ż+%&#.md","status":"A","nowe":1},
                {"path":"b.md","status":"R","linesAdded":0,"linesDeleted":0}],
       "truncated":true,"przyszlePole":[]}
      """#)
    #expect(list.truncated && list.files.map(\.status) == [.modified, .modified, .added, nil])
    #expect(list.files[0] == DiffListEntry(path: "src/a.ts", status: .modified, linesAdded: 3, linesDeleted: 1))
    #expect(list.files[1] == DiffListEntry(path: "logo.png", status: .modified, binary: true))
    #expect(list.files[2] == DiffListEntry(path: "za ż+%&#.md", status: .added))

    let file = try decode(DiffFilePatch.self, #"""
      {"path":"src/a.ts","patch":"diff --git a/src/a.ts b/src/a.ts\n","truncated":false}
      """#)
    #expect(file == DiffFilePatch(path: "src/a.ts", patch: "diff --git a/src/a.ts b/src/a.ts\n", truncated: false))
  }

  @Test("diff per plik odrzuca: binary false, licznik ujemny, ułamkowy i null, brak pól")
  func diffPerFileRejected() {
    let samples: [(String, any Decodable.Type)] = [
      (#"{"files":[{"path":"a","status":"M","binary":false}],"truncated":false}"#, DiffFileList.self),
      (#"{"files":[{"path":"a","status":"M","linesAdded":-1}],"truncated":false}"#, DiffFileList.self),
      (#"{"files":[{"path":"a","status":"M","linesDeleted":1.5}],"truncated":false}"#, DiffFileList.self),
      (#"{"files":[{"path":"a","status":"M","linesAdded":null}],"truncated":false}"#, DiffFileList.self),
      (#"{"files":[{"path":"a"}],"truncated":false}"#, DiffFileList.self),
      (#"{"files":[]}"#, DiffFileList.self),
      (#"{"path":"a","patch":null,"truncated":false}"#, DiffFilePatch.self),
      (#"{"path":"a","patch":"x"}"#, DiffFilePatch.self),
      (#"{"patch":"x","truncated":false}"#, DiffFilePatch.self),
    ]
    for (json, type) in samples {
      #expect(throws: (any Error).self, "\(json)") { _ = try JSONDecoder().decode(type, from: Data(json.utf8)) }
    }
  }

  @Test("odrzucenia: null w opisie, pusta etykieta, brak ostrzeżenia, ok false, null w patchu")
  func rejected() {
    let samples: [(String, any Decodable.Type)] = [
      (#"{"models":[{"value":"x","label":"X","description":null,"effortLevels":[]}]}"#, ModelList.self),
      (#"{"models":[{"value":"x","label":"","effortLevels":[]}]}"#, ModelList.self),
      (#"{"models":[{"value":"x","label":"X"}]}"#, ModelList.self),
      (#"{"ok":true}"#, SessionModelAccepted.self),
      (#"{"ok":false,"warning":"w"}"#, SessionModelAccepted.self),
      (#"{"files":[],"patch":null,"truncated":false}"#, SessionDiff.self),
      (#"{"files":[{"path":"a","status":"M","linesAdded":1.5,"linesDeleted":0}],"patch":"","truncated":false}"#,
       SessionDiff.self),
    ]
    for (json, type) in samples {
      #expect(throws: (any Error).self, "\(json)") { _ = try JSONDecoder().decode(type, from: Data(json.utf8)) }
    }
  }

  @Test("ciała: różnica modelu bez pustych pól, wartownik effortu nie wychodzi, tryb i puste ciało")
  func bodies() throws {
    #expect(try encode(#require(SessionModelBody(model: "opus[1m]", effort: nil))) == #"{"model":"opus[1m]"}"#)
    #expect(try encode(#require(SessionModelBody(model: nil, effort: .xhigh))) == #"{"effort":"xhigh"}"#)
    #expect(SessionModelBody(model: nil, effort: nil) == nil)
    #expect(SessionModelBody(model: nil, effort: .unsupported) == nil)
    // Ultracode: `false` to zmiana (wyłącz), więc samo `false` też jest ciałem.
    #expect(try encode(#require(SessionModelBody(model: nil, effort: nil, ultracode: true))) == #"{"ultracode":true}"#)
    #expect(try encode(#require(SessionModelBody(model: nil, effort: nil, ultracode: false)))
      == #"{"ultracode":false}"#)
    #expect(try encode(#require(SessionModelBody(model: "sonnet", effort: .unsupported, ultracode: false)))
      == #"{"model":"sonnet","ultracode":false}"#)
    #expect(SessionModelBody(model: nil, effort: .unsupported, ultracode: nil) == nil)
    #expect(try encode(SessionModeBody(mode: .plan)) == #"{"mode":"plan"}"#)
    #expect(try encode(EmptyBody()) == "{}")
  }

  @Test("ciało startu: ultracode tylko jako `true`, niezależnie od modelu; wyłączone = brak pola")
  func createBodyUltracode() throws {
    #expect(try encode(CreateSessionBody(cwd: "p", ultracode: true)) == #"{"cwd":"p","ultracode":true}"#)
    #expect(try encode(CreateSessionBody(cwd: "p", model: "opus[1m]", effort: .xhigh, ultracode: true))
      == #"{"cwd":"p","effort":"xhigh","model":"opus[1m]","ultracode":true}"#)
    #expect(try encode(CreateSessionBody(cwd: "p", ultracode: false)) == #"{"cwd":"p"}"#)
    #expect(try encode(CreateSessionBody(cwd: "p")) == #"{"cwd":"p"}"#)
  }
}
