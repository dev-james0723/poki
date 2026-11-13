# Release channels

Poki's iPhone builds are published as GitHub Releases on this repository. Poki Setup (the desktop
installer) reads them and lets each person pick a channel in Settings. A channel decides which
releases Poki Setup installs and renews with.

| Channel | Tag | Title | GitHub release | Who it is for |
| --- | --- | --- | --- | --- |
| Stable | `app-X.Y.Z` | Poki v0.3.0 | its own full release (not marked Latest) | everyone |
| Beta | `app-X.Y.Z-beta.K` | Poki v0.3.0 Beta 1 | its own prerelease | testers |
| Alpha | `app-X.Y.Z-alpha.N` | Poki v0.3.0 (712) Alpha | rolling `app-alpha-latest`, prerelease | early testers |
| Pre-alpha | `app-X.Y.Z-prealpha.N` | Poki v0.3.0 (712) Pre-alpha | rolling `app-prealpha-latest`, prerelease | developers |

A channel includes the channels above it: Beta installs the newest Stable or Beta release, Alpha
the newest Stable, Beta or Alpha, and Pre-alpha the newest release of any kind. Poki Setup's own
updates (`desktop-v*`, `desktop-alpha-*` and `desktop-prealpha-*` tags) follow the same channel.
Poki Setup orders versions so that `0.3.0-beta.1 < 0.3.0-beta.2 < 0.3.0 < 0.3.0-712`: a pre-release
suffix sorts below the plain version, a build number above it.

Until November 2026 app releases were tagged `ios-vX.Y.Z`, `ios-vX.Y.Z-beta.K`, `ios-alpha-X.Y.Z-N` and
`ios-prealpha-X.Y.Z-N`; Poki Setup reads both schemes. Poki Setup 0.2.2 and earlier read only the old
ones, so every pre-alpha and alpha is also copied into the old rolling releases `ios-prealpha-latest`
and `ios-alpha-latest`, which carry the Poki Setup update too. That copy stops once those versions
are gone. Betas and stables exist only as `app-*`.

N is the commit count of the built commit on `main`, so it only goes up while `main` is never
rewritten. Betas and stables drop it from their names; inside the app, `CFBundleVersion` still
carries it.

## One build, promoted

Only the pre-alpha step compiles. Each promotion copies that same IPA to the next channel, so
testers on Alpha run the file that was tried on Pre-alpha, and Beta runs the file the Gym scored.

1. **Pre-alpha, automatic.** Every merge into `main` runs `.github/workflows/prealpha.yml`: one
   macOS job builds the external IPA, tags `app-<VERSION>-prealpha.<N>` and replaces the files of
   `app-prealpha-latest`. Its artifact is kept 90 days for later promotions.
