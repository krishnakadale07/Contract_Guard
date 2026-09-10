# ContractGuard

ContractGuard detects breaking OpenAPI changes — locally and in CI — so API
changes stop silently breaking the clients that depend on them.

This is the **v0.2 CLI release**: a local-first tool for spec validation,
breaking-change detection, safe runtime tests, configuration files, and CI.
The hosted dashboard, teams, scheduled runs, and background workers remain
future phases.

## What it does

- `contractguard validate <spec>` — checks a spec is well-formed OpenAPI 3.0/3.1
- `contractguard diff --base <old> --current <new>` — compares two spec
  versions and classifies every change as `breaking`, `warning`, or `info`
- `contractguard test --spec <spec> --base-url <url>` — calls the **safe
  `GET` operations only** in a live API and validates each response's status,
  content type, and JSON body against the spec
- Reports in `text`, `json`, or `markdown` — the markdown format is what CI
  posts/uploads
- `--fail-on breaking` (diff, default) / `--fail-on failed` (test, default)
  make the process exit `1` so it can gate a pull request
- A `contractguard.config.yaml` file for repeatable local and CI runs
- Authenticated API testing through environment variables or explicit request
  headers, without printing header values in reports

## Runtime contract testing (`test`)

```bash
contractguard test \
  --spec demo/openapi-new.yaml \
  --base-url http://127.0.0.1:3000 \
  --format text \
  --fail-on failed
```

For each `GET` operation in the spec, it:

1. Builds a request URL, filling in required path/query parameters from an
   `example` or `default` value in the spec. If a required parameter has
   neither, the operation is **skipped** (never guessed) and reported as such.
2. Resolves the hostname and refuses to call it if it resolves to a
   link-local/cloud-metadata address (`169.254.0.0/16`, e.g. the AWS/GCP/Azure
   metadata endpoint at `169.254.169.254`) — DNS-based, so it also catches DNS
   rebinding, not just a literal IP in the URL. **This is an egress guard, not
   a complete SSRF guard**: it does not block loopback or other private
   ranges (`10.x`, `172.16-31.x`, `192.168.x`). That's fine here because you
   supply `--base-url` yourself as a CLI flag — but this check must not be
   reused as-is behind anything that accepts an arbitrary base URL from an
   untrusted caller (e.g. a future hosted/web dashboard), which would need to
   also block private ranges and likely allow-list targets instead.
3. Applies a per-request timeout (`--timeout`, default 5000ms) and bounded
   concurrency (`--concurrency`, default 4).
4. Checks the HTTP status is one the spec documents, the `Content-Type` is
   JSON when the spec says it should be, and the JSON body matches the
   response schema (types, required fields, enum values — recursing into
   nested objects and array items).

**Only `GET` is called.** `POST`/`PUT`/`PATCH`/`DELETE` operations in the
spec are never invoked by this command — that's intentionally out of scope
for this MVP, not just unimplemented.

### Try it against the demo server

```bash
# In one terminal: starts a tiny demo API on :3000
node demo/server.mjs

# In another terminal:
node bin/contractguard.js test --spec demo/openapi-new.yaml --base-url http://127.0.0.1:3000
```

`demo/server.mjs` has one **intentional** contract bug (a missing `email`
field on `GET /users/{id}`) so the demo actually shows a real failure, not
just green checkmarks.

## Rules implemented

**Breaking:** removed endpoint/method, removed successful (2xx) response,
new required request parameter, optional→required parameter, request
parameter type change, removed request enum value, removed response
property, response property type change, response property becomes
required, removed response enum value, authentication newly required or
strengthened.

**Non-breaking (info):** new endpoint/method, new optional parameter, new
response status, new response property.

The diff engine walks nested object properties **and array items**, so a
change inside `items.properties.foo` in a list response is caught, not just
top-level fields. Only local `#/components/...` `$ref`s are resolved in this
MVP — external/remote refs aren't supported yet.

## Setup

```bash
npm install
npm run build      # compiles TypeScript to dist/
npm test           # runs the vitest suite
```

## Usage

```bash
# Validate a spec
node bin/contractguard.js validate demo/openapi-new.yaml

# Diff two versions
node bin/contractguard.js diff \
  --base demo/openapi-old.yaml \
  --current demo/openapi-new.yaml \
  --format text

# Markdown report, written to a file, failing CI on breaking changes
node bin/contractguard.js diff \
  --base demo/openapi-old.yaml \
  --current demo/openapi-new.yaml \
  --format markdown \
  --out contractguard-report.md \
  --fail-on breaking
```

## Configuration and authenticated APIs

Copy `contractguard.config.example.yaml` to `contractguard.config.yaml` and
replace the example paths and base URL. The CLI automatically loads that file
from the current directory, or you can select one explicitly with `--config`.

```yaml
test:
  spec: ./openapi/current.yaml
  baseUrl: https://api.example.com
  timeout: 5000
  concurrency: 4
  format: markdown
  report: ./artifacts/contractguard-runtime.md
  headers:
    Authorization: "Bearer ${CONTRACTGUARD_API_TOKEN}"
```

