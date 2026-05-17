# Publishing & distribution

SYROTP today is distributed only from GitHub — `git clone`, `git tag`,
GitHub Release. This document is the runbook for the v0.7 track,
which gets each official package onto its native registry (npm, PyPI,
Packagist, Maven Central, Swift Package Registry, pub.dev) one
ecosystem at a time.

For **when** to bump a version, see
[`sdk-versioning.md`](sdk-versioning.md). This doc covers **where**
each package lives, **who** owns the namespace, **how** the
publishing flow works, and the **dry-run commands** to validate a
package before it goes live.

## Status

| State | What's true today |
| --- | --- |
| GitHub Release | ✅ tagged automatically by the `Release` workflow on `vX.Y.Z` |
| GitHub Source | ✅ public at `github.com/SYR-ROOT/syrotp` |
| npm | 🟡 dry-run wired (v0.7 PR 2 — `npm-dry-run` CI job validates metadata + tarball on every PR / push to `main`); real publishing pending registry-ownership checklist |
| PyPI | 🟡 dry-run wired (v0.7 PR 4 — `pypi-dry-run` CI job builds wheel + sdist and runs `twine check`; real publishing pending registry-ownership checklist) |
| Packagist | 🟡 dry-run wired (v0.7 PR 5 — `packagist-dry-run` CI job runs `composer validate --strict` + `composer install --no-dev` for both `syrotp/sdk` and `syrotp/laravel`; real publishing is just a Packagist webhook on the GitHub repo + a git tag — no token needed) |
| Maven Central | 🟡 dry-run wired (v0.7 PR 6 — `maven-dry-run` CI job runs `gradle publishToMavenLocal` for `dev.syrotp:sdk-kotlin` and `dev.syrotp:android-ui`; real Sonatype publishing pending registry-ownership checklist + GPG signing key + Sonatype credentials) |
| Swift Package Registry | 🟡 dry-run wired (v0.7 PR 7 — `swift publish dry-run` CI job runs `swift package describe` for both `SyrotpSDK` and `SyrotpSwiftUI` on macos-14; SwiftPM via git tag works today, no real registry upload) |
| pub.dev (Flutter) | 🟡 dry-run wired (v0.7 PR 7 — `flutter publish dry-run` CI job runs `flutter pub publish --dry-run` for `syrotp_flutter`; real publishing pending registry-ownership checklist + Google OAuth) |

Packages today install via git submodule, vendoring, or
language-native git-URL fetch (`pnpm add github:SYR-ROOT/syrotp`,
`pip install git+https://github.com/SYR-ROOT/syrotp.git#subdirectory=packages/sdk-python`,
SwiftPM with the GitHub URL, Flutter `dependency_overrides`, etc.).
Workable but unergonomic — v0.7 fixes that.

## Package map

This is the canonical list of SYROTP-published artifacts. If a
package isn't on this table, it's internal-only.

| Local path | Published name | Registry | Notes |
| --- | --- | --- | --- |
| `packages/sdk-js/` | `@syrotp/sdk` | npm | server SDK for JS / TS |
| `packages/react/` | `@syrotp/react` | npm | React verification component |
| `packages/web-component/` | `@syrotp/web-component` | npm | framework-agnostic Custom Element |
| `packages/cli/` | `@syrotp/cli` | npm | operator CLI (`syrotp`) |
| `packages/sdk-python/` | `syrotp-sdk` | PyPI | extras: `[fastapi]`, `[django]` |
| `packages/sdk-php/` | `syrotp/sdk` | Packagist | server SDK for PHP |
| `packages/sdk-php-laravel/` | `syrotp/laravel` | Packagist | Laravel ServiceProvider + Facade |
| `packages/sdk-kotlin/` | `dev.syrotp:sdk-kotlin` | Maven Central | Kotlin/JVM SDK |
| `packages/android-ui/library/` | `dev.syrotp:android-ui` | Maven Central | Android Compose UI |
| `packages/sdk-swift/` | `SyrotpSDK` | Swift Package Registry (and git-tag SwiftPM) | Apple platforms + Linux |
| `packages/swift-ui/` | `SyrotpSwiftUI` | Swift Package Registry (and git-tag SwiftPM) | iOS + macOS |
| `packages/flutter/` | `syrotp_flutter` | pub.dev | Flutter widget |

