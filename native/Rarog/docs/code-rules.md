# Code rules

Part of the app description: [native/Rarog/README.md](../README.md).

- **Swift 6, strict concurrency** (`swiftLanguageModes: [.v6]`). Wire types are `Sendable` values.
- **Isolation:** `RarogContract` and `RarogTransport` have NO default isolation. They are pure or network code and
  run off the main actor (decoding a large `transcript-snapshot` must not block the UI). The state store in
  `RarogCore` and the whole app are `@MainActor` (`@Observable`). App code that must run off the main actor is
  marked `nonisolated` explicitly, at the declaration, with a comment saying why.
- **The client does not know the CLI:** no tool names, no CLI texts and no decisions based on the reply channel.
  Decisions follow semantic fields (`subject`, `delegation`, `inputKind`, `customAnswer`, `role`, `canAllow`,
  `terminalOnly`). `SourceGuardTests` enforces this with a scan of the Swift sources without comments; the only
  exception is the copy dictionary keys in `RarogUI/Copy/ToolActivity.swift`.
- **Tolerance as in `shared/src/decode.ts`:** an unknown STRING in an enum field gives the fallback value from
  `DegradationKey` (a mirror of `DEGRADATIONS`) and a degradation `(JSON Pointer, value)`; `null`, a missing
  required field, a wrong type and a broken known block reject the frame. Unknown keys are dropped.
  `APIErrorTolerance` reads a REST refusal body: the code stays a string (each area recognizes its own codes, the
  rest falls back to `message ?? <generic sentence>`), and the server's sentence survives a body without a code or
  with a code that is not a string. The code of the server's sentence (`messageRef.code`) stays in
  `APIFailure.sentenceCode`, so an area can tell apart two refusals with the same code (a 409 `bad-state`).
- **`null` ≠ missing field.** Every wire type decodes by hand through `ContractContainer`. `decodeIfPresent` (and a
  synthesized `Decodable`) turns `null` into a missing field, so `SourceGuardTests` (in `RarogContract`) fails on any
  `decodeIfPresent` in the contract sources.
- **Deliberate deviation:** numbers the server computes as integers (`seq`, counters, tokens, bytes) are `Int`. A
  fraction in such a field rejects the frame, although `z.number()` in TypeScript would accept it. The server
  computes all of them as integers (`Math.round`, lengths, counters); `Double` in the model would cost every reader
  a conversion.
- **Authentication:** only the device key from pairing ("Device key in transport" below and "Pairing and device key"
  under RarogCore). The app has no token or cookie login: the client's URL session has no cookie store, requests
  carry no `Cookie` header, and a `Set-Cookie` in a response is dropped. Every mutation carries `Origin` from
  `RarogConfig`: over HTTPS it must be listed in `RAROG_ORIGINS`, over iroh it is `IrohWire.origin`
  (`https://iroh.rarog.invalid`), the only origin the server accepts on the iroh socket; the user agent is
  `RarogApp/<build>`.
- **Device key in transport:** `RarogClient(device:)` with a `DeviceCredential` adds
  `Authorization: Rarog-Device <deviceId>.<secret>` to REST, SSE, uploads from a file, images and the terminal
  socket upgrade (`TerminalRequestBuilder`, parameter `authorization`). There is one credential per client
  lifetime: a different server or key means a new client (the core swaps it). A 401 deletes nothing in the
  transport: the latch `credentialRejection` keeps `device-revoked` (with `revokedAt`, `revokedBy`; an "unknown"
  after it does not overwrite it) or "unknown", and the core decides about the Keychain. `POST /api/pair`
  (`pair(_:)`) goes without the key, with `Origin`, and is exempt from the compatibility gate
  (`MutationGate.compatibilityExempt`), because pairing happens before the server's first `hello`. Forget Server
  (`POST /api/devices/forget`) is exempt too: self-revocation works when the app is too old and when it is offline
  (best effort). The secret never reaches text: `DeviceCredential` prints without it, and a pairing response decode
  error does not quote the body. Keychain: the `DeviceKeychain` protocol, `SystemKeychain` in the app (two items,
  see "Keychain" under "The app"), `MemoryKeychain` in tests (states `locked`, a refused write, no shared group,
  an unreadable private item). The push key by `kid` is read through the narrow `PushKeyReader` protocol
  (`PushKeys.swift`, one method, no side effects): the notification service extension gets ONLY
  `SharedPushKeychain` (the shared item alone), the app gets `SystemKeychain` (the shared item, and without it a
  copy from the private item when the `kid` matches). Tests: `DeviceAuthTests`, `MemoryKeychainTests`.
- **v3 banner (`PushOpening.swift`):** `PushOpening.open` reads the `rarog` v3 block from `userInfo` (version, the
  envelope before the cipher, the key by `kid`, `PushCrypto` from `RarogContract`) and returns the plain text or a
  `PushRefusal`, a reason without content. The notification service extension and the app (`PushRouting`) call the
  same code. `PushServiceDecision.decide` (NSE) adds freshness: `now > exp + 300 s` shows the original; without a
  title and body (a badge only) it shows the original too. `OnceHandler` calls the system handler exactly once
  (normal end or `serviceExtensionTimeWillExpire`). Tests: `PushServiceTests` (vectors
  `shared/fixtures/push-crypto/vectors.v3.json`, each refusal, the `exp` boundary, the handler).
