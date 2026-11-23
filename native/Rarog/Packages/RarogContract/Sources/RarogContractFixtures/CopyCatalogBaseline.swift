import Foundation

/// Baseline snapshot of the copy registry literals (`docs/localization.md`, "Proof: Polish unchanged"): for every
/// catalog key of a package, the literal the Swift registry held in code, with `⟪i⟫` placeholders for arguments, and
/// the argument kinds (`s` — text, `i` — number). The move tool printed the snapshot straight from the Swift sources,
/// not from the catalog.
///
/// Test pakietu wstawia te same próbne argumenty (liczba `12345 + 11·i`, tekst `⟦i⟧`) do wzorca i do funkcji `L`
/// pakietu: różnica znaczy, że katalog albo wyszukanie zmieniły polskie zdanie (zły znak `%`, specyfikator,
/// twarda spacja, znak ucieczki, brak klucza w zbudowanym zasobie, liczba pogrupowana według języka — literał
/// w kodzie interpolował liczby bez grupowania, a `String(format:locale:)` z `pl` grupuje od 10 000). Every snapshot
/// key must stand in the catalog: a key that goes away or changes its sentence (a plural, say) leaves the snapshot
/// on purpose. A key added later has no snapshot entry; `l10n-check` checks it.
public enum CopyCatalogBaseline {
  /// Różnice zrzutu `fixture` (`{"klucz": ["wzorzec", "rodzaje"]}`) z katalogiem źródłowym `catalog` (`.xcstrings`)
  /// i wynikiem `lookup` (funkcja `L` pakietu w języku `pl` z próbnymi argumentami). Pusta lista = zgodne.
  public static func mismatches(
    fixture: URL, catalog: URL, lookup: (String, [CVarArg]) -> String
  ) throws -> [String] {
    let entries = try JSONDecoder().decode([String: [String]].self, from: Data(contentsOf: fixture))
    let source = try JSONSerialization.jsonObject(with: Data(contentsOf: catalog)) as? [String: Any]
    let keys = Set((source?["strings"] as? [String: Any] ?? [:]).keys)
    var out: [String] = []
    for key in Set(entries.keys).subtracting(keys).sorted() { out.append("\(key): jest w zrzucie, nie ma go w katalogu") }
    for (key, entry) in entries.sorted(by: { $0.key < $1.key }) where keys.contains(key) {
      guard let template = entry.first else {
        out.append("\(key): wpis zrzutu bez wzorca")
        continue
      }
      var expected = template
      var arguments: [CVarArg] = []
      for (index, kind) in (entry.count > 1 ? entry[1] : "").enumerated() {
        let sample: String
        if kind == "i" {
          let number = 12_345 + 11 * index
          arguments.append(number)
          sample = String(number)
        } else {
          sample = "⟦\(index)⟧"
          arguments.append(sample)
        }
        expected = expected.replacingOccurrences(of: "⟪\(index)⟫", with: sample)
      }
      let actual = lookup(key, arguments)
      if actual != expected {
        out.append("\(key): oczekiwano \(String(reflecting: expected)), jest \(String(reflecting: actual))")
      }
    }
    return out
  }
}
