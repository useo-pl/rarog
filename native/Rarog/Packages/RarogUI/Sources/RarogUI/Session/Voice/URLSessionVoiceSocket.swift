import Foundation

/// Gniazdo WebSocket do Soniox na `URLSessionWebSocketTask`. Właściciel: dyktowanie.
///
/// Osobna, efemeryczna sesja URL bez cookie i bez pamięci podręcznej: strumień idzie do strony
/// trzeciej (Soniox w UE), więc nic z Raroga (klucz urządzenia, `Origin`) nie ma prawa z nim
/// pojechać. Delegat i odbiór biegną na głównej kolejce, w kolejności przyjścia; po `close()`
/// żadne zdarzenie nie wychodzi.
@MainActor
final class URLSessionVoiceSocket: VoiceSocket {
  private let session: URLSession
  private let task: URLSessionWebSocketTask
  private let events: VoiceSocketEvents
  private var closed = false

  init(url: URL, protocols: [String], events: VoiceSocketEvents) {
    self.events = events
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCache = nil
    configuration.waitsForConnectivity = false
    let delegate = SocketDelegate()
    session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: .main)
    // Bez protokołów — zwykłe zadanie, bez pustego nagłówka `Sec-WebSocket-Protocol`.
    task = protocols.isEmpty ? session.webSocketTask(with: url) : session.webSocketTask(with: url, protocols: protocols)
    delegate.opened = { [weak self] in self?.opened() }
    delegate.ended = { [weak self] in self?.ended() }
    task.resume()
  }

  static let factory: VoiceSocketFactory = { url, protocols, events in
    URLSessionVoiceSocket(url: url, protocols: protocols, events: events)
  }

  func send(text: String) {
    guard !closed else { return }
    task.send(.string(text)) { _ in }
  }

  func send(data: Data) {
    guard !closed else { return }
    task.send(.data(data)) { _ in }
  }

  func close() {
    guard !closed else { return }
    closed = true
    task.cancel(with: .normalClosure, reason: nil)
    // Sesja trzyma delegata — bez unieważnienia żyłaby do końca procesu.
    session.invalidateAndCancel()
  }

  private func opened() {
    guard !closed else { return }
    events.opened()
    receive()
  }

  /// Odbiór po jednej wiadomości: następną prosimy dopiero po obsłużeniu poprzedniej, więc kolejność
  /// jest zachowana bez względu na to, na jakiej kolejce przyjdzie odpowiedź.
  private func receive() {
    task.receive { [weak self] result in
      let text: String?
      switch result {
      case let .success(.string(value)): text = value
      case let .success(.data(data)): text = String(data: data, encoding: .utf8)
      case .success: text = nil
      case .failure: text = nil
      }
      let failed = if case .failure = result { true } else { false }
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self, !self.closed else { return }
          if failed {
            self.ended()
            return
          }
          if let text { self.events.message(text) }
          self.receive()
        }
      }
    }
  }

  private func ended() {
    guard !closed else { return }
    closed = true
    session.invalidateAndCancel()
    events.closed()
  }
}

/// Delegat sesji URL. Kolejka delegata to kolejka główna (`delegateQueue: .main`), więc callbacki
/// biegną na głównym wątku i wolno w nich wejść w izolację głównego aktora.
private final class SocketDelegate: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
  // Ustawiane raz przed `resume()`, czytane wyłącznie na głównej kolejce.
  var opened: (@MainActor () -> Void)?
  var ended: (@MainActor () -> Void)?

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    MainActor.assumeIsolated { opened?() }
  }

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    MainActor.assumeIsolated { ended?() }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
    MainActor.assumeIsolated { ended?() }
  }
}
