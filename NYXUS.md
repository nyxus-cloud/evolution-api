# Nyxus fork

This fork exists only to ship fixes that upstream has not released yet. Use the official image again as soon as a release carries them.

Branch `nyxus/2.4.0-rc2` is the `2.4.0-rc2` tag plus:

| Commit | Why | Upstream |
| --- | --- | --- |
| `fix(whatsapp): restore reply/quote contextInfo in prepareMessage` | rc2 reads `contextInfo` from `messageContextInfo`, so mentions and replies never reach webhooks or storage | PR #2654, issue #2713 |
| `fix(security): bind every request to the authenticated instance` | query or body fields can no longer override the instance in the path | `release/2.3.8` |
| `fix(security): keep the body name on instance create` | follow-up to the fix above | `release/2.3.8` |
| `feat(chat): keep history LID-phone pairs and look them up` | Baileys rc.9 drops the LID ↔ phone pairs of the history sync, so chats with non-contacts stay LID-only. See below | Baileys PRs #2268, #2282, #2316 (in `7.0.0-rc10`) |
| `fix(whatsapp): keep a history batch when some messages cannot be stored` and `fix(whatsapp): one bad row no longer drops other messages, chats or contacts` | One `messageHistoryNotice` (no `messageType`) made `createMany` reject and lose a whole history batch. See below | none yet |
| `fix(whatsapp): reconnect a paired number on 408 and transient closes with backoff` and `fix(whatsapp): a replaced socket no longer starts another reconnect` | A 408 under load logged out paired numbers and removed their session; a 440 reconnected every ~3.5 s for hours. See below | none yet |

## LID ↔ phone pairs (`2.4.0-rc2-nyxus.2`)

- `patches/baileys+7.0.0-rc.9+002+lid-pn-mappings.patch` ports Baileys `a89736f` (#2268), `f829b6d` (#2282) and the `process-message` part of `fa2a837` (#2316). On every history-sync chunk it reads the pairs from `HistorySync.phoneNumberToLidMappings` (field 15), from `pnJid`/`lidJid` on each conversation, and from `userReceipt` on the number's own messages, and stores them in the auth-state `lid-mapping` keys before `messaging-history.set` is emitted. It logs one count-only line per chunk: `[nyxus] lid-pn mappings from history sync (type N): X from phoneNumberToLidMappings, Y from conversations, Z valid pairs stored`.
- `POST /chat/findLidPhones/{instance}` with `{ "lids": ["123@lid"] }` (1 to 200 distinct LID JIDs) answers `{ "phones": { "123@lid": "5511…@s.whatsapp.net" | null } }`. It reads only the local `lid-mapping` store (`getPNForLID`), never WhatsApp, and logs counts only.
- Drop the patch when Baileys is bumped to `7.0.0-rc10` or later; `patches/baileys+7.0.0-rc.9+001+initial.patch` is the older waveform fix and is unrelated. Keep the endpoint until upstream Evolution ships an equivalent.

## History batches (`2.4.0-rc2-nyxus.3`)

- Messages whose type `getContentType` cannot tell (`messageHistoryNotice`, `messageHistoryBundle`, `callLogMesssage`, `messageContextInfo`/`senderKeyDistributionMessage` only) or that miss another required `Message` column are not stored; history logs one line per batch: `History sync: skipped N of M messages that cannot be stored: {"messageType missing [messageContextInfo+messageHistoryNotice]": N}`.
- A failed bulk insert (history messages and chats, `chats.upsert`, `contacts.upsert`, `contacts.update`) is retried in chunks of 500 and then row by row; only the failing rows are lost, logged as `... N of M ... not saved: {"<error class> <code> (<field>)": N}`, never content. In `messages.upsert` a failed insert skips only that message.
- `npx tsx --test test/messagePersistence.test.ts`; set `TEST_DATABASE_CONNECTION_URI` to a throwaway Postgres to run the database cases.

## Reconnection (`2.4.0-rc2-nyxus.4`)

Paired means pair-success wrote `creds.me` and `creds.account` (`isPaired`); a pairing-code instance gets `creds.me` before the phone confirms, so it stays in the QR/pairing phase until then. The decision is `decideReconnect` in `helpers/reconnectPolicy.helper.ts`.

| Code | Baileys | Unpaired (QR/pairing phase, as upstream) | Paired |
| --- | --- | --- | --- |
| any, first close before a QR code | | wait for the QR code | (not used) |
| 401 | `loggedOut` | end the attempt | log out: credentials removed |
| 402 | connection failure: temporary ban | end the attempt | stop: closed, credentials kept |
| 403 | `forbidden` (main device gone) | end the attempt | log out: credentials removed |
| 406 | connection failure: unknown logout | end the attempt | log out: credentials removed |
| 408 | `connectionLost` / `timedOut` (also "QR refs attempts ended") | end the attempt (no QR loop) | reconnect with backoff |
| 440 | `connectionReplaced` (`stream:error conflict`) | reconnect after 3 s | reconnect with backoff; the 5th replacement without a stable open stops: closed, credentials kept |
| 411, 428, 500, 503, 515, none, other | `multideviceMismatch`, `connectionClosed`, `badSession`, `unavailableService`, `restartRequired` | reconnect after 3 s | reconnect with backoff |

- Backoff: 2 s doubling to 60 s, minus up to 20% jitter, with no attempt limit. An open that lasts 3 minutes, or a manual `/instance/connect`, resets the attempts and the 440 count. While a reconnect is scheduled the instance state reads `connecting`.
- Log out: as upstream, `STATUS_INSTANCE` closed, `connectionStatus: close`, `logout.instance` (session removed, `LOGOUT_INSTANCE` webhook), `CONNECTION_UPDATE` close with the code. Stop: the same without `logout.instance`, so `/instance/connect` reconnects with the stored session; the instance is not auto-connected on the next restart.
- A paired instance whose first connection after a restart closes now reconnects (upstream left it closed: `!wuid && qrcode.count === 0`).
- A new socket ends the previous one, and updates from a replaced socket are ignored, so two sockets on the same credentials cannot replace each other forever.
- One line per decision, no content: `Reconnect decision: instance=<name> code=<code> paired=<bool> action=<reconnect|stop|logout|wait|ignore> attempt=<n> [replaced=<n>] [nextDelayMs=<ms>]`.
- `npx tsx --test test/reconnectPolicy.test.ts`.

The upstream workflows are removed on this branch. `nyxus-image.yml` builds `ghcr.io/nyxus-cloud/evolution-api` when a tag like `2.4.0-rc2-nyxus.1` is pushed. The `version` in `package.json` (shown by `GET /`) carries the same `-nyxus.<n>` suffix.

## Updating

1. `git fetch upstream --tags`
2. Create `nyxus/<version>` from the new upstream tag and cherry-pick the commits above that the release still lacks.
3. Push the branch and a tag `<version>-nyxus.<n>`.
