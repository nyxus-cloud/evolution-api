# Nyxus fork

This fork exists only to ship fixes that upstream has not released yet. Use the official image again as soon as a release carries them.

Branch `nyxus/2.4.0-rc2` is the `2.4.0-rc2` tag plus:

| Commit | Why | Upstream |
| --- | --- | --- |
| `fix(whatsapp): restore reply/quote contextInfo in prepareMessage` | rc2 reads `contextInfo` from `messageContextInfo`, so mentions and replies never reach webhooks or storage | PR #2654, issue #2713 |
| `fix(security): bind every request to the authenticated instance` | query or body fields can no longer override the instance in the path | `release/2.3.8` |
| `fix(security): keep the body name on instance create` | follow-up to the fix above | `release/2.3.8` |

The upstream workflows are removed on this branch. `nyxus-image.yml` builds `ghcr.io/nyxus-cloud/evolution-api` when a tag like `2.4.0-rc2-nyxus.1` is pushed.

## Updating

1. `git fetch upstream --tags`
2. Create `nyxus/<version>` from the new upstream tag and cherry-pick the commits above that the release still lacks.
3. Push the branch and a tag `<version>-nyxus.<n>`.
