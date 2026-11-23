import Foundation
@testable import RarogCore
import Testing

// „Wyślij” staje się Stopem: jeden przycisk pola, przy
// pracującej turze i pustym polu przerywa. Właściciel: sterowanie sesją.

@Suite("przycisk pola: „Wyślij” albo Stop")
struct ComposerPrimaryActionTests {
  private let now = Date(timeIntervalSince1970: 1_790_000_000)

  private func action(
    _ availability: InterruptAvailability, draft: Bool = false, attachments: Bool = false,
    dictation: Bool = false, sentAgo: TimeInterval? = nil
  ) -> ComposerPrimaryAction {
    ComposerPrimaryAction.resolve(
      availability: availability, hasDraft: draft, hasAttachments: attachments, dictationActive: dictation,
      sentAt: sentAgo.map { now.addingTimeInterval(-$0) }, now: now)
  }

  @Test("praca i puste pole: Stop; wygaszony, gdy przerwanie by nie doszło; bez tury zawsze „Wyślij”")
  func availability() {
    #expect(action(.enabled) == .stop(enabled: true))
    #expect(action(.disabled) == .stop(enabled: false))
    #expect(action(.hidden) == .send)
  }

  @Test("każdy wpis przywraca „Wyślij”: tekst, załącznik, dyktowanie (także kończenie)")
  func entries() {
    for availability in [InterruptAvailability.enabled, .disabled, .hidden] {
      #expect(action(availability, draft: true) == .send, "tekst w polu")
      #expect(action(availability, attachments: true) == .send, "załącznik w pasku")
      #expect(action(availability, dictation: true) == .send, "dyktowanie trwa")
    }
  }

  @Test("700 ms po wysyłce przycisk zostaje „Wyślij”: podwójny tap nie przerywa świeżej tury")
  func sendGrace() {
    #expect(ComposerPrimaryTiming.sendGrace == 0.7)
    #expect(action(.enabled, sentAgo: 0) == .send, "chwila wysyłki")
    #expect(action(.enabled, sentAgo: 0.69) == .send, "drugi tap w oknie")
    #expect(action(.enabled, sentAgo: 0.7) == .stop(enabled: true), "okno zamknięte")
    #expect(action(.enabled, sentAgo: 5) == .stop(enabled: true))
    #expect(action(.disabled, sentAgo: 0.1) == .send, "okno działa też przy wygaszonym Stopie")
    #expect(action(.enabled, sentAgo: -3) == .stop(enabled: true), "zegar cofnięty nie trzyma „Wyślij” na stałe")
  }

  @Test("chwila do następnego przeliczenia: koniec okna po wysyłce, poza nim nic")
  func nextChange() {
    #expect(ComposerPrimaryAction.graceEnds(sentAt: now.addingTimeInterval(-0.2), now: now)
      == now.addingTimeInterval(0.5))
    #expect(ComposerPrimaryAction.graceEnds(sentAt: now.addingTimeInterval(-0.7), now: now) == nil)
    #expect(ComposerPrimaryAction.graceEnds(sentAt: nil, now: now) == nil)
  }

  @Test("okno po wysyłce otwiera każda wysyłka, która zabrała coś z pola — także same białe znaki")
  func opensGrace() {
    #expect(ComposerPrimaryAction.opensGrace(rawText: "napraw", attachments: 0))
    #expect(ComposerPrimaryAction.opensGrace(rawText: " \n", attachments: 0), "pole czyści się i tak — bez okna drugi tap trafiałby w Stop")
    #expect(ComposerPrimaryAction.opensGrace(rawText: "", attachments: 1), "sam załącznik")
    #expect(!ComposerPrimaryAction.opensGrace(rawText: "", attachments: 0), "tap w pustym polu okna nie odnawia")
  }
}
