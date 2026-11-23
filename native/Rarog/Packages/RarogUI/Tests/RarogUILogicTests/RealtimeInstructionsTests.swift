import Foundation
@testable import RarogUI
import Testing

// `session.update` of the voice conversation without captions: no transcription model, English tool names and
// argument fields, the prompt tool writes into the message field. Owner: voice agent.

@Suite("voice conversation: session.update and tools")
struct RealtimeInstructionsTests {
  @Test("session.update has no transcription: the app shows no captions and pays for no transcription model")
  func noTranscription() throws {
    let session = RealtimeInstructions.session(instructions: "x", tools: RealtimeInstructions.tools())
    let audio = try #require(session["audio"] as? [String: Any])
    let input = try #require(audio["input"] as? [String: Any])
    #expect(input["transcription"] == nil)
    #expect(input["turn_detection"] != nil)
    let encoded = RealtimeClientEvent.sessionUpdate(instructions: "x", tools: RealtimeInstructions.tools())
    #expect(!encoded.contains("transcription") && !encoded.contains("gpt-transcribe"))
  }

  @Test("Soniox speaks: text output only, no output audio and no OpenAI voice; microphone input, VAD and tools")
  func textSession() throws {
    let session = RealtimeInstructions.session(instructions: "x", tools: RealtimeInstructions.tools())
    #expect(session["output_modalities"] as? [String] == ["text"])
    let audio = try #require(session["audio"] as? [String: Any])
    #expect(audio["output"] == nil)
    #expect((audio["input"] as? [String: Any])?["turn_detection"] != nil)
    #expect((session["tools"] as? [[String: Any]])?.count == 3)
    #expect(!RealtimeClientEvent.sessionUpdate(instructions: "x", tools: RealtimeInstructions.tools()).contains(#""voice""#))
  }

  @Test("noise: OpenAI filters far-field noise before the VAD, and the VAD cancels no response (the app cuts)")
  func noiseAndCut() throws {
    let session = RealtimeInstructions.session(instructions: "x", tools: RealtimeInstructions.tools())
    let audio = try #require(session["audio"] as? [String: Any])
    let input = try #require(audio["input"] as? [String: Any])
    let noise = try #require(input["noise_reduction"] as? [String: Any])
    #expect(noise["type"] as? String == "far_field")
    let vad = try #require(input["turn_detection"] as? [String: Any])
    #expect(vad["interrupt_response"] as? Bool == false)
  }

  @Test("tool names and argument fields are English")
  func englishTools() throws {
    let tools = RealtimeInstructions.tools()
    #expect(tools.compactMap { $0["name"] as? String } == ["ask_session", "show_prompt", "send_prompt"])
    let fields = tools.map { tool -> [String] in
      let parameters = tool["parameters"] as? [String: Any]
      return ((parameters?["properties"] as? [String: Any])?.keys).map { Array($0) } ?? []
    }
    #expect(fields == [["question"], ["text"], []])
    let show = try #require(tools[1]["description"] as? String)
    #expect(show.contains("message field"))
    #expect(RealtimeInstructions.role().contains("ask_session") && RealtimeInstructions.role().contains("show_prompt"))
  }

  @Test("the role and the send tool say a send takes the whole message field, and the model says so before asking")
  func sendTakesTheField() throws {
    let role = RealtimeInstructions.role()
    #expect(role.contains("whole message field"))
    #expect(role.contains("before you ask whether to send"))
    #expect(!role.contains("replaces the previous one"))
    let tools = RealtimeInstructions.tools()
    let send = try #require(tools[2]["description"] as? String)
    #expect(send.contains("whole message field") && send.contains("same as the send button"))
    let show = try #require(tools[1]["description"] as? String)
    #expect(show.contains("under the user's text"))
  }

  @Test("prompts and answers after English tool results stay in the language the user speaks")
  func languageHolds() throws {
    let role = RealtimeInstructions.role()
    #expect(role.contains("Write prompts for the agent in that language too"))
    #expect(role.contains("Tool results are in English"))
    let tools = RealtimeInstructions.tools()
    let show = try #require(tools[1]["parameters"] as? [String: Any])
    let text = try #require((show["properties"] as? [String: Any])?["text"] as? [String: Any])
    #expect((text["description"] as? String)?.contains("in the language the user speaks") == true)
  }
}
