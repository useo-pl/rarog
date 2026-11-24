#if os(iOS)
import RarogCore
import SwiftUI

// The voice agent on an Inbox card: the agent button in the card's bottom row, the voice strip that takes that row's
// place while the card's conversation runs (bars, the state sentence, Mute, End), the prompt block above the strip,
// and the end sentence after the conversation. The rules (when the button stands, the start, the ends, the block's
// phases and the voice lock) stand in `VoiceAgentInboxConversation`, the strip's state and the read-along split in
// `Model/InboxVoiceStrip.swift`; the views only draw them. Owner: Inbox.

/// The agent button at rest in a card's bottom row: a ring like the dictation mic, dimmed while another card talks.
struct InboxVoiceButton: View {
  let card: InboxCardModel
  let voice: VoiceAgentInboxConversation

  var body: some View {
    Button { voice.toggle(card) } label: {
      Image(systemName: "waveform")
        .font(.system(size: 17, weight: .medium))
        .foregroundStyle(Color(uiColor: Palette.muted))
        .frame(width: 40, height: 40)
        .overlay(Circle().stroke(Color(uiColor: Palette.border), lineWidth: 1))
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .opacity(voice.dims(card.id) ? 0.4 : 1)
    .pointerTip(UICopy.voiceAgentButton)
    .accessibilityLabel(UICopy.voiceAgentButton)
    .accessibilityIdentifier("inbox.voice.\(card.id)")
  }
}

/// The bottom row of a card without a reply field: its own content (Open session) with the agent button on the
/// right, or, while the card talks, that content above the voice strip.
struct InboxVoiceRow<Leading: View>: View {
  let card: InboxCardModel
  let voice: VoiceAgentInboxConversation
  @ViewBuilder let leading: Leading

  var body: some View {
    if voice.talks(card.id) {
      VStack(alignment: .leading, spacing: 8) {
        leading
        InboxVoiceStrip(card: card, voice: voice)
      }
      .padding(.trailing, 10)
    } else if voice.offered(card) {
      HStack(spacing: 8) {
        leading
        Spacer(minLength: 0)
        InboxVoiceButton(card: card, voice: voice)
      }
      .padding(.trailing, 10)
    } else {
      leading
    }
  }
}

/// The row of a talking card: the strip with the bars and the state sentence, Mute (the row's microphone) and End,
/// filled with the state's color.
struct InboxVoiceStrip: View {
  let card: InboxCardModel
  let voice: VoiceAgentInboxConversation

  var body: some View {
    let state = InboxVoiceStripState.make(indicator: voice.indicator, block: voice.block) ?? .indicator(.connecting)
    let tone = Color(uiColor: VoiceStatusView.color(state.tone))
    HStack(spacing: 8) {
      HStack(spacing: 10) {
        InboxVoiceBars(voice: voice, motion: state.motion)
        Text(Self.sentence(state))
          .appFont(.subheadline.weight(.semibold))
          .lineLimit(1)
          .truncationMode(.tail)
        Spacer(minLength: 0)
      }
      .foregroundStyle(tone)
      .padding(.horizontal, 14)
      .frame(maxWidth: .infinity, minHeight: 44)
      .background(RoundedRectangle.block.fill(tone.opacity(InboxVoiceStripState.tintAlpha)))
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(Self.sentence(state))
      .accessibilityAddTraits(.updatesFrequently)
      .accessibilityIdentifier("inbox.voiceStrip.\(card.id)")
      mute
      end(tone, motion: state.motion)
    }
  }

  private var mute: some View {
    let label = voice.muted ? UICopy.voiceAgentUnmute : UICopy.voiceAgentMute
    return Button { voice.toggleMute() } label: {
      Image(systemName: voice.muted ? "mic.slash.fill" : "mic.fill")
        .font(.system(size: 17, weight: .medium))
        .foregroundStyle(Color(uiColor: voice.muted ? Palette.err : Palette.text))
        .frame(width: 40, height: 40)
        .background(Circle().fill(Color(uiColor: Palette.micPlate)))
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .pointerTip(label)
    .accessibilityLabel(label)
    .accessibilityAddTraits(voice.muted ? .isSelected : [])
    .accessibilityIdentifier("inbox.voiceMute.\(card.id)")
  }

  private func end(_ tone: Color, motion: VoiceAgentIndicator.Motion) -> some View {
    Button { voice.end() } label: {
      InboxVoiceBars(voice: voice, motion: motion)
        .foregroundStyle(Color(uiColor: Palette.background))
        .frame(width: 40, height: 40)
        .background(Circle().fill(tone))
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .pointerTip(UICopy.voiceAgentEndButton)
    .accessibilityLabel(UICopy.voiceAgentEndButton)
    .accessibilityIdentifier("inbox.voiceEnd.\(card.id)")
  }

  static func sentence(_ state: InboxVoiceStripState) -> String {
    switch state {
    case let .indicator(indicator): UICopy.voiceAgentStatus(indicator)
    case .readingPrompt: UICopy.inboxVoiceReadingPrompt
    }
  }
}

/// Five bars from the conversation's levels (`VoiceAgentBars`), the only view that reads them, so the 50 ms updates
/// redraw the bars alone. With reduced motion they stand still.
struct InboxVoiceBars: View {
  let voice: VoiceAgentInboxConversation
  let motion: VoiceAgentIndicator.Motion
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let level = VoiceAgentBars.level(voice.levels, motion: motion)
    let heights = VoiceAgentBars.heights(level: level, motion: motion, reduceMotion: reduceMotion)
    HStack(spacing: 3) {
      ForEach(heights.indices, id: \.self) { index in
        Capsule().frame(width: 3, height: heights[index])
      }
    }
    .frame(height: VoiceAgentBars.maxHeight)
    .accessibilityHidden(true)
  }
}

/// The agent's prompt in its block above the strip: the text with its read part lit while the app reads it, Edit and
/// Send; Edit turns the same block into a field with an amber frame, Cancel goes back to the agent's text.
struct InboxPromptBlockView: View {
  let card: InboxCardModel
  let voice: VoiceAgentInboxConversation
  let block: InboxPromptBlock
  @FocusState private var focused: Bool