Set the token outside the config file, then run the test. Do not commit a
config file that contains a real token.

A ready-to-run config is included for the demo specs:

```bash
node bin/contractguard.js diff --config demo/contractguard.config.yaml
```

```bash
export CONTRACTGUARD_API_TOKEN="replace-with-your-token"
node bin/contractguard.js test
```

On PowerShell:

```powershell
$env:CONTRACTGUARD_API_TOKEN = "replace-with-your-token"
& "C:\Program Files\nodejs\node.exe" bin/contractguard.js test
```

You can also provide a header directly. Repeat `--header` for multiple
headers.

```bash
node bin/contractguard.js test \
  --spec openapi.yaml \
  --base-url https://api.example.com \
  --header "Authorization: Bearer $CONTRACTGUARD_API_TOKEN"
```

For repeatable automation, values use this precedence order:

```text
CLI flag > environment variable > config file > built-in default
```

Important environment variables:

| Purpose | Variable |
|---|---|
| Config path | `CONTRACTGUARD_CONFIG` |
| Diff base/current spec | `CONTRACTGUARD_DIFF_BASE`, `CONTRACTGUARD_DIFF_CURRENT` |
| Runtime spec/base URL | `CONTRACTGUARD_TEST_SPEC`, `CONTRACTGUARD_TEST_BASE_URL` |
| Runtime timeout/concurrency | `CONTRACTGUARD_TEST_TIMEOUT`, `CONTRACTGUARD_TEST_CONCURRENCY` |
| Bearer token | `CONTRACTGUARD_API_TOKEN` |
| Token scheme, such as `Basic` | `CONTRACTGUARD_AUTH_SCHEME` |
| JSON headers object | `CONTRACTGUARD_HEADERS` |

Header values are never added to ContractGuard reports. Token-like query
parameters and URL credentials are redacted from runtime JSON and Markdown
reports. Keep secrets in environment variables or your CI secret store—not in
version-controlled YAML files.

### Exit codes

| Exit code | Meaning |
|---|---|
| `0` | No finding met the configured failure threshold |
| `1` | A breaking diff finding or failed runtime test met the threshold |
| `2` | Invalid CLI input, config, or OpenAPI file |

While developing, you can skip the build step with:

```bash
npm run dev -- diff --base demo/openapi-old.yaml --current demo/openapi-new.yaml
```

### Demo specs

`demo/openapi-old.yaml` and `demo/openapi-new.yaml` are a matched pair with
intentional breaking and non-breaking changes baked in (removed `DELETE`
endpoint, removed response field, newly-required parameter, newly-required
auth, plus purely additive changes). Diff them against each other to see the
full rule set fire.

## CI

`.github/workflows/contractguard.yml` runs the diff on every pull request
that touches a spec file, using `demo/openapi-new.yaml` as a stand-in for
your real spec — **update the `--base`/`--current` paths and the "Checkout
base spec" step** to point at your actual OpenAPI file once you have one, and
uploads a markdown report as a build artifact either way.

For a project-specific workflow, place `contractguard.config.yaml` in the
repository and set API tokens as GitHub Actions secrets. Never put a literal
token into a workflow file.

## Publish as an npm CLI

The package is scoped as `@krishnakadale07/contractguard`, which avoids a
collision with an existing unscoped package. Before publishing, build and
inspect the package locally:

```bash
npm run build
npm test
npm pack --dry-run
```

When an npm account owns the `krishnakadale07` scope, publish the release with:

```bash
npm publish --access public
```

## Project layout

```text
contractguard/
├── src/
│   ├── core/         # parser, diff engine, runtime tester, schema validator, report formatting
│   └── cli/           # commander-based CLI (validate / diff / test)
├── bin/                # CLI entrypoint (runs the compiled dist/)
├── demo/               # paired demo specs + a tiny demo API server
├── test/               # vitest suite (diff rules, schema validator, runtime tester)
└── .github/workflows/  # CI contract-diff workflow
```

## Roadmap (post-MVP)

- `HEAD`/`OPTIONS` in runtime testing, and an opt-in `--allow-write` mode for
  `POST`/`PUT`/`PATCH`/`DELETE` with stronger safeguards
- Dashboard (Next.js) with run history and a contract-health score
- Auth, organizations, and audit history
- Redis/BullMQ background workers for scheduled or long-running test runs
- Persisting run/result history (currently every run is stateless)

## Limitations

- Local `$ref`s only — no external files or remote URLs
- The runtime egress guard only blocks link-local/cloud-metadata addresses,
  not loopback or other private ranges — sufficient for a CLI where you
  supply `--base-url` yourself, not sufficient SSRF protection for a service
  that would accept a base URL from someone else
- Runtime testing only calls `GET` operations, and only ones whose required
  path/query parameters have an `example` or `default` in the spec —
  everything else is skipped, never guessed
- The response schema validator covers `type`, `properties`, `required`,
  `enum`, and `items` — it's a practical subset of JSON Schema, not a full
  implementation
- Contract-health scoring, trend charts, and the dashboard aren't built
- This tool does not guarantee API security or full backward compatibility —
  it catches a well-defined, testable subset of breaking changes
