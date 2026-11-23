import RarogContract

// Wspólna reguła roli efektywnej (`docs/implementation-spec.md` „Effective role rule”):
// notka harnessu przychodzi z `role: user` (stary klient ma ją rozpoznać po swojemu), ale nikt jej
// nie napisał. Kto decyduje o „wypowiedzi człowieka" (echo, ostatni prompt, zwrot tekstu po Esc, głos
// w transkrypcie), pyta tutaj.
// Właściciel: notki i miniatury.
extension TranscriptMessage {
  /// Rola, w której wiadomość występuje w rozmowie: notka harnessu to głos systemu.
  public var effectiveRole: MessageRole { notice == nil ? role : .system }

  /// Wypowiedź człowieka (prompt) — nie notka harnessu ani wiadomość agenta czy serwera.
  public var isHumanPrompt: Bool { effectiveRole == .user }
}
