import Foundation
import RarogContract
import RarogTransport

// Zdjęcia z `.rarog-uploads/` sesji do miniatur w transkrypcie. Widok miniatury
// prosi o bajty, magazyn oddaje je z pamięci procesu albo czyta przez transport. Spóźniona
// odpowiedź nie ma prawa wrócić po wylogowaniu ani wylogować NOWEGO zalogowania: odczyty w drodze
// są anulowane przy wylogowaniu, a numer zalogowania odcina ich wyniki (wzorzec `+Usage`).
// Zamknięty ekran anuluje odczyt sam — zadanie widoku przenosi anulowanie na żądanie.
// Właściciel: notki i miniatury.

/// Wynik odczytu zdjęcia do miniatury. Zdania i kafel składa RarogUI.
public enum UploadImageOutcome: Sendable, Equatable {
  case loaded(Data)
  /// 404: zdjęcia już nie ma (sprzątanie po 48 h) albo sesja go nie zna — kafel „Zdjęcie"; ten
  /// sam proces o nie więcej nie pyta.
  case missing
  /// Sieć, limit, odpowiedź spoza obrazka, odmowa — kafel „Zdjęcie"; następne pokazanie pyta znowu.
  case failed
  /// Wylogowanie, odpowiedź sprzed niego albo anulowany widok — nie pokazywać niczego nowego.
  case dropped
}

/// Księgowość zdjęć (pole magazynu `uploadReads`).
struct UploadReads {
  var cache = UploadImageCache()
  /// Zdjęcia, których serwer nie ma (404) — do końca zalogowania.
  var missing: Set<UploadImageKey> = []
  /// Numer zalogowania. Wylogowanie go podbija: wynik i błąd odczytu sprzed niego giną.
  var login = 0
  /// Odczyty w drodze — wylogowanie je anuluje.
  var inFlight: [UUID: Task<Result<Data, TransportError>, Never>] = [:]
}

extension RarogStore {
  /// Numer zalogowania z punktu widzenia zdjęć: pamięć zdekodowanych miniatur w RarogUI należy do
  /// jednego zalogowania i znika razem z bajtami (`forgetUploadReads`).
  public var uploadLogin: Int { uploadReads.login }

  /// Bajty zdjęcia sesji: z pamięci albo `GET …/uploads/<plik>`. Wołający, którego zadanie
  /// zostało anulowane (widok zniknął), anuluje też żądanie.
  public func uploadImage(sessionId: String, file: String) async -> UploadImageOutcome {
    let key = UploadImageKey(sessionId: sessionId, file: file)
    if let data = uploadReads.cache.data(for: key) { return .loaded(data) }
    if uploadReads.missing.contains(key) { return .missing }
    guard state.auth == .loggedIn else { return .dropped }
    let reads = uploadReads.login
    let login = currentLogin
    let transport = transport
    let id = UUID()
    let read = Task<Result<Data, TransportError>, Never> {
      do throws(TransportError) {
        return .success(try await transport.uploadImage(sessionId: sessionId, file: file))
      } catch {
        return .failure(error)
      }
    }
    uploadReads.inFlight[id] = read
    let result = await withTaskCancellationHandler { await read.value } onCancel: { read.cancel() }
    // Odpowiedź sprzed wylogowania nie wraca na ekran ani nie wylogowuje nowego.
    guard reads == uploadReads.login else { return .dropped }
    uploadReads.inFlight[id] = nil
    guard state.auth == .loggedIn else { return .dropped }
    switch result {
    case let .success(data):
      uploadReads.cache.store(data, for: key)
      return .loaded(data)
    case let .failure(.http(failure)) where failure.status == 404:
      uploadReads.missing.insert(key)
      return .missing
    case .failure(.unauthorized):
      handleUnauthorized(since: login)
      return .dropped
    case .failure(.cancelled):
      return .dropped
    case .failure:
      return .failed
    }
  }

  /// Wylogowanie (woła `handleUnauthorized`): odczyty w drodze anulowane, nowy numer zalogowania
  /// odcina ich wyniki, pamięć zdjęć i lista brakujących znikają razem z zalogowaniem.
  func forgetUploadReads() {
    uploadReads.login += 1
    for read in uploadReads.inFlight.values { read.cancel() }
    uploadReads.inFlight = [:]
    uploadReads.cache.removeAll()
    uploadReads.missing = []
  }
}
