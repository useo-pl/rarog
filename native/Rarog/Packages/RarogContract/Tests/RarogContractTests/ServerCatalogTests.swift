// Katalog zdań serwera w RarogContract (`Copy/Localizable.xcstrings`, wyjście `scripts/sentences-catalog.mjs`):
// Foundation formatuje z wygenerowanego katalogu zdanie z argumentem pozycyjnym i liczbę mnogą w podstawieniu
// (`%1$#@cut@`) w obu językach, a deskryptory obejmują każdy klucz `server.*`. Zgodność katalogu z rejestrem
// pilnuje lustro `shared/test/sentences-catalog-lustro.test.ts`; tu sprawdzamy, że zbudowany zasób działa.
import Foundation
import RarogContract
import Testing

@Suite("katalog zdań serwera: Foundation formatuje wygenerowany katalog")
struct ServerCatalogTests {
  /// Zasób celu `RarogContract` (`RarogContract_RarogContract.bundle`). `Bundle.module` pakietu jest wewnętrzny,
  /// a testy mają swój, więc szukamy pakietu zasobów obok zasobów testów (układ `swift build` i `xcodebuild`).
  static let bundle: Bundle? = {
    let name = "RarogContract_RarogContract.bundle"
    let places = [Bundle.module.bundleURL.deletingLastPathComponent(), Bundle.main.bundleURL,
                  Bundle.main.resourceURL, Bundle.main.bundleURL.deletingLastPathComponent()]
    return places.compactMap { $0 }.lazy.compactMap { Bundle(url: $0.appendingPathComponent(name)) }.first
  }()

  static func text(_ key: String, _ language: CopyLanguage, _ arguments: CVarArg...) throws -> String {
    let bundle = try #require(Self.bundle, "brak zasobu RarogContract_RarogContract.bundle")
    return CopyLookup.string(key, bundle: bundle, language: language, arguments: arguments)
  }

  @Test("zasób ma en i pl")
  func localizations() throws {
    let bundle = try #require(Self.bundle)
    #expect(Set(bundle.localizations).isSuperset(of: ["en", "pl"]), "\(bundle.localizations)")
  }

  @Test(
    "polska liczba mnoga stopki ucięcia: znak, znaki, znaków",
    arguments: [(1, "znak"), (2, "znaki"), (5, "znaków"), (22, "znaki"), (101, "znaków")])
  func polishFooter(count: Int, word: String) throws {
    #expect(try Self.text("server.transcript.truncation-footer", .pl, count) == "\n… (ucięto \(count) \(word))")
  }

  @Test("angielska liczba mnoga stopki ucięcia: character, characters", arguments: [(1, "character"), (2, "characters")])
  func englishFooter(count: Int, word: String) throws {
    #expect(try Self.text("server.transcript.truncation-footer", .en, count) == "\n… (\(count) \(word) cut off)")
  }

  @Test("zdanie z argumentem int i bez argumentów, klucz push bez prefiksu")
  func plainSentences() throws {
    #expect(try Self.text("server.session.fallback-label", .pl, Int64(3)) == "sesja 3")
    #expect(try Self.text("server.session.fallback-label", .en, Int64(3)) == "session 3")
    #expect(try Self.text("server.rest.bad-request", .pl) == "Żądanie odrzucone.")
    #expect(try Self.text("server.rest.bad-request", .en) == "Request rejected.")
    #expect(try Self.text("push.chime.title", .pl) == "Agent skończył")
  }

  @Test("deskryptory: każdy kod ma deskryptor z rodzajami w kolejności ref.args")
  func descriptors() {
    #expect(SentenceDescriptors.table["transcript.truncation-footer"]?.args == [.plural])
    #expect(SentenceDescriptors.table["transcript.truncation-footer"]?.retired == false)
    #expect(SentenceDescriptors.table["state.limit-reached"]?.args == [.instant])
    #expect(SentenceDescriptors.table["rest.bad-request"]?.args == [])
    #expect(SentenceDescriptors.table.count >= 44)
  }
}
