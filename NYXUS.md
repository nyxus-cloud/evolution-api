# Nyxus fork

This fork exists only to ship fixes that upstream has not released yet. Use the official image again as soon as a release carries them.

Branch `nyxus/2.4.0-rc2` is the `2.4.0-rc2` tag plus:

| Commit | Why | Upstream |
| --- | --- | --- |
| `fix(whatsapp): restore reply/quote contextInfo in prepareMessage` | rc2 reads `contextInfo` from `messageContextInfo`, so mentions and replies never reach webhooks or storage | PR #2654, issue #2713 |
| `fix(security): bind every request to the authenticated instance` | query or body fields can no longer override the instance in the path | `release/2.3.8` |
| `fix(security): keep the body name on instance create` | follow-up to the fix above | `release/2.3.8` |
| `feat(chat): keep history LID-phone pairs and look them up` | Baileys rc.9 drops the LID ↔ phone pairs of the history sync, so chats with non-contacts stay LID-only. See below | Baileys PRs #2268, #2282, #2316 (in `7.0.0-rc10`) |

## LID ↔ phone pairs (`2.4.0-rc2-nyxus.2`)

- `patches/baileys+7.0.0-rc.9+002+lid-pn-mappings.patch` ports Baileys `a89736f` (#2268), `f829b6d` (#2282) and the `process-message` part of `fa2a837` (#2316). On every history-sync chunk it reads the pairs from `HistorySync.phoneNumberToLidMappings` (field 15), from `pnJid`/`lidJid` on each conversation, and from `userReceipt` on the number's own messages, and stores them in the auth-state `lid-mapping` keys before `messaging-history.set` is emitted. It logs one count-only line per chunk: `[nyxus] lid-pn mappings from history sync (type N): X from phoneNumberToLidMappings, Y from conversations, Z valid pairs stored`.
- `POST /chat/findLidPhones/{instance}` with `{ "lids": ["123@lid"] }` (1 to 200 distinct LID JIDs) answers `{ "phones": { "123@lid": "5511…@s.whatsapp.net" | null } }`. It reads only the local `lid-mapping` store (`getPNForLID`), never WhatsApp, and logs counts only.
- Drop the patch when Baileys is bumped to `7.0.0-rc10` or later; `patches/baileys+7.0.0-rc.9+001+initial.patch` is the older waveform fix and is unrelated. Keep the endpoint until upstream Evolution ships an equivalent.

The upstream workflows are removed on this branch. `nyxus-image.yml` builds `ghcr.io/nyxus-cloud/evolution-api` when a tag like `2.4.0-rc2-nyxus.1` is pushed. The `version` in `package.json` (shown by `GET /`) carries the same `-nyxus.<n>` suffix.

## Updating

1. `git fetch upstream --tags`
2. Create `nyxus/<version>` from the new upstream tag and cherry-pick the commits above that the release still lacks.
3. Push the branch and a tag `<version>-nyxus.<n>`.
