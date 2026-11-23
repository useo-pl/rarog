import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Branches of the copy registry: new session, pairing, projects. Each test pins the part of the sentence chosen by
// data or a condition, not the wording around it. Polish is the test language of the package
// (`RAROG_COPY_LANGUAGE=pl`).
@Suite("copy branches: new session, pairing, projects")
struct UICopyBranchesPairingTests {
  /// 22 Oct 2025, 12:00:00 UTC.
  static let now = Date(timeIntervalSince1970: 1_761_134_400)
  static let zone = TimeZone(identifier: "Europe/Warsaw")!

  /// ISO time with milliseconds, `seconds` before `now` (negative = after).
  static func iso(_ seconds: TimeInterval) -> String {
    now.addingTimeInterval(-seconds).formatted(.iso8601.year().month().day().time(includingFractionalSeconds: true))
  }

  /// A conversation to resume, as the server lists it.
  static func resumable(mtime: String, branch: String? = nil, live: Bool = false) -> ResumableSession {
    var fields = [
      #""engineSessionId":"e1""#, #""cwd":"/Users/demo/Projects/willow""#, #""mtime":"\#(mtime)""#,
      #""firstPrompt":"⟦prompt⟧""#, #""liveInHerdr":\#(live)"#,
    ]
    if let branch { fields.append(#""gitBranch":"\#(branch)""#) }
    return Sample.decode(ResumableSession.self, "{\(fields.joined(separator: ","))}")
  }

  // MARK: New session

  @Test("launch message: the server sentence, else the fallback; a block detail is trimmed; success is silent")
  func launchMessageBranches() {
    #expect(UICopy.launchMessage(.cwdRefused(nil), fallback: "⟦fallback⟧") == "⟦fallback⟧")
    #expect(UICopy.launchMessage(.cwdRefused("⟦message⟧"), fallback: "") == "⟦message⟧")
    #expect(UICopy.launchMessage(.blocked(" ⟦detail⟧ "), fallback: "") == "⟦detail⟧")
    let blank = UICopy.launchMessage(.blocked("  "), fallback: "")
    #expect(blank == UICopy.launchMessage(.blocked(nil), fallback: ""))
    #expect(blank?.isEmpty == false)
    #expect(UICopy.launchMessage(.created(sessionId: "s", trustPrompt: true), fallback: "") == nil)
  }

  @Test("directory refusal without a server sentence falls back to the general one")
  func directoryRefusedWithoutMessage() {
    #expect(UICopy.directoryError(.refused(nil)) == UICopy.directoryError(.failed))
  }

  @Test("project for the screen reader: the context line joins only when present")
  func projectSpokenContext() {
    #expect(UICopy.projectSpoken(name: "⟦name⟧", path: "⟦path⟧", context: nil) == "⟦name⟧, ⟦path⟧")
    #expect(UICopy.projectSpoken(name: "⟦name⟧", path: "⟦path⟧", context: "⟦context⟧") == "⟦name⟧, ⟦path⟧, ⟦context⟧")
  }

  @Test("resume row metadata: age in words, a future time reads as zero seconds")
  func resumeMetaAge() {
    #expect(UICopy.resumeMetaSpoken(Self.resumable(mtime: Self.iso(2)), now: Self.now) == "ostatnio 2 sekundy temu")
    #expect(UICopy.resumeMetaSpoken(Self.resumable(mtime: Self.iso(-60)), now: Self.now) == "ostatnio 0 sekund temu")
    // Days truncate: 36 hours read as the same one day as 24 hours.
    let day = UICopy.resumeMetaSpoken(Self.resumable(mtime: Self.iso(24 * 3600)), now: Self.now)
    #expect(UICopy.resumeMetaSpoken(Self.resumable(mtime: Self.iso(36 * 3600)), now: Self.now) == day)
    #expect(UICopy.resumeMetaSpoken(Self.resumable(mtime: Self.iso(48 * 3600)), now: Self.now) != day)
  }

  @Test("resume row metadata: branch only when not empty, open-in-herdr joined with commas")
  func resumeMetaBranchAndLive() {
    let full = UICopy.resumeMetaSpoken(Self.resumable(mtime: "garbage", branch: "fix/zapis", live: true), now: Self.now)
    #expect(full == "czas ostatniej zmiany nieznany, gałąź fix/zapis, otwarta w herdr, można ją otworzyć albo rozwidlić")
    let emptyBranch = UICopy.resumeMetaSpoken(Self.resumable(mtime: "garbage", branch: "", live: true), now: Self.now)
    #expect(emptyBranch == "czas ostatniej zmiany nieznany, otwarta w herdr, można ją otworzyć albo rozwidlić")
    let noBranch = UICopy.resumeMetaSpoken(Self.resumable(mtime: Self.iso(300), branch: "", live: false), now: Self.now)
    #expect(noBranch == "ostatnio 5 minut temu")
    let live = UICopy.resumeMetaSpoken(Self.resumable(mtime: Self.iso(300), branch: nil, live: true), now: Self.now)
    #expect(live == "ostatnio 5 minut temu, otwarta w herdr, można ją otworzyć albo rozwidlić")
  }

  // MARK: Pairing

  @Test("pairing refusal: a failure shows the server sentence, a 403 without one the general body")
  func pairFailureServerSentence() {
    #expect(UICopy.pairFailure(.failed("⟦message⟧")) == "⟦message⟧")
    #expect(UICopy.pairFailure(.forbidden(nil)) == UICopy.forbiddenBody)
  }

  @Test("rate limit: seconds only when the server gives more than zero")
  func pairRateLimitedBoundary() {
    let zero = UICopy.pairRateLimited(retryAfter: 0)
    #expect(zero == UICopy.pairRateLimited(retryAfter: nil))
    #expect(!zero.contains("\u{00A0}s"))
    #expect(UICopy.pairFailure(.rateLimited(retryAfter: 0)) == zero)
    #expect(UICopy.pairRateLimited(retryAfter: 1).hasSuffix("1\u{00A0}s."))
  }

  @Test("code failure: an old server has its own sentence, the rest reads as a pairing failure")
  func pairCodeFailureBranches() {
    #expect(UICopy.pairCodeFailure(.serverTooOld) != UICopy.pairFailure(.serverTooOld))
    #expect(UICopy.pairCodeFailure(.serverTooOld).contains("zaktualizuj serwer"))
    #expect(UICopy.pairCodeFailure(.offline) == UICopy.pairFailure(.offline))
  }

  @Test("new device notice: the date when parsable, the server machine names where the code came from")
  func newDeviceNoticeBranches() {
    let dated = NewDeviceNotice(
      id: "d2", label: "iPad·Rarog", createdAt: "2025-10-04T08:01:00.000Z", creator: "admin", creatorIsAdmin: true)
    let mac = UICopy.newDeviceNotice(dated, .mac, timeZone: Self.zone)
    #expect(mac.hasPrefix("Nowe urządzenie: iPad·Rarog, 4 paź 10:01, kod z Maca."))
    #expect(mac.contains("na Macu"))
    let vps = UICopy.newDeviceNotice(dated, .vps, timeZone: Self.zone)
    #expect(vps.hasPrefix("Nowe urządzenie: iPad·Rarog, 4 paź 10:01, kod z VPS-a."))
    #expect(vps.contains("na VPS-ie"))
    let undated = NewDeviceNotice(
      id: "d2", label: "iPad·Rarog", createdAt: "garbage", creator: "admin", creatorIsAdmin: true)
    let undatedMac = UICopy.newDeviceNotice(undated, .mac, timeZone: Self.zone)
    #expect(undatedMac.hasPrefix("Nowe urządzenie: iPad·Rarog, kod z Maca."))
    #expect(undatedMac.contains("na Macu"))
  }

  // MARK: Projects

  @Test("close armed: a done card is removed, a live panel is closed")
  func closeArmedByState() {
    #expect(UICopy.closeArmed(Sample.session(state: "done")).contains("usunięcie karty"))
    #expect(UICopy.closeArmed(Sample.session(state: "running")).contains("zamknięcie panelu"))
  }

  @Test("close refusal shows the server sentence")
  func closeRefusedMessage() {
    #expect(UICopy.closeMessage(.refused("⟦message⟧")) == "⟦message⟧")
  }
}
