import Foundation
import RarogContract

// Zdania serwera na wejściu reduktora (`docs/localization.md`, „Server sentences in the app”). Każda ramka SSE
// przechodzi przez renderer RAZ, zanim dotknie stanu: strumień globalny, strumień sesji, replay po kursorze, historia
// z pliku rozmowy i `transcript-snapshot` płyną tą samą pętlą (`StreamSupervisor`). Pola `*Ref` zostają w stanie
// (UI czyta np. `stateDetailRef.args`), a tekst w stanie jest już w języku apki — tak też trafia do pamięci
// podręcznej listy.

extension ServerEvent {
  /// Ramka z polami tekstu po rendererze. Ramki bez zdań serwera wracają bez zmian.
  func translated(_ render: (String, SentenceRef?) -> String) -> ServerEvent {
    switch self {
    case var .sessionsSnapshot(snapshot):
      for index in snapshot.sessions.indices { snapshot.sessions[index].translate(render) }
      snapshot.herdrStatus?.translate(render)
      return .sessionsSnapshot(snapshot)
    case var .sessionChanged(changed):
      changed.session.translate(render)
      return .sessionChanged(changed)
    case var .transcriptSnapshot(snapshot):
      for index in snapshot.messages.indices { snapshot.messages[index].translate(render) }
      for index in snapshot.pendingPermissions.indices { snapshot.pendingPermissions[index].translate(render) }
      for index in snapshot.pendingQuestions.indices { snapshot.pendingQuestions[index].translate(render) }
      return .transcriptSnapshot(snapshot)
    case var .message(event):
      event.message.translate(render)
      return .message(event)
    case var .permissionPending(event):
      event.request.translate(render)
      return .permissionPending(event)
    case var .questionPending(event):
      event.request.translate(render)
      return .questionPending(event)
    case var .state(event):
      event.translate(render)
      return .state(event)
    case var .herdrStatus(event):
      event.translate(render)
      return .herdrStatus(event)
    case .hello, .delta, .activity, .permissionResolved, .permissionSettled, .questionResolved, .gitStatus, .usage,
      .notes:
      return self
    }
  }
}
