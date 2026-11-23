import Foundation
import RarogContract

// Właściciel: wysyłka. Ciało `POST /api/sessions/<id>/messages` z załącznikami składane
// strumieniowo do pliku: 4 pliki po 20 MB to ~110 MB base64, którego nie trzymamy w pamięci jako
// `String`.

/// Wiadomość do wysłania: tekst, identyfikator `clientMessageId` i załączniki jako pliki na dysku. Treść plików
/// jest już przygotowana (zdjęcie: JPEG po zmniejszeniu, plik: bajt w bajt), więc „Ponów" składa
/// z nich TE SAME bajty ciała.
public struct OutgoingMessage: Sendable, Equatable {
  public struct Part: Sendable, Equatable {
    public enum Kind: String, Sendable, Codable {
      /// `images[]`: data URL png/jpeg, bez nazwy (aparat ani schowek nazwy nie dają).
      case image
      /// `files[]`: `{name, dataUrl}` z dowolnym typem MIME.
      case file
    }

    public var kind: Kind
    /// Nazwa pliku po sanityzacji (`isSafeFileName` w kontrakcie); zdjęcie jej nie wysyła.
    public var name: String
    /// Typ MIME do data URL-a (`image/jpeg`, `application/pdf`…), małymi literami.
    public var mime: String
    public var file: URL

    public init(kind: Kind, name: String, mime: String, file: URL) {
      self.kind = kind
      self.name = name
      self.mime = mime
      self.file = file
    }
  }

  public var text: String
  public var clientMessageId: String?
  /// Kolejność wysyłki: zdjęcia przed plikami (tak liczy skrót wysyłki i wizytówki echa).
  public var parts: [Part]

  public init(text: String, clientMessageId: String?, parts: [Part]) {
    self.text = text
    self.clientMessageId = clientMessageId
    self.parts = parts
  }
}

/// Dlaczego ciała nie da się złożyć — wołający zamienia to w odmowę bez żądania.
public enum MessageBodyError: Error, Sendable, Equatable {
  /// Pliku treści załącznika nie ma (albo nie da się go otworzyć) — indeks w `parts`.
  case missingPart(Int)
  /// Plik treści jest pusty: data URL bez treści serwer i tak odrzuci.
  case emptyPart(Int)
  /// Zapis ciała na dysk nie powiódł się.
  case io(String)
  /// The caller's task was cancelled (the stop in the progress ring): the rest of the body is not composed.
  case cancelled
}

/// Składa ciało JSON wiadomości do pliku, kawałkami, z base64 liczonym w locie.
///
/// Kształt jest DOKŁADNIE ten, który zakodowałby `JSONEncoder` dla `MessageBody`: puste listy
/// i brak identyfikatora to brak klucza (`images`, `files`, `clientMessageId`), nie `[]`/`null`.
public enum MessageBodyWriter {
  /// Kawałek odczytu: wielokrotność 3, więc base64 kawałków skleja się bez dopełnienia w środku.
  static let chunkBytes = 3 * 256 * 1024

  /// Writes the body to `target` (the file is replaced) and returns its size in bytes. A cancelled task stops it
  /// before the next chunk of content (`.cancelled`); the caller removes the partial file.
  @discardableResult
  public static func write(_ message: OutgoingMessage, to target: URL) throws(MessageBodyError) -> Int {
    if Task.isCancelled { throw .cancelled }
    let manager = FileManager.default
    try? manager.removeItem(at: target)
    guard manager.createFile(atPath: target.path, contents: nil) else {
      throw .io("nie da się założyć pliku ciała")
    }
    let out: FileHandle
    do {
      out = try FileHandle(forWritingTo: target)
    } catch {
      throw .io("nie da się otworzyć pliku ciała: \(error)")
    }
    defer { try? out.close() }
    var written = 0
    func emitData(_ data: Data) throws(MessageBodyError) {
      do {
        try out.write(contentsOf: data)
      } catch {
        throw .io("zapis ciała: \(error)")
      }
      written += data.count
    }
    func emit(_ text: String) throws(MessageBodyError) { try emitData(Data(text.utf8)) }

    try emit("{\"text\":")
    try emitData(jsonString(message.text))
    let images = message.parts.enumerated().filter { $0.element.kind == .image }
    let files = message.parts.enumerated().filter { $0.element.kind == .file }
    if !images.isEmpty {
      try emit(",\"images\":[")
      for (position, item) in images.enumerated() {
        if position > 0 { try emit(",") }
        try emit("\"data:\(item.element.mime);base64,")
        try streamBase64(item.element.file, index: item.offset, into: emitData)
        try emit("\"")
      }
      try emit("]")
    }
    if !files.isEmpty {
      try emit(",\"files\":[")
      for (position, item) in files.enumerated() {
        if position > 0 { try emit(",") }
        try emit("{\"name\":")
        try emitData(jsonString(item.element.name))
        try emit(",\"dataUrl\":\"data:\(item.element.mime);base64,")
        try streamBase64(item.element.file, index: item.offset, into: emitData)
        try emit("\"}")
      }
      try emit("]")
    }
    if let id = message.clientMessageId {
      try emit(",\"clientMessageId\":")
      try emitData(jsonString(id))
    }
    try emit("}")
    return written
  }

