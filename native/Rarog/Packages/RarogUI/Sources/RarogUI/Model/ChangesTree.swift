import Foundation
import RarogContract
import RarogCore

// Drzewo sekcji ZMIANY W KATALOGU prawego panelu: katalog stoi raz, nad swoimi plikami,
// zamiast w drugiej linii każdego pliku. Czyste funkcje, testy na macOS. Właściciel: panel.

/// Katalog w drzewie zmian. Łańcuch katalogów z jednym dzieckiem i bez własnych plików jest JEDNYM wierszem
/// (`Sources/RarogUI/Switcher`): w kolumnie 320 pt każdy poziom wcięcia zabiera miejsce nazwie pliku.
public struct ChangesDirectoryRow: Sendable, Equatable {
  /// Pełna ścieżka najgłębszego katalogu łańcucha — klucz zwinięcia.
  public let path: String
  /// Sklejone człony łańcucha.
  public let label: String
  public let depth: Int
  public let collapsed: Bool
  /// Ile plików stoi pod katalogiem, razem z podkatalogami.
  public let files: Int
  /// Sumy liczników plików pod katalogiem; `nil`, gdy żaden plik swojego nie ma („nie wiem", nie zero).
  public let added: Int?
  public let deleted: Int?

  /// „+10 −10" przy ZWINIĘTYM katalogu: ile zmian schowało zwinięcie. `nil` = nie ma czego powiedzieć.
  public var sum: String? { UICopy.inspectorDirectorySum(added: added, deleted: deleted) }

  public var spoken: String { UICopy.inspectorDirectorySpoken(label: label, files: files) }
}

public enum ChangesTreeRow: Sendable, Equatable, Identifiable {
  case directory(ChangesDirectoryRow)
  case file(InspectorFileRow, depth: Int)

  public var id: String {
    switch self {
    case let .directory(row): "dir:\(row.path)"
    case let .file(row, _): "file:\(row.path)"
    }
  }

  public var depth: Int {
    switch self {
    case let .directory(row): row.depth
    case let .file(_, depth): depth
    }
  }
}

public enum ChangesTree {
  /// Wcięcie jednego poziomu (pt).
  public static let indent: Double = 12
  /// Oś pionowej linii poziomu względem jego wcięcia (pt): środek strzałki katalogu.
  public static let guideInset: Double = 5
  /// Odstęp strzałki katalogu od jego nazwy (pt).
  public static let chevronGap: Double = 6
  /// Początek nazwy katalogu względem wcięcia jego poziomu (pt): strzałka (dwie osie) i odstęp.
  public static let labelInset: Double = guideInset * 2 + chevronGap
  /// Litera rodzaju pliku względem wcięcia jego poziomu (pt): stoi w osi NAZWY katalogu, w którym leży plik
  /// (poziom wyżej) — 4 pt od wcięcia.
  public static let letterInset: Double = labelInset - indent
  /// Początek nazwy pliku względem wcięcia jego poziomu (pt): przesunięcie litery go nie rusza.
  public static let nameInset: Double = 20
  /// Wysokość wiersza drzewa przy domyślnym piśmie (pt): odstęp między liniami o połowę mniejszy niż przy 36 pt.
  public static let rowHeight: Double = 26

  /// Wiersze drzewa od góry: w katalogu najpierw podkatalogi, potem pliki, jedno i drugie w kolejności serwera
  /// (`git status` daje ścieżki posortowane). Dzieci zwiniętego katalogu (`collapsed`: ścieżki) nie mają wierszy.
  public static func rows(_ files: [InspectorFileRow], collapsed: Set<String>) -> [ChangesTreeRow] {
    let root = Node(name: "", path: "")
    for file in files {
      var node = root
      // Ostatni człon to plik (albo nieśledzony katalog z ukośnikiem na końcu) — liść, nie poziom. Poziomy idą ze
      // ścieżki BEZ cytowania gita: `"src/\305\274.swift"` należy do `src`, nie do katalogu `"src`.
      for part in file.plain.split(separator: "/").dropLast() {
        node = node.child(String(part))
      }
      node.files.append(file)
    }
    var out: [ChangesTreeRow] = []
    walk(root, depth: 0, collapsed: collapsed, into: &out)
    return out
  }

  private static func walk(_ node: Node, depth: Int, collapsed: Set<String>, into out: inout [ChangesTreeRow]) {
    for child in node.dirs {
      var dir = child
      var label = child.name
      // Sklejanie staje na katalogu, który człowiek zwinął: gdy rozgałęziony katalog po kolejnej ramce gita ma
      // już jedno dziecko, zostaje zwinięty pod własną ścieżką, a nie rozwija się jako dłuższy łańcuch.
      while dir.files.isEmpty, dir.dirs.count == 1, !collapsed.contains(dir.path) {
        dir = dir.dirs[0]
        label += "/" + dir.name
      }
      let shut = collapsed.contains(dir.path)
      let total = total(dir)
      out.append(.directory(ChangesDirectoryRow(
        path: dir.path, label: label, depth: depth, collapsed: shut, files: total.files, added: total.added,
        deleted: total.deleted)))
      if !shut { walk(dir, depth: depth + 1, collapsed: collapsed, into: &out) }
    }
    for file in node.files {
      out.append(.file(file, depth: depth))
    }
  }

  private static func total(_ node: Node) -> (files: Int, added: Int?, deleted: Int?) {
    var files = node.files.count
    var added = sum(node.files.map(\.added))
    var deleted = sum(node.files.map(\.deleted))
    for dir in node.dirs {
      let inner = total(dir)
      files += inner.files
      added = sum([added, inner.added])
      deleted = sum([deleted, inner.deleted])
    }
    return (files, added, deleted)
  }

  /// Suma znanych liczników; same „nie wiem" dają „nie wiem".
  private static func sum(_ values: [Int?]) -> Int? {
    let known = values.compactMap { $0 }
    return known.isEmpty ? nil : known.reduce(0, +)
  }

  /// Katalog podczas składania drzewa: podkatalogi w kolejności pierwszego wystąpienia.
  private final class Node {
    let name: String
    let path: String
    var dirs: [Node] = []
    var files: [InspectorFileRow] = []
    private var index: [String: Int] = [:]

    init(name: String, path: String) {
      self.name = name
      self.path = path
    }

    func child(_ name: String) -> Node {
      if let at = index[name] { return dirs[at] }
      let node = Node(name: name, path: path.isEmpty ? name : "\(path)/\(name)")
      index[name] = dirs.count
      dirs.append(node)
      return node
    }
  }
}
