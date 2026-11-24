import Foundation
import RarogCore
@testable import RarogUI
import Testing

// Zwinięte projekty drzewa w nawigacji: preferencja TEGO urządzenia,
// zapis tylko przy zmianie, uszkodzony wpis = stan domyślny. Właściciel: projekty i zakładki.

private let willow = "/Users/demo/Projects/willow"

@MainActor
@Suite("nawigacja: zwinięte projekty drzewa")
struct ProjectTreePreferencesTests {
  @Test("zwinięte projekty przeżywają ponowne uruchomienie; bez zapisu nic nie jest zwinięte")
  func preferencesSurviveRestart() {
    let prefs = MemoryPreferences()
    let navigation = RarogNavigation(prefs: prefs)
    #expect(navigation.collapsedProjects.cwds.isEmpty, "nowy projekt rozwinięty")
    let collapsed = navigation.setProjectsCollapsed([willow + "/"], collapsed: true)
    let repeated = navigation.setProjectsCollapsed([willow], collapsed: true)
    #expect(collapsed && !repeated)

    let restarted = RarogNavigation(prefs: prefs)
    #expect(restarted.collapsedProjects.contains(willow))
    let expanded = restarted.setProjectsCollapsed([willow], collapsed: false)
    #expect(expanded)
    let again = RarogNavigation(prefs: prefs)
    #expect(again.collapsedProjects.cwds.isEmpty)
  }

  @Test("sufit pamięci nie rozwija projektu z drzewa; zbiór ponad sufit przeżywa ponowne uruchomienie")
  func capacitySparesTreeProjects() {
    let prefs = MemoryPreferences()
    let navigation = RarogNavigation(prefs: prefs)
    navigation.setProjectsCollapsed([willow] + (1...31).map { "/stary\($0)" }, collapsed: true)
    let tree: Set<String> = [willow, "/Users/demo/Projects/rarog"]
    navigation.setProjectsCollapsed(["/Users/demo/Projects/rarog"], collapsed: true, present: tree)
    #expect(navigation.collapsedProjects.contains(willow), "najdawniej zwinięty, ale stoi w drzewie")
    #expect(!navigation.collapsedProjects.contains("/stary1"))

    let many = (0..<40).map { "/Users/demo/Projects/p\($0)" }
    navigation.setProjectsCollapsed(many, collapsed: true, present: Set(many))
    let restarted = RarogNavigation(prefs: prefs)
    #expect(many.allSatisfy(restarted.collapsedProjects.contains), "po ponownym uruchomieniu nic nie rozwija się samo")
  }

  @Test("a pin survives a new navigation on the same preferences; setting the same state again saves nothing")
  func pinSurvivesRestart() {
    let prefs = MemoryPreferences()
    let navigation = RarogNavigation(prefs: prefs)
    #expect(navigation.pinnedProjects.cwds.isEmpty, "nothing is pinned without a record")
    let pinned = navigation.setProjectPinned(willow + "/", pinned: true)
    let repeated = navigation.setProjectPinned(willow, pinned: true)
    #expect(pinned && !repeated)

    let restarted = RarogNavigation(prefs: prefs)
    #expect(restarted.pinnedProjects.contains(willow))
    let unpinned = restarted.setProjectPinned(willow, pinned: false)
    #expect(unpinned)
    #expect(RarogNavigation(prefs: prefs).pinnedProjects.cwds.isEmpty)
  }

  @Test("a damaged pin record: nothing pinned")
  func brokenPinPreferences() {
    let prefs = MemoryPreferences()
    prefs.set(Data("not json".utf8), forKey: NavigationPreferences.pinnedProjects)
    #expect(RarogNavigation(prefs: prefs).pinnedProjects.cwds.isEmpty)
  }

  @Test("uszkodzony wpis preferencji: wszystkie projekty rozwinięte")
  func brokenPreferences() {
    let prefs = MemoryPreferences()
    prefs.set(Data("nie json".utf8), forKey: NavigationPreferences.collapsedProjects)
    let navigation = RarogNavigation(prefs: prefs)
    #expect(navigation.collapsedProjects.cwds.isEmpty)
  }
}
