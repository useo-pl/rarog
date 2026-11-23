import Foundation
import RarogContract

// Limity planu i obciążenie Maca w stopce listy. Właściciel: aktywność i lista.
extension RarogClient {
  /// `GET /api/usage` — limity planu Claude. Odczyt, więc bez bramki mutacji i bez `Origin`.
  ///
  /// 503 (`usage-unavailable`) znaczy „serwer nie wie" i przychodzi jako `.http` ze statusem 503:
  /// odróżnia się od braku sieci, bo przy nim liczb nie zgadujemy.
  public func usage() async throws(TransportError) -> PlanUsage {
    let response = try await perform(.get("/api/usage"))
    do {
      return try JSONDecoder().decode(PlanUsage.self, from: response.body)
    } catch {
      throw .invalidResponse("/api/usage: odpowiedź spoza kontraktu (\(error))")
    }
  }

  /// `GET /api/usage/details` — odczyt limitów, który Claude Code zapisuje sam w `~/.claude.json` (arkusz „Limity”
  /// komendy apki `/usage`): 5 h, tydzień i tydzień per model z własną chwilą w `fetchedAt`, ten sam
  /// typ co ``usage()``. `{}` = odczytu nie ma. Odczyt, więc bez bramki mutacji i bez `Origin`.
  ///
  /// Serwer sprzed trasy odpowiada 404: przychodzi jako `.http` ze statusem, a rdzeń czyta go jako „funkcji nie ma”.
  public func usageDetails() async throws(TransportError) -> PlanUsage {
    let response = try await perform(.get("/api/usage/details"))
    do {
      return try JSONDecoder().decode(PlanUsage.self, from: response.body)
    } catch {
      throw .invalidResponse("/api/usage/details: odpowiedź spoza kontraktu (\(error))")
    }
  }

  /// `GET /api/mac` — obciążenie Maca: CPU, RAM i dysk w procentach, brak pola = brak odczytu. Odczyt,
  /// więc bez bramki mutacji i bez `Origin`.
  ///
  /// Starszy serwer nie ma trasy: 404 przychodzi jako `.http` ze statusem 404 i rdzeń czyta go jako „funkcji
  /// nie ma", nie jako awarię.
  public func mac() async throws(TransportError) -> MacLoad {
    let response = try await perform(.get("/api/mac"))
    do {
      return try JSONDecoder().decode(MacLoad.self, from: response.body)
    } catch {
      throw .invalidResponse("/api/mac: odpowiedź spoza kontraktu (\(error))")
    }
  }
}
