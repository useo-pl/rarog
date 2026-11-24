import Foundation
import RarogCore

// What a message field does with the outcome of its send, shared by every field that sends a person's message to a
// session: the sentence under the field (`UICopy.sendResult`), the report of a refused disk write, and the recovery of
// `SendRecovery` (the text and attachments back into the live field, the entry kept in the outbox, or the text into the
// session's draft when the field is gone). Owner: send.

@MainActor
enum MessageSendRecovery {
  /// Recovers the text and attachments of a send that ended with `outcome` and returns the sentence the field shows
  /// under it, or `nil` for none (accepted, empty, or the content went to the outbox or to the draft).
  /// - Parameters:
  ///   - screenAttached: the field that sent stands where the person sees it.
  ///   - restore: puts the text and the attachments back into that field.
  static func recover(
    _ outcome: SendOutcome, raw: String, attachments: [ComposerAttachment], sessionId: String, screenAttached: Bool,
    store: RarogStore, drafts: ComposerDrafts, restore: (String, [ComposerAttachment]) -> Void
  ) -> (text: String, isError: Bool)? {
    let result = UICopy.sendResult(outcome, session: store.state.sessions[sessionId])
    if case let .notPersisted(reason) = outcome {
      store.reportUnhandled("kolejka wysyłki: zapis na dysk nie powiódł się (\(reason.prefix(80)))")
    }
    // Ekran mógł zniknąć w trakcie żądania (inna sesja, wylogowanie po 401): tekst nie trafia do
    // odłączonego pola, a wpis kolejki zostaje, dopóki tekst nie stanie tam, gdzie go widać.
    switch SendRecovery.plan(outcome, screenAttached: screenAttached) {
    case let .restoreToField(discard):
      // Nieudane załączniki na początku paska; dołożone w trakcie wysyłki nie giną.
      restore(raw, attachments)
      // Tekst wrócił do żywego pola — wpis w transkrypcie byłby drugą kopią tej samej wiadomości.
      if let discard { store.discard(discard) }
    case .keepEntry:
      // Odmowa stoi w transkrypcie sesji z treścią i „Ponów"/„Odrzuć" (także po zabiciu apki);
      // kolejka ma własne kopie plików.
      AttachmentStaging.discard(attachments)
      return nil
    case .saveDraft:
      // Półka i szkic same oddają treść ekranowi tej sesji otwartemu w międzyczasie (albo następnemu).
      AttachmentShelf.shared.restore(attachments, for: sessionId)
      drafts.save(raw, note: result.text, for: sessionId)
      return nil
    case .none:
      // Accepted, not confirmed or stopped in the ring: the content lies in the outbox, the shelf does not need its
      // files.
      AttachmentStaging.discard(attachments)
    }
    return result.text.map { ($0, result.isError) }
  }
}