  var body: some View {
    let editing = block.phase == .editing
    VStack(alignment: .leading, spacing: 8) {
      Text(block.showsEdit ? UICopy.inboxPromptEdited : UICopy.inboxPromptLabel)
        .appFont(.caption.weight(.semibold))
        .foregroundStyle(Color(uiColor: block.showsEdit ? Palette.wait : Palette.run))
        .accessibilityAddTraits(.isHeader)
      if editing {
        TextField(
          UICopy.inboxPromptLabel, text: Binding(get: { voice.block?.edited ?? block.text }, set: { voice.editText($0) }),
          axis: .vertical
        )
        .lineLimit(1...8)
        .appFont(.callout)
        .foregroundStyle(Color(uiColor: Palette.text))
        .focused($focused)
        .onAppear { focused = true }
        .accessibilityLabel(UICopy.inboxPromptLabel)
        .accessibilityIdentifier("inbox.promptField.\(card.id)")
      } else {
        Text(Self.text(block.shownText, progress: block.showsEdit ? nil : voice.readProgress))
          .appFont(.callout)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityLabel(block.shownText)
          .accessibilityIdentifier("inbox.promptText.\(card.id)")
      }
      // Why the last send came back: the block stands again with its text and this reason.
      if let reason = block.reason {
        Text(reason)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.err))
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("inbox.promptReason.\(card.id)")
      }
      HStack(spacing: 8) {
        Spacer(minLength: 0)
        if editing {
          Button(UICopy.inboxPromptCancel) { voice.cancelEdit() }
            .buttonStyle(NeutralButtonStyle())
            .accessibilityIdentifier("inbox.promptCancel.\(card.id)")
        } else {
          Button(UICopy.inboxPromptEdit) { voice.edit() }
            .buttonStyle(NeutralButtonStyle())
            .disabled(block.phase == .sending)
            .accessibilityIdentifier("inbox.promptEdit.\(card.id)")
        }
        Button(UICopy.inboxPromptSend) { voice.sendBlock() }
          .buttonStyle(FilledButtonStyle(fill: Color(uiColor: Palette.accent), text: Color(uiColor: Palette.onState)))
          .disabled(!voice.blockSendable)
          .opacity(voice.blockSendable ? 1 : 0.5)
          .accessibilityIdentifier("inbox.promptSend.\(card.id)")
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .background(RoundedRectangle.block.fill(Color(uiColor: Palette.surface2)))
    .overlay {
      if editing { RoundedRectangle.block.strokeBorder(Color(uiColor: Palette.wait), lineWidth: 1.5) }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("inbox.prompt.\(card.id)")
  }

  /// The text with the heard part in the text's ink, the word being said lit, the rest quiet; plain without a
  /// reading.
  static func text(_ text: String, progress: ReadingProgress?) -> AttributedString {
    guard let split = InboxPromptHighlight.split(text, progress: progress) else {
      var plain = AttributedString(text)
      plain.foregroundColor = Color(uiColor: Palette.text)
      return plain
    }
    var heard = AttributedString(split.heard)
    heard.foregroundColor = Color(uiColor: Palette.text)
    var now = AttributedString(split.now)
    now.foregroundColor = Color(uiColor: Palette.text)
    now.backgroundColor = Color(uiColor: Palette.promptHighlight)
    var rest = AttributedString(split.rest)
    rest.foregroundColor = Color(uiColor: Palette.muted)
    return heard + now + rest
  }
}

/// The end sentence of the card's conversation under the card's bottom row, until a tap or the next start.
struct InboxVoiceStatus: View {
  let card: InboxCardModel
  let voice: VoiceAgentInboxConversation

  var body: some View {
    if voice.indicatorCard == card.id, let indicator = voice.indicator, !indicator.isActive {
      Text(UICopy.voiceAgentStatus(indicator))
        .appFont(.footnote)
        .foregroundStyle(Color(uiColor: VoiceStatusView.color(indicator.tone)))
        .fixedSize(horizontal: false, vertical: true)
        .padding(.trailing, 10)
        .contentShape(Rectangle())
        .onTapGesture { voice.dismissNotice() }
        .accessibilityIdentifier("inbox.voiceStatus.\(card.id)")
    }
  }
}
#endif
