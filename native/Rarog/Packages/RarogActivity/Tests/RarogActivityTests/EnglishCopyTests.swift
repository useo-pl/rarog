import Foundation
import RarogContract
@testable import RarogActivity
import Testing

// Angielska kolumna katalogu RarogActivity (`docs/localization.md`, „Plurals”): proces testów zostaje przypięty
// do `pl`, angielski idzie obok przez `L(_:language:)`. Pomiar formy `one` bez liczby: katalog pakietu buduje
// `xcstringstool` (zasób `RarogActivity_RarogActivity.bundle` tego testu), a `liveActivity.spoken.moreWorkflows`
// ma po angielsku `one` „One more workflow” bez `%lld` — zbudowany katalog i formatowanie mają ją przyjąć.
@Suite("katalog copy RarogActivity po angielsku: liczba mnoga, także forma one bez liczby")
struct EnglishCopyTests {
  @Test("forma one bez liczby przechodzi przez build katalogu i formatowanie; other z liczbą")
  func oneWithoutNumber() {
    #expect(L("liveActivity.spoken.moreWorkflows", language: .en, 1) == "One more workflow")
    #expect(L("liveActivity.spoken.moreWorkflows", language: .en, 2) == "2 more workflows")
    #expect(L("liveActivity.spoken.moreWorkflows", language: .en, 21) == "21 more workflows")
    #expect(L("liveActivity.spoken.moreWorkflows", language: .pl, 1) == "Jeszcze 1 workflow", "polski bez wariantów")
    #expect(L("liveActivity.spoken.moreWorkflows", language: .pl, 2) == "Jeszcze 2 workflow")
  }

  @Test("liczba mnoga tam, gdzie polski jej nie ma: +1 workflow, +2 workflows (pogrubienie do pierwszej spacji)")
  func pluralWherePolishHasNone() {
    #expect(L("liveActivity.moreWorkflows", language: .en, 1) == "+1 workflow")
    #expect(L("liveActivity.moreWorkflows", language: .en, 2) == "+2 workflows")
    #expect(L("liveActivity.moreWorkflows", language: .pl, 2) == "+2 workflow")
  }

  @Test("słowo pod liczbą z podstawienia bez %arg: to samo słowo w one i other")
  func wordOnlySubstitution() {
    #expect(L("liveActivity.waitingWord", language: .en, 1) == "waiting")
    #expect(L("liveActivity.waitingWord", language: .en, 3) == "waiting")
  }

  @Test("słowo maszyny po angielsku: linia metryk i zdanie czytnika w wariancie VPS")
  func machineWordEnglish() {
    #expect(L("liveActivity.macLine.vps", language: .en, "CPU 35%") == "VPS  CPU 35%")
    #expect(L("liveActivity.spoken.mac.vps", language: .en, "CPU 35%") == "VPS: CPU 35%")
    #expect(L("liveActivity.spoken.mac", language: .en, "CPU 35%") == "Mac: CPU 35%")
  }

  @Test("stany faz przebiegu po angielsku: słowa stanów ze słownika i zdanie przebiegu ze średnikiem")
  func phaseStatesEnglish() {
    #expect(L("liveActivity.row.phaseStateSpoken.pending", language: .en, 3) == "phase 3 not started yet")
    #expect(L("liveActivity.row.phaseStateSpoken.running", language: .en, 2) == "phase 2 in progress")
    #expect(L("liveActivity.row.phaseStateSpoken.done", language: .en, 1) == "phase 1 finished")
    #expect(
      L("liveActivity.row.spoken.states", language: .en, "rarog", "audit", "phase 2 of 3", "phase 1 finished")
        == "rarog, audit: phase 2 of 3; phase 1 finished")
  }

  @Test("zdanie VoiceOver z liczbą mnogą: czasownik idzie za formą")
  func spokenSentence() {
    #expect(L("liveActivity.spoken.waiting", language: .en, 1) == "Rarog: 1 session is waiting for a decision")
    #expect(L("liveActivity.spoken.waiting", language: .en, 2) == "Rarog: 2 sessions are waiting for a decision")
  }
}
