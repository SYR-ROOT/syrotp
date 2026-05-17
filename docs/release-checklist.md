# SYROTP Release Checklist

**Status:** Operational. The pre-tag gate the project runs before
every release. Sits next to [`upgrade-policy.md`](upgrade-policy.md)
(operator-side upgrade discipline) and
[`api-contract.md`](api-contract.md) (the wire commitment a release
must respect).

This checklist is for **whoever cuts the release** (the maintainer
running `git tag`). It is not for operators upgrading their
deployments — they read [`upgrade-policy.md`](upgrade-policy.md)
instead.

## When to run this

Run the checklist when:

- The next version's CHANGELOG entry is drafted under
  `## [<version>] — <date>` and ready to ship.
- The corresponding feature/freeze/hardening track has merged to
  `main` (the release commit is what you're about to tag).
- All in-flight PRs that should land in this version are merged. A
  PR merged AFTER the tag is in the next version, not this one.

Do NOT run this when:

- A PR is still open with intended-for-this-release changes.
- Local `main` is not equal to `origin/main`.
- CI on `origin/main`'s tip is red or pending.

## The gate (six checks)

Each check below must pass before tagging. Skipping a check is a
release-quality regression — if a check is impractical for a given
release, document the deviation in the CHANGELOG entry rather than
silently bypassing it.

### 1. Local sanity

Run on the maintainer's machine, against the real local DB / Redis
(see [`../README.md`](../README.md) for setup).

```bash
pnpm typecheck
pnpm test
DATABASE_URL_TEST="postgres://syrotp:<password>@localhost:5433/syrotp_test" \
REDIS_URL_TEST="redis://localhost:6380/15" \
  pnpm --filter @syrotp/server test:integration
```

Expect: typecheck silent, unit suite green, integration suite green
(currently 145 tests across 23 suites). A single integration failure
is a hard stop.

### 2. OpenAPI contract drift test passes

The drift test (`apps/server/test/suites/openapiContract.ts`) runs
inside the integration suite above; check 1 covers it. **Do NOT
skip it** — it is the safety net that prevents a route from shipping
without docs and vice versa.

If a new route landed and the test goes red, the fix is to document
the route in [`../openapi.yaml`](../openapi.yaml) (or add it to
`OUT_OF_CONTRACT` in the test file with a documented reason) — not
to delete or weaken the test.

### 3. Release-baseline loadtest

The pre-tag operational gate. Runs the burst-shape acceptance suite
against a freshly-bootstrapped local server.

```bash
pnpm syrotp loadtest release-baseline
```

Expect: every step passes its acceptance shape (success ≥ 99.9%,
no 5xx, no double-verifications, p95 within budget). Emits a
single aggregate `summary.md`.

A failure here is a hard stop. The release-baseline suite is what
the project commits to as "this release does not regress hot-path
behaviour" — the same suite gates the GitHub Release publish.

(Soak is opt-in, NOT part of release-baseline. See
[`operational-baseline.md`](operational-baseline.md) for the full
gate hierarchy.)

### 4. CI on main green at the release commit

Open the GitHub Actions page for `main`; the run on the commit you
intend to tag must show **all required checks green**. As of
`v1.0.0` that's 24 jobs spanning unit + integration + every SDK +
every publish dry-run + smoke.

```bash
gh run list --branch main --limit 3
gh run view <run-id>
```

Known flakes (do NOT block on a documented flake; rerun the failing
job once and require pass on rerun):

- `android ui tests > VerificationControllerTest > fires onCancelled`
  — known StateFlow-vs-callback race in the test, not a code
  regression. Documented in the project memory.
- `swift-actions/setup-swift@v2` on `smoke` occasionally takes 25+
  minutes on cold runners (genuinely slow, not stuck) — wait it out.

Anything else red is a hard stop.

### 5. CHANGELOG entry extracts cleanly

The release workflow extracts the CHANGELOG section between the
version header you're about to tag and the previous one, and ships
it as the GitHub Release body. The extractor is a small awk script
in [`.github/workflows/release.yml`](../.github/workflows/release.yml):

```awk
awk -v tag="${TAG#v}" '
  /^## \[/ {
    if (printing) exit
    if ($0 ~ "\\["tag"\\]") { printing = 1; next }
  }
  printing { print }
' CHANGELOG.md > section.md
```

Verify locally before tagging:

```bash
awk -v tag="1.2.3" '
  /^## \[/ { if (printing) exit; if ($0 ~ "\\["tag"\\]") { printing = 1; next } }
  printing { print }
' CHANGELOG.md
```

Expect: the body of the version's entry, ending where the next
`## [...]` begins. Common pitfalls:

- Header style drift. The extractor matches `## [<version>]`
  literally — `# v1.2.3` or `## v1.2.3` will NOT match. The
  bracket form is what every entry uses; do not invent variants.
- Em-dash vs hyphen in the date suffix is fine (the extractor only
  parses the bracketed version), but be consistent with prior
  releases for readability.
- The version inside the brackets must be a literal SemVer string
  with no `v` prefix — `[1.0.0]`, not `[v1.0.0]`. The shell strips
  the leading `v` from the tag before passing it to awk; the
  CHANGELOG must be pre-stripped to match.

### 6. Pre-flight repo state

Quick visual sweep before running `git tag`:

```bash
git status              # working tree clean
git log -1              # the commit you're about to tag
git diff main origin/main   # local main equals remote main
```

Expect: nothing modified, nothing untracked, log shows the merge of
the release-track final PR, no diff against `origin/main`.

## Tag and publish

When all six checks above are green:

```bash
git tag v<version>      # e.g. git tag v1.0.0
git push origin v<version>
```

The release workflow takes over from there:

1. The `release` workflow fires on the tag push.
2. Builds the release artifacts (source tarball; the project does
   not currently ship pre-built binaries).
3. Extracts the CHANGELOG section for `<version>` (check 5 above).
4. Publishes a GitHub Release named `v<version>` with that section
   as the body.
5. The `release-baseline` workflow runs separately on the tag and
   posts its `summary.md` to the run.

Watch both workflows complete before considering the release done:

```bash
gh run watch
gh release view v<version>
```

## After the tag

- Update the project memory's "shipped" section to record the
  release date and a one-line summary of what landed.
- Update any pinned versions in dependent docs/scripts that reference
  the previous release.
- Announce per the project's communication policy (out of scope for
  this checklist).

## Special cases

### Re-tagging the same version

**Don't.** A tag is a permanent name. If the release commit needs a
fix, ship `v<version+0.0.1>` with the fix and reference the bug in
its CHANGELOG entry. Re-tagging requires force-push and
desynchronises any consumer that already pulled the original tag.

### Skipping a check

If a check is genuinely impractical for a release (e.g. infra outage
preventing the integration DB from coming up), the deviation MUST be
documented in the CHANGELOG entry's `### Notes` block, with the
mitigating evidence that gives equivalent confidence (e.g. "CI
integration green on the merge commit; local integration suite
deferred to follow-up").

A skip is a release-quality regression. Don't normalise it.

### Patch-only release

Same six checks. Patch releases are not exempt — a patch that
quietly regresses the contract is exactly what the contract-drift
test exists to catch.

### First major (`X.0.0`) release

Same six checks PLUS a re-read of
[`api-contract.md#compatibility-commitment-for-v10`](api-contract.md#compatibility-commitment-for-v10):
the wire shapes you are about to freeze are what every consumer in
the next MAJOR cycle will rely on. Schemas, error codes, and
endpoint paths committed at the major bump are immovable until the
next MAJOR.
