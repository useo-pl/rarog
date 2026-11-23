import Foundation
@testable import RarogCore
import Testing

// Pamięć drzewa projektów po stronie urządzenia: zwinięte projekty i układ listy
// w preferencjach. Właściciel: projekty i zakładki.

@Suite("pamięć drzewa: zwinięte projekty i układ listy")
struct ProjectTreeMemoryTests {
  @Test("zwinięcie i rozwinięcie: ścieżka bez ukośnika, powtórka bez zmiany, „Zwiń/Rozwiń wszystkie” jednym krokiem")
  func collapse() {
    var memory = CollapsedProjects()
    #expect(!memory.contains("/a"), "projekt spoza zbioru jest rozwinięty")
    let first = memory.set(["/a/"], collapsed: true)
    #expect(first && memory.contains("/a") && memory.contains("/a/") && memory.cwds == ["/a"])
    let repeated = memory.set(["/a"], collapsed: true)
    #expect(!repeated, "ponowne zwinięcie nic nie zapisuje")
    let all = memory.set(["/b", "/c", "", "/a"], collapsed: true)
    #expect(all && memory.cwds == ["/a", "/b", "/c"], "kolejność zwinięcia, bez pustych")
    let absent = memory.set(["/x"], collapsed: false)
    #expect(!absent)
    let expanded = memory.set(["/a", "/c"], collapsed: false)
    #expect(expanded && memory.cwds == ["/b"])
  }

  @Test("sufit 32 dotyczy historii: wypada najdawniej zwinięty katalog spoza drzewa")
  func capacity() throws {
    var memory = CollapsedProjects()
    memory.set((0..<40).map { "/p\($0)" }, collapsed: true)
    #expect(memory.cwds.count == CollapsedProjects.capacity)
    #expect(memory.cwds.first == "/p8" && memory.cwds.last == "/p39", "bez drzewa: najdawniej zwinięte")
  }

  @Test("sufit nie rozwija projektu, który stoi w drzewie: 32 wpisy, zwinięcie B przy widocznym A")
  func capacitySparesTreeProjects() {
    var memory = CollapsedProjects()
    memory.set(["/a"] + (1...31).map { "/stary\($0)" }, collapsed: true)
    #expect(memory.cwds.count == CollapsedProjects.capacity && memory.cwds.first == "/a")
    let changed = memory.set(["/b"], collapsed: true, present: ["/a", "/b/"])
    #expect(changed && memory.contains("/a"), "A w drzewie zostaje zwinięty")
    #expect(memory.contains("/b") && !memory.contains("/stary1"), "wypadł najdawniejszy spoza drzewa")
    #expect(memory.cwds.count == CollapsedProjects.capacity)
  }

  @Test("„Zwiń wszystkie” przy ponad 32 projektach w drzewie: zwinięte zostają wszystkie, historia ustępuje pierwsza")
  func collapseAllAboveCapacity() {
    var memory = CollapsedProjects()
    memory.set(["/historia"], collapsed: true)
    let tree = (0..<40).map { "/t\($0)" }
    memory.set(tree, collapsed: true, present: Set(tree))
    #expect(tree.allSatisfy(memory.contains), "żaden projekt drzewa nie rozwinął się sam")
    #expect(!memory.contains("/historia"), "katalog spoza drzewa ustąpił")
    #expect(memory.cwds.count == 40, "ponad sufit tylko projekty drzewa")
    // Drzewo się kurczy (sesje zamknięte): następny gest przycina zbiór do sufitu, oszczędzając obecne.
    memory.set(["/t39"], collapsed: false, present: Set(tree.prefix(5)))
    #expect(memory.cwds.count == CollapsedProjects.capacity)
    #expect(tree.prefix(5).allSatisfy(memory.contains))
  }

  @Test("odczyt z dysku nie zna drzewa: trzyma zapis ponad sufit historii, tnie dopiero rozdęty")
  func decodingKeepsAboveCapacity() throws {
    func stored(_ count: Int) -> Data {
      Data(#"{"cwds":[\#((0..<count).map { #""/q\#($0)""# }.joined(separator: ","))]}"#.utf8)
    }
    let forty = try JSONDecoder().decode(CollapsedProjects.self, from: stored(40))
    #expect(forty.cwds.count == 40 && forty.cwds.first == "/q0", "projekty drzewa zwinięte ponad sufit przeżywają start")
    let bloated = try JSONDecoder().decode(CollapsedProjects.self, from: stored(200))
    #expect(bloated.cwds.count == CollapsedProjects.storedLimit && bloated.cwds.last == "/q199")
  }

  @Test("odczyt: uszkodzony wpis nie rozwija reszty; uszkodzony zapis = wszystko rozwinięte; zapis wraca bez zmian")
  func decoding() throws {
    let partial = try JSONDecoder().decode(
      CollapsedProjects.self, from: Data(#"{"cwds":["/a",7,null,"",{"x":1},"/b/","/a"]}"#.utf8))
    #expect(partial.cwds == ["/a", "/b"])
    let wrongShape = try JSONDecoder().decode(CollapsedProjects.self, from: Data(#"{"cwds":"/a"}"#.utf8))
    #expect(wrongShape.cwds.isEmpty)

    let store = MemoryPreferences()
    store.set(Data("nie json".utf8), forKey: NavigationPreferences.collapsedProjects)
    #expect(NavigationPreferences.load(CollapsedProjects.self, key: NavigationPreferences.collapsedProjects, from: store)
      == nil)
    NavigationPreferences.save(partial, key: NavigationPreferences.collapsedProjects, to: store)
    #expect(NavigationPreferences.load(CollapsedProjects.self, key: NavigationPreferences.collapsedProjects, from: store)
      == partial)
  }
}
