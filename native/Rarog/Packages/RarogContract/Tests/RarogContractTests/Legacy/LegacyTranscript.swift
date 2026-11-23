// Kopie dekoderów starej apki `TranscriptMessage`, `Block`, `ToolCallBlock` i `ImageBlock` (`Transcript.swift`). Zasady
// kopii i typy współdzielone: `LegacyContract.swift`.
@testable import RarogContract

extension OldApp {
  /// Wiadomość transkryptu w kształcie starej apki (bloki z kopii).
  struct TranscriptMessage: Sendable, Equatable, Decodable {
    var seq: Int
    var role: MessageRole
    var blocks: [Block]
    var at: String
    var attachments: [MessageAttachment]?
    var clientMessageId: String?
    var notice: TranscriptNotice?
    var promptBlocked: TranscriptPromptBlocked?

    enum CodingKeys: String, CodingKey {
      case seq, role, blocks, at, attachments, clientMessageId, notice, promptBlocked
    }

    init(from decoder: any Decoder) throws {
      let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
      seq = try c.required(.seq)
      role = try c.lenient(.role, degrade: .messageRole)
      blocks = try c.required(.blocks)
      at = try c.required(.at)
      attachments = try c.optional(.attachments)
      clientMessageId = try c.optional(.clientMessageId)
      notice = try c.optional(.notice)
      promptBlocked = try c.optional(.promptBlocked)
    }
  }

  /// Blok w kształcie starej apki: `.text(String)` bez `ref`; nieznany `type` → `unsupported`, uszkodzony znany blok
  /// odrzuca ramkę.
  enum Block: Sendable, Equatable, Decodable {
    case text(String)
    case toolCall(ToolCallBlock)
    case image(ImageBlock)
    case unsupported

    enum CodingKeys: String, CodingKey { case type, text }

    private enum Kind: String, ContractEnum {
      case text
      case toolCall = "tool-call"
      case image
      case unsupported

      static var clientSentinel: Kind? { .unsupported }
    }

    init(from decoder: any Decoder) throws {
      let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
      let raw: String = try c.required(.type)
      switch Kind.wire(raw) {
      case .text: self = .text(try c.required(.text))
      case .toolCall: self = .toolCall(try ToolCallBlock(from: decoder))
      case .image: self = .image(try ImageBlock(from: decoder))
      case .unsupported, nil:
        c.degrade(.type, raw: raw)
        self = .unsupported
      }
    }
  }

  /// Blok narzędzia w kształcie starej apki (bez `truncation`).
  struct ToolCallBlock: Sendable, Equatable, Decodable {
    var toolName: String
    var summary: String
    var detail: String?
    var detailKind: DetailKind?
    var delegation: Delegation?
    var inputKind: InputKind?

    enum CodingKeys: String, CodingKey { case toolName, summary, detail, detailKind, delegation, inputKind }

    init(from decoder: any Decoder) throws {
      let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
      toolName = try c.required(.toolName)
      summary = try c.required(.summary)
      detail = try c.optional(.detail)
      detailKind = try c.lenientOptional(.detailKind, degrade: .blockDetailKind)
      delegation = try c.lenientOptional(.delegation, degrade: .blockDelegation)
      inputKind = try c.lenientOptional(.inputKind, degrade: .blockInputKind)
    }
  }

  /// Obrazek w kształcie starej apki (bez `placeholder`).
  struct ImageBlock: Sendable, Equatable, Decodable {
    var dataUrl: String
    var alt: String?

    enum CodingKeys: String, CodingKey { case dataUrl, alt }

    init(from decoder: any Decoder) throws {
      let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
      dataUrl = try c.required(.dataUrl)
      alt = try c.optional(.alt)
      guard WireFormat.isImageDataURL(dataUrl) else {
        throw contractViolation(c.codingPath + [CodingKeys.dataUrl], "obrazek spoza png/jpeg base64 albo za duży")
      }
    }
  }
}