  /// Literał łańcucha JSON (cudzysłowy i ucieczki) — te same reguły co `JSONEncoder`.
  static func jsonString(_ value: String) -> Data {
    (try? JSONEncoder().encode(value)) ?? Data("\"\"".utf8)
  }

  /// Treść pliku jako base64, kawałkami wielokrotności 3 (dopełnienie wyłącznie na końcu).
  private static func streamBase64(
    _ file: URL, index: Int, into emit: (Data) throws(MessageBodyError) -> Void
  ) throws(MessageBodyError) {
    let input: FileHandle
    do {
      input = try FileHandle(forReadingFrom: file)
    } catch {
      throw .missingPart(index)
    }
    defer { try? input.close() }
    var carry = Data()
    var total = 0
    while true {
      if Task.isCancelled { throw .cancelled }
      let chunk: Data
      do {
        chunk = try input.read(upToCount: chunkBytes) ?? Data()
      } catch {
        throw .missingPart(index)
      }
      if chunk.isEmpty { break }
      total += chunk.count
      carry.append(chunk)
      let whole = carry.count - carry.count % 3
      if whole > 0 {
        try emit(carry.prefix(whole).base64EncodedData())
        carry = Data(carry.dropFirst(whole))
      }
    }
    guard total > 0 else { throw .emptyPart(index) }
    if !carry.isEmpty { try emit(carry.base64EncodedData()) }
  }
}

/// Ciało wysyłki dla transportu: w pamięci (sam tekst) albo plik złożony przez ``MessageBodyWriter``.
public struct MessageUpload: Sendable, Equatable {
  public enum Body: Sendable, Equatable {
    case data(Data)
    case file(URL)
  }

  public var body: Body
  /// Identyfikator wysłany w ciele — transport sprawdza, że odpowiedź oddała TEN SAM.
  public var clientMessageId: String?

  public init(body: Body, clientMessageId: String?) {
    self.body = body
    self.clientMessageId = clientMessageId
  }

  /// Ciało w pamięci z `MessageBody` (wiadomość bez załączników).
  public static func json(_ message: MessageBody) throws(TransportError) -> MessageUpload {
    do {
      return MessageUpload(body: .data(try JSONEncoder().encode(message)), clientMessageId: message.clientMessageId)
    } catch {
      throw .invalidResponse("nie da się zakodować ciała wiadomości: \(error)")
    }
  }
}

/// Postęp wysyłki ciała. Kodowanie ciała to etap wołającego, nie transportu.
public enum UploadProgress: Sendable, Equatable {
  /// Ciało w drodze: ile bajtów wyszło z ilu (`total == 0` = nie wiadomo).
  case uploading(sent: Int64, total: Int64)
  /// Całe ciało wyszło — serwer zapisuje załączniki i odpowie (202 albo odmowa).
  case awaitingResponse

  /// Etap z raportu `URLSession` (`didSendBodyData`).
  public static func from(sent: Int64, total: Int64) -> UploadProgress {
    if total > 0, sent >= total { return .awaitingResponse }
    return .uploading(sent: max(0, sent), total: max(0, total))
  }
}