- **Login generation:** in the core, a network action records `currentLogin` before the request, checks
  `isCurrentLogin(_:)` after each `await` and hands a 401 to `handleUnauthorized(since:)`. Each new login
  (pairing, retrying the key) and each logout increments the generation; a start with a key is the process's first
  login and does not. So a late 401 from before a new login does not log out the new one. The core areas
  work the same way (question answers, card decisions, Resume, interrupt,
  result seen, the new session form, images, the dictation key); their own cut-off of results after a logout
  (`AnswerFlights`, `CardRequests`, `tracked`, `UploadReads`, `VoiceMinting`) stays, so a result from an old login
  neither reaches the screen nor touches authorization. The transport deletes nothing on a 401: the latch
  (`credentialRejection`) records the key refusal.
- **Client gates in one place:** `MutationGate` (session `unsupported`, global compatibility). `RarogCore` provides
  the state through `MutationPolicy`, and a refusal is a `PolicyRefusal`: a sentence and `transient` (it passes by
  itself: no `hello` yet, or no fresh list). Decisions follow that field, not the sentence, because the sentence
  depends on the app language. Exempt from compatibility: pairing, Forget Server, `client-log`, presence. Terminal
  input (`checkTerminalInput()`) asks `terminalInputRefusal()`: it refuses only on a permanent incompatibility
  (`tooOld`, `protocolMismatch`) and does not wait for `hello` or a fresh list (the terminal socket does not depend
  on SSE).
- **Terminal (`TerminalSession`, `RarogStore+Terminal`, `Reducer+Terminal`):** a pure state machine
  `TerminalMachine` (`connecting → live → reconnecting(n) → missing | exited | failed`, `suspended` in the
  background) and a session that performs its effects.
  - **Attempt:** first `POST /api/term` with the same directory, slot and role (`next` only on a deliberate
    New Terminal; after the reply, the slot number), then the `TerminalSocket` socket (`URLSessionWebSocketTask`,
    headers from `TerminalRequestBuilder`). Exception: a fresh attempt (`start()`, `resume()`) with a known id, a
    directory, role `shell` or `popup` and a slot other than `next` goes straight to a `direct=1` socket without
    `POST`. If that socket closes before `opened` (a server refusal or the network), the same attempt repeats at
    once through `POST` (a new generation, `fresh` stays, no disconnect counted, once). The `restart()` gesture,
    retries, `next` and lazygit always go through `POST`; a target without a directory connects directly without
    the flag.
  - **Rhythm:** retries after 1, 2 and 5 s; `missing` after three disconnects, only without a directory; every `err`
    and `exit` stops the machine (the `restart()` gesture brings it back). The generation number drops late replies,
    closes, timers and gate refusals. Allocating `next` is not idempotent (each one starts a shell): its reply is
    accepted from any generation, and until it arrives the next attempt waits instead of sending a second `next`.
    An uncertain result (timeout, disconnect mid-request) stops the machine in `failed(.newTerminalUnconfirmed)`. A
    `POST` in flight is not cancelled when the app goes to the background.
  - **Output:** the output queue belongs to the socket: a disconnect drops the rest (pastes too), and nothing is
    resent by itself. A paste (`paste`) is a SEPARATE path: `pa` frames from `TerminalPaste` (the raw clipboard text;
    the server cleans line endings and the 200~/201~ markers), a 512 kB cap checked before sending (`.tooLarge`,
    nothing goes out), and typing waits in the queue BEHIND the paste (`in` in the middle of it would make the
    server reject the whole paste).
  - **Store:** the store suspends terminal sessions in the background and wakes them in the foreground (a new
    `fresh=1` socket), ends them on logout, blocks them on a permanent incompatibility, stops them BEFORE `DELETE`
    (otherwise a retry's `POST` would revive the pane), invalidates list reads sent before a close (a read number;
    an old list does not bring the entry back), and polls `GET /api/term` every 5 s only under
    `watchTerminals(true)`. History goes only to the caller, and only within the same login.
  - **Frames:** `TerminalFrames` (`RarogContract`, encoder with `withoutEscapingSlashes`); chunking:
    `TerminalInputChunker` (`RarogTransport`, an 8 KiB budget per finished frame, vectors from
    `shared/fixtures/term/chunk-vectors.json`). Terminal content never reaches logs, disk or `client.log` (a guard in
    `SourceGuardTests` on files with "Terminal" in the name, in `Terminal/` directories and in the `RarogTerminal`
    package).
  - **Timing:** a fresh attempt (`start()`, `resume()`) reports its monotonic clock times once, at the first bytes
    and before them (`onConnectTiming`, `TerminalConnectTiming`: start, `POST` reply, "skipped" or the `POST` reply
    after a refused direct socket, socket open, first bytes; the clock is injected). A retry after a disconnect, the
    `restart()` gesture and an attempt abandoned before the first bytes have none. The screen builds the opening
    trace from them ("Opening trace" under "Terminal screen").
