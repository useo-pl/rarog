import Foundation

// Zamrożony dekoder wskaźnika przestrzeni apki sprzed pola `identity`.
// `PreIdentitySpaceTests` dowodzi nim, że build wydany bez pola `identity` czyta wskaźnik zapisany nowszym buildem i wchodzi do tej
// samej przestrzeni, więc powrót do starszej wersji apki nie gubi kolejki wysyłki ani szkiców.
//
// Zasady kopii (wzór: `RarogContractTests/Legacy/LegacyContract.swift`):
// - `PreIdentityServerSpace` to kopia `ServerSpace` sprzed pola `identity` (syntezowany `Codable`, pola `origin` i `name`),
//   `PreIdentityServerSpace.Origin` — kopia kodowania `ServerOrigin` (syntezowany `Codable`: `scheme`, `host`, `port`),
//   a `read` — dekoder z `ServerSpaces.readPointer` (nieczytelna treść = `nil`, czyli nowa przestrzeń przy kluczu).
//   Kopii NIE poprawia się razem ze źródłami.
// - Kodowania kopia nie ma: zapis sprawdza się na wyjściu bieżącego kodu magazynu.

/// `ServerSpace` sprzed pola `identity`.
struct PreIdentityServerSpace: Decodable, Equatable {
  /// `ServerOrigin` z tej samej wersji (tylko kodowanie).
  struct Origin: Decodable, Equatable {
    let scheme: String
    let host: String
    let port: Int
  }

  let origin: Origin
  /// Nazwa katalogu w `servers/`.
  let name: String

  /// Odczyt treści wskaźnika tak jak `ServerSpaces.readPointer`.
  static func read(_ data: Data) -> PreIdentityServerSpace? {
    try? JSONDecoder().decode(PreIdentityServerSpace.self, from: data)
  }
}
