# Linux CI on an independent build provider

This entrypoint runs real commands and publishes a static report of their results.
It is a Linux subset of Poki verification. It does not replace Windows execution,
macOS/Xcode builds, signing, physical-phone acceptance, or promotion approvals.
The existing phone relay in `deploy/cf-relay` is unchanged.

## Pages configuration

Use a separate Cloudflare Pages project connected to the intended GitHub repository.
No account or repository numeric IDs belong in these files.

- Root directory: repository root.
- Build command: `bash bin/ci/bootstrap-ubuntu.sh --repository dev-james0723/poki`.
- Build output directory: `.ci-output`.
- Node: configure Node 24 or newer in the provider's build image.
- Rust: this entrypoint uses `1.99.1`, matching the verified local toolchain.
- Optional first-build pin: `POKI_CI_EXPECTED_SHA=<full expected commit>`.
- Optional system-package installation: `POKI_CI_INSTALL_PACKAGES=1`, only when
  the actual build image provides root or passwordless sudo.

The root `.gitignore` excludes the generated `.ci-output/` directory.
The runner refuses an output path that Git does not ignore, an already existing
output directory, a dirty checkout, or an entrypoint outside the tested checkout.

Pages must supply `CF_PAGES_COMMIT_SHA`; it must equal `git rev-parse HEAD`.
If `POKI_CI_EXPECTED_SHA` is present, that must match too. Remove this temporary
pin after the first verified deployment so later commits do not fail against an
old expected SHA. Outside Pages, pass `--expected-commit <full SHA>` explicitly.

Do not remove the GitHub PR trigger or required checks merely because the project
was created. First observe an actual Pages build, inspect its source SHA and build
result through the authenticated API, fetch that deployment's `report.json`, and
confirm the matching commit, all required checks, pipeline hash and exclusions.
Use the deployment URL for that build: a production alias can still serve an older
passing commit after a later build fails. Configure equivalent PR status reporting
and required contexts before retiring the previous checks.

## Bootstrap requirements

Ubuntu build images need Git, curl, Python 3, pkg-config, a C/C++ compiler, CMake,
CA certificates and the DBus development package (`libdbus-1-dev`). Neither sudo
nor those packages is assumed to exist. Bootstrap checks them. If anything is
missing and package installation is unavailable, it exits nonzero with a precise
prerequisite message. It never disables default Rust features to make a build pass.

Rustup installs the named `1.99.1` toolchain without changing the default toolchain.
If Rustup is absent, bootstrap downloads the pinned `1.29.3` installer and verifies
its official SHA-256 before executing it. Actionlint `1.7.7` uses the official
release archive and verifies its matching checksum before extraction/execution.
Checksum retrieval fails closed; no downloaded script runs before verification.
Rustup/bootstrap downloads need public network access;
a pre-provisioned, pinned build image can supply these tools instead. The runner
checks the versions actually selected. Node must be provided before bootstrap.

Cold Cargo dependency builds may exceed the provider's build-time allowance.
Measure the first real run and configure legitimate dependency caches or a suitable
build environment if needed. A timeout is a failure, never grounds to omit a gate.

No phone pairing, Cloudflare API token, Apple account, signing key or production
relay secret is needed by these commands. Do not add those secrets to the build.

## Checks and order

`bin/ci/policy.mjs` is the fixed command manifest. The runner checks both Cargo
lockfiles before Cargo tests, prepares the launcher's pinned patched dependency,
and uses `--locked` for every metadata/test command. This preserves the old
independent-checkout lockfile guarantee when commands share one workspace.

The original Linux checks remain: Poki Setup core/CLI tests with default features
and `POKI_SETUP_FILE_SECRETS=1`, desktop/launcher lockfiles, Actionlint, release shell
and Python syntax, and channels JSON validation. Python compilation uses a private
temporary output path rather than modifying a source directory.

Additional explicitly selected checks are:

- `test/cli-session.test.mjs`: real CLI/stdio/coordinator against a synthetic
  loopback-only endpoint with a dispatcher that cannot operate a phone.
- The three `bin/dual-phone/*.test.mjs` suites: synthetic sessions, visual-runner
  boundaries and native interval analysis.
- `test/native-build-receipt.test.py`: temporary synthetic source trees and
  candidate executables; no actual native bridge invocation. `python3 -I -B`
  also prevents imported helper bytecode from polluting the checked-out source.
- `test/ci-linux.test.mjs`: source identity, lock ordering, nonzero completed test
  evidence, fixed coverage and public-report escaping.

The whole root `npm test` suite is deliberately outside this subset. The Windows
GSA job remains separate: running related logic on Linux does not prove Windows
compilation or execution. Rust tests that the source marks ignored are reported
as ignored; zero executed tests, failures or filtered test runs cannot pass. The
selected Node/Python suites must have nonzero tests with no skip/cancellation.

## npm lifecycle and native dependency handling

The CLI fixture imports `src/tools.mjs`, which imports `src/cua.mjs` and `sharp`.
The root lockfile pins Sharp `0.34.5` and includes Linux optional binary packages.
This is why dependencies cannot simply be omitted for the new Node tests.

The chosen install command is:

```sh
npm ci --ignore-scripts --include=optional --no-audit --no-fund
```

It suppresses dependency lifecycle execution while retaining optional platform
packages. An actual Sharp synthetic-PNG operation and SDK import probe runs next;
if the installed Linux binary cannot load, the build fails. This has to be verified
on the actual Pages image before claiming compatibility. Do not silently switch
to unreviewed install scripts, omit Sharp, or skip the CLI regression on failure.

## Report and trust boundary

The runner writes `.ci-output/report.json` and `.ci-output/index.html` with exclusive
creation and exits nonzero if any check fails, is missing or has unverified test
summary output. The report binds a run UUID, full source commit, repository label,
fixed command manifest hash, CI source hashes, selected tool versions, exact check
results, test counts and explicit exclusions. It checks source cleanliness again
after execution. Raw logs stay in temporary build storage and the build console;
only their digests and lengths appear in the static report.

This is an execution report, not a cryptographic attestation. A successful HTTP
upload to a receipt Worker would prove only receipt acceptance. No such Worker is
needed here: Pages executes the real build command and publishes its static output.
Verify its authenticated build result and source SHA independently. A later optional
receipt service would need immutable atomic insertion by repository/commit/run ID,
idempotent identical submissions, rejection of conflicting writes, fixed coverage
validation and a trusted provider-run verification before posting any green status.
It must never mark tests passed merely because a POST was accepted.
