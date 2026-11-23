import Foundation
@testable import RarogUI
import Testing

// The scripts of the UI tests (Debug build): the dictation script and its English variant
// (`RAROG_UI_TEST_VOICE_SCRIPT=en`, for screenshots), and the voice agent hold in "Hearing you"
// (`RAROG_UI_TEST_VOICE_AGENT=hearing`). The environment comes in as a parameter, so the tests need no process
// variables. Owner: dictation and voice agent.

#if DEBUG
@Suite struct ScriptedVoiceTests {
  /// The text after the Soniox frames of a script: what the field shows mid-recording and after the end.
  private func field(_ frames: String...) -> String {
    frames.reduce(VoiceBuffers.empty) { buffers, frame in
      SonioxText.apply(buffers, SonioxReply.parse(frame)?.tokens ?? [])
    }.text
  }

  @Test func withoutTheVariableTheScriptStaysPolish() {
    let script = ScriptedVoice.script(environment: [:])
    #expect(script.systemPartial == "Dyktuję z")
    #expect(script.systemFinal == "Dyktuję z iPada.")
    #expect(field(script.partial) == "Dyktuję z")
    #expect(field(script.partial, script.tail) == "Dyktuję z iPada.")
  }

  @Test func englishScriptGivesAnEnglishSentenceOnBothRoutes() {
    let script = ScriptedVoice.script(environment: [ScriptedVoice.scriptKey: "en"])
    #expect(script.systemPartial == "Then do the same for the September export")
    #expect(script.systemFinal == "Then do the same for the September export.")
    #expect(field(script.partial) == script.systemPartial)
    #expect(field(script.partial, script.tail) == script.systemFinal)
  }

  @Test func otherValueOfTheVariableKeepsTheDefaultScript() {
    #expect(ScriptedVoice.script(environment: [ScriptedVoice.scriptKey: "de"]).systemFinal == "Dyktuję z iPada.")
  }

  @Test func voiceAgentSpeechEndsUnlessHeldInHearing() {
    let key = ScriptedVoiceAgent.environmentKey
    #expect(ScriptedVoiceAgent.speechEnd(environment: [key: "1"]).isFinite)
    #expect(ScriptedVoiceAgent.speechEnd(environment: [key: "hearing"]) == .infinity)
  }
}
#endif