2. **Alpha, after approval.** Actions > Promote to Alpha > Run workflow (`promote-alpha.yml`), with a
   pre-alpha tag or empty for the current one. It runs the alpha tests on that commit (`ios-app.yml`:
   PokiCore and loopback tests, in-process field, apps and idle-cycle checks, simulator smoke test,
   agent chat end to end; Poki Setup's core tests), then waits for approval in `alpha`, tags `app-<VERSION>-alpha.<N>` and puts the
   pre-alpha's IPA and Poki Setup files into `app-alpha-latest`.
3. **Beta, by PR.** Actions > Propose promotion > beta (`propose-promotion.yml`), with an alpha tag or
   empty for the current Alpha. The Poki Release Bot opens a PR that adds the promotion to
   `.github/channels.json` and moves `native/ios-app/VERSION` to the next patch version. The PR's
   `promotion gate` check (`promotion-gate.yml`) runs the Gym on that commit and passes when neither
   scorecard has more failures than the last beta's. Merging waits for approval in `beta`, then publishes `app-X.Y.Z-beta.K`
   (`publish-promotion.yml`) with the scorecards attached, and creates `release/X.Y` on a version's
   first beta.
4. **Stable, by PR.** Propose promotion > stable, with a beta tag or empty for the newest beta. The
   gate passes once that beta has been out for `soak_days` (3, in `.github/channels.json`) and no
   issue labelled `blocker` is open. To ship sooner, add the `soak-override` label to the PR, or give
   a reason in the proposal's skip field (it is kept in `channels.json`). Merging publishes
   `app-X.Y.Z` after approval in the `stable` environment.

Every publish creates a draft first, checks its file count, then publishes. Releases carry
`Poki-external-<name>.ipa`, `Poki-signing.zip`, `poki-relay-worker.js` (the relay Worker Poki Setup
deploys) and `SHA256SUMS`, plus Poki Setup's `PokiSetup-*` installers and `SHA256SUMS-desktop.txt`.

## Branches

- `main`: trunk; submit changes through PRs. Every merge is a pre-alpha.
- `dev/<topic>`: one change, one PR into `main`, deleted on merge.
- `release/X.Y`: from a version's first beta; takes cherry-picked fixes from `main` for later betas
  and X.Y.Z hotfixes.
- `promote/<channel>-<version>`: the bot's promotion PRs.

## Checks

Cloudflare Pages runs the Linux CI command in [ci-linux.md](ci-linux.md) for branch pushes
and reports the native `Cloudflare Pages` check against the tested commit. It covers Poki Setup's
core/CLI tests, both Rust lockfiles, workflows, release-script syntax, and selected CLI/dual-phone
regressions. It does not consume GitHub Actions runners.

`pr-checks.yml` is now manual (`workflow_dispatch`, named `Manual compatibility checks`).
It retains the Windows authentication job for an explicitly requested compatibility run.
A passing Linux check does not prove Windows execution, macOS/iOS builds, or physical-phone
acceptance. Release and promotion workflows remain subject to their existing approval rules.

## Setup (once)

- A GitHub App for the bot (Contents, Pull requests and Workflows read and write; Actions and Checks
  read), installed on this repository, with its id and private key in the Actions secrets
  `POKI_BOT_APP_ID` and `POKI_BOT_PRIVATE_KEY`.
- Labels `promotion`, `soak-override` and `blocker`.
- The `alpha`, `beta`, and `stable` environments are configured with `JosssphZhou` as the only
  required reviewer and administrator bypass disabled. Self-review prevention is off so the owner
  can approve a run they started. Agents must not approve on the owner's behalf.
  See [GitHub's environment setup](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
- For branch protection on `main`, require the native `Cloudflare Pages` check from the verified
  Pages integration for Linux CI and retain `promotion gate / verdict`. Preserve any separately
  required Windows validation; the Linux status cannot replace it. Migrate check contexts only
  after verifying the new provider reports on the intended commit.

## Fallback

`channel-release.yml` still builds from a pushed alpha or pre-alpha tag
(`native/ios-app/scripts/cut-release.sh`). Its publish job uses `alpha` only for alpha tags. Pre-alpha tags publish without environment approval.
It starts with cold caches (about 20 minutes) and will be
removed once the pipeline above has shipped a few builds.

The Mac server's update notice (`src/update-check.mjs`) reads `releases/latest` and only understands
Poki MCP's `vX.Y.Z` tags, so app releases are never marked Latest: Latest stays on Poki MCP's newest
release.

## Approval coverage

Publishing Alpha, Beta, Stable, or uploading installers requires the repository owner's approval.
The two Promote to Alpha workflows use `alpha`. The tag fallback selects `alpha` for Alpha and no
environment for Pre-alpha. Main Pre-alpha builds and publishes automatically without approval.
Beta and Stable use their respective environments in `publish-promotion.yml`.
The Windows installer job uses `stable`, including artifact-only runs, because its optional release
upload shares the build job. The macOS installer workflow only uploads Actions artifacts.

These rules protect the workflows that reference the environments. Manual Release uploads and
workflow edits remain outside this gate. An agent using the owner's credentials is not a separate
GitHub identity. Keep approval in the owner's hands.
