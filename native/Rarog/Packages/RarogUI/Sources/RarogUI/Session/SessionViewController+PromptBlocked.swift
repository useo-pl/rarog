#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Notka o prompcie zablokowanym przez hook i „Uruchom ponownie i wyślij”. Restart TEJ jednej sesji
// z ponowną wysyłką zablokowanego promptu robi serwer; ekran trzyma tylko wynik próby (przyjęta albo zdanie
// odmowy) po `id` blokady. Żądanie w drodze to `sessionControls.restarting` rdzenia, wspólne z pigułką „↑”.
// Właściciel: transkrypt.
extension SessionViewController {
  func promptBlockedView(_ model: PromptBlockedRowModel) -> some View {
    PromptBlockedRowView(
      model: model,
      toggleFold: { [weak self] in self?.togglePromptFold(model.id) },
      resend: { [weak self] blocked in self?.resendBlockedPrompt(blocked) })
  }

  /// Jedno tapnięcie: bez uzbrajania, jak „Ponów” wpisu kolejki — bramki stanu liczy serwer i odpowiada zdaniem
  /// przed `/exit`. Drugie tapnięcie w trakcie nic nie wysyła (przycisk wygaszony, rdzeń oddaje `.inFlight`).
  /// Przyjęcie trzyma „Uruchamiam ponownie…”, aż karta zdejmie tę blokadę; odmowa stoi zdaniem pod przyciskiem
  /// i słychać ją pilnie — tylko na tym samym ekranie, który pytał (`announcementScope`, jak odmowy kart).
  func resendBlockedPrompt(_ blocked: SessionPromptBlocked) {
    ui.promptBlocked = PromptBlockedAttempt(id: blocked.id)
    scheduleRender()
    let scope = announcementScope
    Task { @MainActor [weak self] in
      guard let self else { return }
      let outcome = await self.store.restartAndResend(self.sessionId, blocked: blocked)
      let current = self.store.state.sessions[self.sessionId]?.promptBlocked
      guard let result = PromptBlockedNote.result(outcome, blocked: blocked, current: current) else { return }
      self.ui.promptBlocked = result.attempt
      self.scheduleRender()
      if let spoken = result.spoken, self.canAnnounce(in: scope) {
        self.announcer.say(spoken, priority: result.urgent ? .urgent : .normal)
      }
    }
  }
}
#endif
