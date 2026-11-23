import Foundation
@testable import RarogUI
import Testing

// Sentences of models and views come from `UICopy`. This test pins their wording; changing a sentence changes its
// test too.
@Suite("rejestr copy: zdania modeli i widoków mają przypięte brzmienie")
struct CopyRegistryMovesTests {
  @Test("wiersz listy, projekt, wiersz aktywności i nagłówek: czytnik i zegar")
  func listAndActivity() {
    #expect(UICopy.cardWaitClock("4 min") == "czeka od 4 min")
    #expect(UICopy.ordinalSpoken(2) == "numer 2")
    #expect(UICopy.sinceSpoken("2 minut") == "od 2 minut")
    #expect(UICopy.branchSpoken("main") == "gałąź main")
  }

  @Test("karta zgody dla czytnika: nagłówek i blok komendy")
  func permissionCard() {
    #expect(UICopy.permissionPlanSpoken == "Plan do zatwierdzenia")
    #expect(UICopy.permissionToolSpoken("Shell") == "Zgoda na narzędzie Shell")
    #expect(UICopy.permissionRiskySpoken == "ryzykowna")
    #expect(UICopy.permissionDirectorySpoken("~/Projects/willow") == "katalog ~/Projects/willow")
    #expect(UICopy.permissionCommandSpoken("rm -rf dist", plan: false) == "Komenda: rm -rf dist")
    #expect(UICopy.permissionCommandSpoken("1. Zrób to", plan: true) == "Plan: 1. Zrób to")
  }

  @Test("panel limitów, skrót pola wiadomości")
  func usageAndComposer() {
    #expect(UICopy.usageRowSpoken("Tydzień", percent: 64, reset: nil) == "Tydzień: 64 procent")
    #expect(UICopy.usageRowSpoken("Tydzień", percent: 64, reset: "reset 17:20 · za 2 h 44")
      == "Tydzień: 64 procent, reset 17:20 · za 2 h 44")
    #expect(UICopy.newLineCommand == "Nowa linia")
  }
}
