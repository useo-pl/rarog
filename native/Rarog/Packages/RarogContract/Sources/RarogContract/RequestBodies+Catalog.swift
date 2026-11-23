// Ciała POST zakładania i zamykania sesji — lustro `createSessionBodySchema` i `closeBodySchema`
// z `shared/src/protocol.ts`. Serwer waliduje je ściśle, więc pola bez wartości nie lecą wcale
// (synteza `Encodable` pomija `nil`). Właściciel: projekty i zakładki.

import Foundation

/// Tryb uprawnień panelu przy zakładaniu (`PERMISSION_MODES`). `bypassPermissions` serwer
/// przepuszcza wyłącznie dla katalogów z `RAROG_YOLO_ROOTS` — apka go nie wybiera sama.
public enum CreateSessionPermissionMode: String, Sendable, Equatable, Encodable, CaseIterable {
  case manual
  case acceptEdits
  case auto
  case plan
  case bypassPermissions
}

/// `POST /api/sessions` — ZAŁOŻENIE PANELU w herdr. Brak `prompt` = pusta sesja czekająca na
/// pierwszą wiadomość; brak `model` = model domyślny konta (zero flagi `--model`).
///
/// `effort` przyjmuje wyłącznie wartości znane serwerowi: wartownik klienta `unsupported`
/// (nieznany effort z drutu) wypada z ciała już w inicjatorze.
///
/// `ultracode` jedzie wyłącznie jako `true` i niezależnie od modelu: start flagą, która ustawia poziom
/// xhigh (serwer odrzuca ultracode z innym effortem). Wyłączony = pola nie ma, bo jawne `false` serwer odrzuca.
public struct CreateSessionBody: Sendable, Equatable, Encodable {
  public var cwd: String
  public var prompt: String?
  public var permissionMode: CreateSessionPermissionMode?
  public var model: String?
  public var effort: EffortLevel?
  /// Wznowienie sesji CLI (`--resume`); bez `fork` tylko dla wpisu, który nie żyje w herdr.
  public var resumeFrom: String?
  /// `--fork-session` — wymaga `resumeFrom`.
  public var fork: Bool?
  /// Start z ultracode: `true` albo brak pola.
  public var ultracode: Bool?

  public init(
    cwd: String, prompt: String? = nil, permissionMode: CreateSessionPermissionMode? = nil,
    model: String? = nil, effort: EffortLevel? = nil, resumeFrom: String? = nil, fork: Bool? = nil,
    ultracode: Bool = false
  ) {
    self.cwd = cwd
    self.prompt = prompt
    self.permissionMode = permissionMode
    let trimmedModel = model?.trimmingCharacters(in: .whitespaces)
    self.model = trimmedModel?.isEmpty == false ? trimmedModel : nil
    // Effort bez modelu nie ma znaczenia (serwer bierze go z modelu domyślnego konta tylko
    // przy jawnym modelu).
    self.effort = self.model == nil || effort == .unsupported ? nil : effort
    self.resumeFrom = resumeFrom
    self.fork = fork
    self.ultracode = ultracode ? true : nil
  }
}

/// `POST /api/sessions/<id>/close`. `closePanel: true` = `tab.close` w herdr (niezależnie
/// od tego, kto panel założył); karta `done` bez panelu jest wtedy tylko zapominana.
/// Brak pola = samo „ukryj kartę" — apka go nie wysyła.
public struct CloseSessionBody: Sendable, Equatable, Encodable {
  public var closePanel: Bool?

  public init(closePanel: Bool? = true) {
    self.closePanel = closePanel
  }
}