Internal-only (NOT for publication):
- `apps/server/` — the SYROTP server. Distributed as Docker image / git source. Operators run it themselves.
- `apps/gsm-gateway/` — the Python GSM gateway. Distributed as git source; operators install on the device hosting the modem.
- `tools/loadtest/`, `examples/*` — dev tooling, never published.

## Versioning policy

Per [`sdk-versioning.md`](sdk-versioning.md):

- **Protocol version** (`openapi.yaml` `info.version`) is the slowest-moving — bumps only when the wire format changes.
- **Server version** (the GitHub release tag `vX.Y.Z`) bumps on every server-side change.
- **Package versions** (each manifest's `version`) bump independently per package, on package-local changes only.

The `vX.Y.Z` tag is a **release bundle marker** — it pins the set of
package versions shipping together — but each package keeps its own
SemVer line. A package whose code didn't change between two server
releases keeps its previous version; users `pnpm install`/`pip
install` a specific version, not a release tag.

When a package needs a release for the first time after v0.7 lands,
its initial published version is the version recorded in its
manifest. After that, every code change to a package MUST be
accompanied by a manifest version bump (PATCH / MINOR / MAJOR per
the SDK versioning rules) in the same PR that lands the change.

## Registry ownership checklist

Before flipping a registry from "dry-run only" to "publishes on
release," every box below MUST be checked. Each per-registry PR
(v0.7 PRs 2–6) is responsible for closing this checklist for its
registry.

- [ ] Organization / namespace claimed and verified
  - npm `@syrotp` scope
  - PyPI `syrotp-sdk` package + `syrotp` username (PEP 541)
  - Packagist `syrotp` vendor namespace
  - Sonatype `dev.syrotp` and `io.syrotp` group ids (Maven Central)
  - GitHub repository attestation (Swift Package Registry uses GitHub identity)
  - pub.dev verified publisher `syrotp.dev` (or operator-owned domain)
- [ ] At least two maintainers with publish rights
- [ ] MFA / 2FA enforced for every maintainer account where the registry supports it (npm: yes; PyPI: yes; Packagist: yes via GitHub login; Sonatype: hardware token; pub.dev: yes via Google account)
- [ ] CI publishing token issued, scoped to **publish-only** (no admin / no delete)
- [ ] Token rotation policy: rotate every 12 months, or immediately on suspected compromise
- [ ] Local dev environment cannot publish — no `~/.npmrc`, `~/.pypirc`, GPG keys committed to the repo
- [ ] Pre-publish checklist (next section) green for every package in scope

## Pre-publish checklist (per package)

Every package MUST satisfy this before its first publish:

- [ ] `LICENSE` file shipped inside the published tarball (not just the root `LICENSE`)
- [ ] `README.md` renders well on the registry's web UI — relative repo links converted to absolute, badge URLs reachable
- [ ] Description / keywords / topics populated (improves discoverability + the "why is this package here" surface)
- [ ] Repository / homepage / bug-tracker URLs in the manifest
- [ ] Manifest version matches the change being shipped (per `sdk-versioning.md`)
- [ ] CHANGELOG entry under the right version. The repo-wide `CHANGELOG.md` at root is the source of truth; a per-package `CHANGELOG.md` is optional and SHOULD just link upward
- [ ] Published files include only what consumers need — `dist/` / `lib/` / wheel / AAR / xcframework, README, LICENSE. Tests, fixtures, examples, source maps with absolute paths: NO
- [ ] No secrets or `.env*` files
- [ ] Generated artifacts deterministic — same input, same hash (npm uses `--reproducible-zip`; Gradle has `isReproducibleFileOrder`; Python wheels with `SOURCE_DATE_EPOCH`)

## Tokens & secrets

Each registry token lives under a fixed CI secret name:

| Registry | Secret name | Token type |
| --- | --- | --- |
| npm | `SYROTP_NPM_TOKEN` | publish-only granular access token, scoped to `@syrotp/*` |
| PyPI | `SYROTP_PYPI_TOKEN` | API token scoped to `syrotp-sdk` only |
| Packagist | `SYROTP_PACKAGIST_API_TOKEN` | API token + Packagist-side webhook (no per-package token; webhook re-pulls from GitHub) |
| Sonatype (Maven) | `SYROTP_SONATYPE_USERNAME` + `SYROTP_SONATYPE_PASSWORD` + `SYROTP_SIGNING_KEY` + `SYROTP_SIGNING_PASSWORD` | Sonatype user token + GPG signing key |
| Swift Package Registry | None — uses GitHub OIDC for identity | n/a |
| pub.dev | `SYROTP_PUBDEV_AUTHJSON` | Google OAuth refresh token via `dart pub token` |

Rules:

- Tokens are loaded as `${{ secrets.SYROTP_*_TOKEN }}` directly into the publishing step's env. Never echo. Never paste into a `run:` script that logs its inputs.
- Publish steps run only on tagged `vX.Y.Z` workflows (no PR runs, no main-branch pushes). The tag pattern check is the gate.
- Local development MUST NOT have publish credentials configured. The repo's `.gitignore` blocks `.npmrc`, `.pypirc`, `gradle.properties` with credentials, GPG keys, etc.
- Token rotation is a runbook step, not an automated one — see the "Operator runbook" section in [`operations.md`](operations.md).

## Dry-run commands

Run these locally before any release. They validate the package
metadata, build, and would-be uploaded artifact without touching the
registry.

### npm — `@syrotp/sdk`, `@syrotp/react`, `@syrotp/web-component`, `@syrotp/cli`

```bash
# Per package
pnpm --filter @syrotp/sdk           publish --dry-run --no-git-checks
pnpm --filter @syrotp/react         publish --dry-run --no-git-checks
pnpm --filter @syrotp/web-component publish --dry-run --no-git-checks
pnpm --filter @syrotp/cli           publish --dry-run --no-git-checks
```

What it checks:
- `package.json` is valid
- `files` glob produces a non-empty tarball
- `name` / `version` / `main` / `exports` resolve
- No private dependencies leak

Wired in CI as the `npm dry-run` job (`.github/workflows/ci.yml`)
for `@syrotp/sdk`, `@syrotp/react`, and `@syrotp/web-component` —
runs on every PR + push to `main`. `@syrotp/cli` is still a dev tool
internally and is not yet in the dry-run job; it'll join when CLI
publishing is opened.

### PyPI — `syrotp-sdk`

```bash
cd packages/sdk-python
python -m build           # produces dist/*.whl + dist/*.tar.gz
twine check dist/*        # validates README rendering + metadata
```

Wired in CI as the `pypi dry-run` job (`.github/workflows/ci.yml`)
— runs on every PR + push to `main`. Uses Python 3.12 +
`build`/`twine` from PyPI.

**PEP 639 note**: `pyproject.toml` declares `license = "MIT"` (SPDX
expression) and `license-files = ["LICENSE"]`. setuptools 77+
rejects the combination of an SPDX `license` field AND a
`License :: OSI Approved :: ...` classifier — they're mutually
exclusive in the new PEP 639 world. The OSI classifier was
intentionally dropped from the classifiers list. The license is
still discoverable via the SPDX field; PyPI's metadata UI surfaces
it the same way.

Optional but recommended:
```bash
pip install dist/syrotp_sdk-*.whl --force-reinstall
python -c "import syrotp; print(syrotp.__version__)"
```

### Packagist — `syrotp/sdk`, `syrotp/laravel`

Packagist mirrors GitHub — there's no upload step. Validation is
on `composer.json` + a clean install:

```bash
cd packages/sdk-php
composer validate --strict --no-check-lock --no-check-publish
composer install --no-dev --prefer-dist

cd packages/sdk-php-laravel
composer validate --strict --no-check-lock --no-check-publish
composer install --no-dev --prefer-dist
```

Wired in CI as the `packagist dry-run` job
(`.github/workflows/ci.yml`) — runs on every PR + push to `main`.

**Composer-strict notes:**
- The `version` field has been removed from both `composer.json`
  files. `composer validate --strict` flags a hardcoded `version`
  in a Packagist-published library because Packagist always
  infers the version from git tags — keeping the field would
  fail strict validation forever.
- `syrotp/laravel` resolves `syrotp/sdk` locally via a `path` repo
  override at `repositories[].options.versions = { "syrotp/sdk":
  "0.1.0" }` so the absent `version` field in `syrotp/sdk` doesn't
  break local development. The `repositories` block in a library
  is NOT propagated to consumers — Composer only honors the root
  `composer.json`'s repositories — so when the Laravel package
  publishes, real consumers still resolve `syrotp/sdk` from
  Packagist normally.

### Maven Central — `dev.syrotp:sdk-kotlin`, `dev.syrotp:android-ui`

Stage the artifact into the local Maven repo to verify the POM,
artifacts, and signatures (signing test runs only when a key is
present locally):

```bash
cd packages/sdk-kotlin
gradle publishToMavenLocal --no-daemon

cd packages/android-ui
gradle :library:publishToMavenLocal --no-daemon
```

Wired in CI as the `maven dry-run` job
(`.github/workflows/ci.yml`) — runs on every PR + push to `main`.
Uses Java 17 + `android-actions/setup-android@v3` so the Android
SDK is available for the `:library` module.

**Maven coordinates** (intentional):
- `dev.syrotp:sdk-kotlin` — the JVM SDK. Note: the Java package is
  `io.syrotp.sdk` and stays that way. Maven group != Java package
  is normal in big projects (Sentry's `io.sentry:sentry` etc.) —
  renaming the Java package would be a breaking change for every
  downstream `import io.syrotp.sdk.*`.
- `dev.syrotp:android-ui` — the Compose UI library AAR.

The version is `0.0.0-dev` until the first real Maven Central
release. The actual Sonatype upload is a separate
`publishToSonatype` task that requires a GPG signing key + Sonatype
credentials — NOT run during dry-run.

### Swift Package Registry — `SyrotpSDK`, `SyrotpSwiftUI`

Apple's registry uses git tags directly — there's no separate upload
step. Validation is the package metadata:

```bash
cd packages/sdk-swift
swift package describe

cd packages/swift-ui
swift package describe
```

What it checks:
- `Package.swift` is valid
- Targets resolve
- Platform constraints are well-formed

Wired in CI as the `swift publish dry-run` job
(`.github/workflows/ci.yml`) — runs on macos-14 (swift-ui imports
SwiftUI which doesn't compile on Linux; sdk-swift could run on
Linux but we keep both on macOS for consistency).

### pub.dev — `syrotp_flutter`

```bash
cd packages/flutter
flutter pub publish --dry-run
```

What it checks:
- `pubspec.yaml` validates
- `LICENSE`, `README.md`, `CHANGELOG.md` present
- Files included match `.pubignore`
- Score-impacting hints (links, description length, etc.)

Wired in CI as the `flutter publish dry-run` job
(`.github/workflows/ci.yml`) — runs on Linux via
`subosito/flutter-action@v2` on every PR + push to `main`.

**Per-package CHANGELOG required:** pub.dev rejects packages
without a `CHANGELOG.md` inside the package directory. The
package's `CHANGELOG.md` is a thin file that tracks just
`syrotp_flutter`'s versions and links upward to the repo-wide
`CHANGELOG.md` for the full project history. Don't merge the
two — pub.dev parses the package's CHANGELOG for the
"Changelog" tab on its package page.

**`topics`** in `pubspec.yaml` (`otp`, `sms`, `verification`,
`syrotp`, `reverse-otp`) drive pub.dev's discoverability. Max 5
topics per package, lowercase, hyphens allowed.

## Release flow

### Today (post-v0.6.0)

1. Maintainer pushes `vX.Y.Z` tag from `main`.
2. `Release` workflow (`.github/workflows/release.yml`) creates the GitHub Release from the tag, attaching the changelog excerpt.
3. `Release-baseline` workflow (`.github/workflows/release-baseline.yml`) runs the full loadtest suite as the release-quality gate.
4. **Nothing else publishes.** Users install from the GitHub source.

### After v0.7 (registry by registry)

Each registry gets its own publish job in `release.yml`, gated by:

- Tag pattern: `v[0-9]+.[0-9]+.[0-9]+` (no pre-releases, no `-rc.X`)
- All checks on `main` + `release-baseline` green for the tagged commit
- Manual approval (initially — once we trust the pipeline, individual jobs can flip to automatic)

Each job pattern:

```yaml
release-npm:
  runs-on: ubuntu-latest
  needs: [release-baseline]
  if: startsWith(github.ref, 'refs/tags/v')
  environment: production-npm   # GitHub Environment with manual-approve gate
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 20
        registry-url: https://registry.npmjs.org
    - run: pnpm install --frozen-lockfile=false
    - run: pnpm build
    - run: pnpm --filter "@syrotp/*" publish --access public --no-git-checks
      env:
        NODE_AUTH_TOKEN: ${{ secrets.SYROTP_NPM_TOKEN }}
```

The same pattern repeats for PyPI, Packagist, Maven Central,
SwiftPM, pub.dev — each with its own job, secret, and approval
gate.

## Operator runbook (when something goes wrong)

- **Token compromise**: rotate immediately at the registry; update CI secret; force-rotate maintainer creds; audit recent publishes.
- **Bad publish (broken artifact, wrong version)**:
  - npm: `pnpm dlx npm-cli-login deprecate <pkg>@<version> "broken — use <newer>"` (npm doesn't allow unpublishing after 72h)
  - PyPI: cannot delete, only yank — `pip install` will skip yanked versions
  - Packagist: re-tag in git; Packagist refetches
  - Maven Central: cannot delete; release a fix-forward version
  - Swift Package Registry: re-tag in git; bump version
  - pub.dev: retract via `flutter pub global retract <pkg> <version>`
- **Manifest drift between languages** (one SDK behind another): see `sdk-versioning.md` §4 — version skew policy. Fix by bumping the lagging package and releasing.

## Roadmap (v0.7 PRs)

| PR | Scope | Adds |
| --- | --- | --- |
| 1 (this) | Policy, package map, dry-run commands | This document |
| 2 | npm: `@syrotp/sdk`, `@syrotp/react`, `@syrotp/web-component`, `@syrotp/cli` | npm dry-run CI step + per-package metadata fixes |
| 3 | PyPI: `syrotp-sdk` | wheel build + `twine check` CI step + `LICENSE` shipping |
| 4 | Packagist: `syrotp/sdk`, `syrotp/laravel` | `composer validate --strict` CI step + `extra.branch-alias` |
| 5 | Maven Central: `io.syrotp:syrotp-sdk`, `dev.syrotp:ui` | `publishToMavenLocal` CI step + signing config + Sonatype account onboarding |
| 6 | Swift Package Registry + pub.dev (`syrotp_flutter`) | `swift package describe` + `flutter pub publish --dry-run` CI steps |

Each PR adds **dry-run capability first**. Real publishing flips on
only after:

1. The dry-run is green across at least three consecutive releases.
2. The registry account onboarding checklist is fully closed.
3. A manual-approval Environment exists in GitHub Actions.

## Out of scope for v0.7

- Operator-owned forks publishing under a different namespace (operators may, but we don't ship docs for that yet).
- Air-gapped / on-prem mirror of every registry (some operators want a self-hosted Verdaccio / pypiserver / Nexus). Out of scope; recommend pinning a specific SYROTP release tag instead.
- Automated release-notes generation. Hand-written CHANGELOG entries are fine for the foreseeable future.
- Re-publishing historical versions (v0.1 through v0.6 will not be backfilled to registries — they'll only be tagged in git).
