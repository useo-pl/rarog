import Foundation
@testable import RarogCore
import Testing

// Projects pinned in the list tree on this device (`PinnedProjects`): the set, its cap, reading and the
// preference key. The order they give the tree: `ProjectSelectorTests`. Owner: projects and tabs.

@Suite("pinned projects: the set, its cap and the stored record")
struct PinnedProjectsTests {
  @Test("pin and unpin: the path without its trailing slash, setting the same state again reports no change")
  func pinAndUnpin() {
    var pins = PinnedProjects()
    #expect(!pins.contains("/a"))
    let pinned = pins.set("/a/", pinned: true)
    #expect(pinned && pins.contains("/a") && pins.contains("/a/") && pins.cwds == ["/a"])
    let again = pins.set("/a", pinned: true)
    #expect(!again, "pinning a pinned project saves nothing")
    pins.set("/b", pinned: true)
    let empty = pins.set("", pinned: true)
    #expect(!empty && pins.cwds == ["/a", "/b"])
    let absent = pins.set("/x", pinned: false)
    #expect(!absent, "unpinning a project that is not pinned saves nothing")
    let unpinned = pins.set("/a/", pinned: false)
    #expect(unpinned && pins.cwds == ["/b"])
  }

  @Test("the cap drops the earliest pinned directory outside the tree; a pinned project in the tree stays")
  func capacitySparesTreeProjects() {
    var pins = PinnedProjects()
    for cwd in ["/a"] + (1..<PinnedProjects.capacity).map({ "/old\($0)" }) { pins.set(cwd, pinned: true) }
    #expect(pins.cwds.count == PinnedProjects.capacity && pins.cwds.first == "/a")
    let changed = pins.set("/b", pinned: true, present: ["/a/", "/b"])
    #expect(changed && pins.contains("/a"), "the earliest pinned, but standing in the tree")
    #expect(pins.contains("/b") && !pins.contains("/old1"), "the earliest pinned outside the tree went")
    #expect(pins.cwds.count == PinnedProjects.capacity)
  }

  @Test("reading does not know the tree: it keeps a record above the cap and trims only a bloated one")
  func decodingKeepsAboveCapacity() throws {
    func stored(_ count: Int) -> Data {
      Data(#"{"cwds":[\#((0..<count).map { #""/q\#($0)""# }.joined(separator: ","))]}"#.utf8)
    }
    let above = PinnedProjects.capacity + 10
    let kept = try JSONDecoder().decode(PinnedProjects.self, from: stored(above))
    #expect(kept.cwds.count == above && kept.cwds.first == "/q0")
    let limit = PinnedProjects.storedLimit
    let bloated = try JSONDecoder().decode(PinnedProjects.self, from: stored(limit + 50))
    #expect(bloated.cwds.count == limit && bloated.cwds.last == "/q\(limit + 49)")
  }

  @Test("a damaged record means no pins, without a crash; a damaged entry keeps the rest; a saved record reads back")
  func decoding() throws {
    let partial = try JSONDecoder().decode(
      PinnedProjects.self, from: Data(#"{"cwds":["/a",7,null,"",{"x":1},"/b/","/a"]}"#.utf8))
    #expect(partial.cwds == ["/a", "/b"])
    let wrongShape = try JSONDecoder().decode(PinnedProjects.self, from: Data(#"{"cwds":"/a"}"#.utf8))
    #expect(wrongShape.cwds.isEmpty)

    let store = MemoryPreferences()
    store.set(Data("not json".utf8), forKey: NavigationPreferences.pinnedProjects)
    #expect(NavigationPreferences.load(PinnedProjects.self, key: NavigationPreferences.pinnedProjects, from: store)
      == nil)
    NavigationPreferences.save(partial, key: NavigationPreferences.pinnedProjects, to: store)
    #expect(NavigationPreferences.load(PinnedProjects.self, key: NavigationPreferences.pinnedProjects, from: store)
      == partial)
  }

  @Test("pins are paths of one server: the key goes with the other server-scoped preferences")
  func serverScoped() {
    #expect(NavigationPreferences.serverScoped.contains(NavigationPreferences.pinnedProjects))
  }
}
