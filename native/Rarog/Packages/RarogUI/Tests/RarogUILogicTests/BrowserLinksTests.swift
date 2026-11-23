import Foundation
@testable import RarogUI
import Testing

// Linki `claude.ai` z treści idą do przeglądarki, nie do apki Claude: adres w atrybucie dostaje
// `#no_universal_links`, wykluczenie z pliku AASA claude.ai. Właściciel: transkrypt.

@Suite("linki claude.ai do przeglądarki")
struct BrowserLinksTests {
  private func outside(_ raw: String) throws -> String {
    BrowserLinks.outside(try #require(URL(string: raw), "\(raw)")).absoluteString
  }

  @Test("https na hoście claude.ai bez fragmentu dostaje #no_universal_links; reszta adresu bez przekodowania")
  func claudeGetsFragment() throws {
    let cases: [(String, String)] = [
      ("https://claude.ai/artifact/AbC123", "https://claude.ai/artifact/AbC123#no_universal_links"),
      ("https://claude.ai/code/artifact/00000000-0000-4000-8000-000000000001",
       "https://claude.ai/code/artifact/00000000-0000-4000-8000-000000000001#no_universal_links"),
      ("https://CLAUDE.AI/artifact/x", "https://CLAUDE.AI/artifact/x#no_universal_links"),
      ("HTTPS://claude.ai/share/x", "HTTPS://claude.ai/share/x#no_universal_links"),
      ("https://claude.ai/artifact/x?x=1", "https://claude.ai/artifact/x?x=1#no_universal_links"),
      ("https://claude.ai", "https://claude.ai#no_universal_links"),
      ("https://claude.ai/a%20b", "https://claude.ai/a%20b#no_universal_links"),
    ]
    for (raw, expected) in cases {
      #expect(try outside(raw) == expected, "\(raw)")
    }
  }

  @Test("bez zmian: istniejący fragment (także pusty #), http, subdomena, inny host, mailto, inna domena")
  func othersUnchanged() throws {
    for raw in [
      "https://claude.ai/artifact/x#sekcja", "https://claude.ai/artifact/x#", "http://claude.ai/artifact/x",
      "https://www.claude.ai/artifact/x", "https://evil.com/claude.ai", "https://claude.ai.evil.com/artifact/x",
      "mailto:a@claude.ai", "https://github.com/anthropics/claude-code",
    ] {
      #expect(try outside(raw) == raw, "\(raw)")
    }
  }

  @Test("karta narzędzia: adres claude.ai w atrybucie z fragmentem, inna domena bez zmian, tekst bit w bit")
  func toolDetail() {
    let text = "Opublikowano https://claude.ai/artifact/AbC123 obok https://github.com/x."
    let attributed = ToolDetailLinks.attributed(text)
    #expect(String(attributed.characters) == text)
    #expect(attributed.runs.compactMap { $0.link?.absoluteString } == [
      "https://claude.ai/artifact/AbC123#no_universal_links", "https://github.com/x",
    ])
    // Wykrywanie adresów zostaje bez fragmentu — dopisuje go dopiero atrybut linku.
    #expect(ToolDetailLinks.urls(in: text).map(\.url.absoluteString) == [
      "https://claude.ai/artifact/AbC123", "https://github.com/x",
    ])
  }

  @Test("strażnik źródeł iOS: wiersz artefaktu i renderer markdownu oddają adres przez BrowserLinks")
  func iosSources() throws {
    // Kod bez komentarzy (`SessionListSourceTests.code`): zdanie w komentarzu nie jest wywołaniem.
    let panel = try SessionListSourceTests.code("Views/Inspector/InspectorPanel.swift")
    #expect(panel.contains("openURL(BrowserLinks.outside(link))"), "wiersz artefaktu (prawy panel)")
    #expect(!panel.contains("openURL(link)"), "adres prosto do systemu")
    let renderer = try SessionListSourceTests.code("Markdown/MarkdownRenderer.swift")
    #expect(renderer.contains("attributes[.link] = BrowserLinks.outside(link)"), "transkrypt, tabela, notatka")
    #expect(!renderer.contains("attributes[.link] = link"), "atrybut bez reguły")
  }
}
