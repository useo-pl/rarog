// The order of a listing (`FileEntry.listingOrder`) on the vector the server's comparator is checked on
// (`shared/fixtures/files/listing-order.json`, `shared/test/files-order.test.ts`): the app sorts rows it adds to a
// listing the way the server sorted the listing.
import Foundation
import RarogContract
import RarogContractFixtures
import Testing

@Suite("listing order: the vector shared with the server")
struct FileEntryOrderTests {
  struct Vector: Decodable {
    struct Item: Decodable {
      let name: String
      let kind: String
    }

    let ordered: [Item]
  }

  static let ordered: [FileEntry] = {
    do {
      let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/files/listing-order.json")
      let vector = try JSONDecoder().decode(Vector.self, from: Data(contentsOf: url))
      return vector.ordered.map { item in
        guard let kind = FileEntryKind(rawValue: item.kind) else { fatalError("listing order vector: kind \(item.kind)") }
        return FileEntry(name: item.name, kind: kind)
      }
    } catch {
      fatalError("listing order vector: cannot read it — \(error)")
    }
  }()

  @Test("every entry sorts before every later one and after none")
  func pairs() {
    let entries = Self.ordered
    #expect(entries.count > 1)
    for (index, a) in entries.enumerated() {
      for b in entries[(index + 1)...] {
        #expect(FileEntry.listingOrder(a, b), "\(a.name.debugDescription) before \(b.name.debugDescription)")
        #expect(!FileEntry.listingOrder(b, a), "\(b.name.debugDescription) after \(a.name.debugDescription)")
      }
      #expect(!FileEntry.listingOrder(a, a))
    }
  }

  @Test("a reversed copy sorts back into the vector")
  func reversed() {
    #expect(Self.ordered.reversed().sorted(by: FileEntry.listingOrder) == Self.ordered)
  }
}
