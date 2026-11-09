# Design

## Context

See `proposal.md` — Why. The repository is empty: no commits, no `package.json`, no code. The behaviour contract is in the five delta specs under `specs/`; this document says how to build it.

The ground Dial copies from was read in the explore brief `.claude/handoff/explore-scaffold-cli-and-registry-20261109-230857.md`:

- **Escapement** (`~/IdeaProjects/escapement`) is the sibling CLI whose conventions the epic says to keep "so you keep one mental model across your tools": a pure `lib/` that returns data or `{ ok, reason }` and never touches stdout, stderr or the process; a thin `bin/` that owns parsing, the `--json` switch, the single stderr writer and the exit code; `main()` returning a number and the entry guard setting `process.exitCode`; a frozen `LIMITS` object with a parallel description map; `node:test` with `assert/strict` and bare `test()`.
- **Interlock's doctor** (`~/IdeaProjects/specflow/lib/doctor.mjs`) has the richer check record (`skip` status, `evidence[]`, multi-line `fix`), the permission-rule coverage logic, and the paste-ready snippet the epic asks Dial to copy.
- **The vaults**: the personal vault's `AGENTS.md` fixes frontmatter conventions, filename rules and "never delete"; neither vault has `Projects/` or `Changes/` yet. `~/.config/dial` does not exist.

Constraints: Node 22+, zero runtime and zero dev dependencies, macOS is the only target, one owner.

## Goals / Non-Goals

**Goals:**
- A `lib/` that later changes import without refactoring: home resolution, registry load and write, limits, the frontmatter reader and the settings reader are all reused by the collectors, renderer and hooks.
- Every behaviour in the specs pinned by a test before the code exists (the tasks lead with the failing suite).
- The work/personal boundary enforced at the two places that exist in this change: `register` and `doctor`.

**Non-Goals:**
- No subprocesses in this change except the test runner spawning the binary. `git`, `gh`, `glab`, `obsidian` and `interlock` are not executed; the Obsidian CLI check only looks for the executable on PATH.
- No vault writes of any kind. `dial vault init` (epic 0.3) belongs with the renderer change, where the templates it writes are designed.
- No `dial vault add` command (D5).
- No directory-prefix boundary rule (D18, pending).

## Decisions

### Module layout

```text
bin/dial.mjs            parseArgs (per-command option table) · fail() · main() · dispatch · invokedDirectly()
lib/home.mjs            resolveHome(env) · ensureHome(env) → { root, logs } · HomeUnwritable
lib/registry.mjs        SCHEMA · registryPath(home) · loadRegistry(home) · validateRegistry(raw, path)
                        register(reg, { path, vault, host }) · unregister(reg, arg) · listRepos(reg)
                        writeRegistry(home, reg) (atomic) · repoName(path) · collapseHome / expandHome
lib/limits.mjs          LIMITS · DESCRIPTIONS · effectiveLimits(overrides, path) · formatLimits(limits)
lib/frontmatter.mjs     readFrontmatter(text) → { [key]: string } | null   (flat `key: value` only)
lib/settings.mjs        settingsSources(cwd, home) · collectPermissions(sources) · parseRule · ruleCovers · coverage(rules, 'dial')
lib/doctor.mjs          diagnose({ env, cwd, pathDirs }) → report · formatDoctor(report) · the six checks
test/helpers.mjs        tmp · makeHome · runCli · readJson · writeJson · snapshotTree · makeGitDir · makeVault
test/<module>.test.mjs  one per lib module, in-process
test/cli.test.mjs       the binary as a subprocess
```

Every `lib` function is pure with respect to the process: it takes `env`, paths and data as arguments and returns data. Only `bin/dial.mjs` reads `process.argv`, writes to stdout or stderr, or sets an exit code. This is Escapement's split (`bin/escapement:87-100, 307-369`) and it is what makes every requirement testable in-process with a subprocess test only for the shell itself.

### The shell (D11, D12)

`bin/dial.mjs` keeps Escapement's hand-rolled parser but replaces its single global `FLAGS_WITH_VALUES` set with a per-command option table: `{ register: { vault: 'value', host: 'value' }, repos: { json: 'flag' }, … }`. That is what lets the shell refuse an unknown option (Escapement accepts any `--x` as a boolean, `bin/escapement:57-79`) and report a value flag with no value, as the `cli-shell` spec requires. The alternative — accept unknown options silently, as Escapement does — was rejected because a typo like `--vualt` would then register a repo with the wrong vault silently, which is the one failure the boundary exists to prevent.

`--help` exits 0 everywhere. Escapement exits 1 for `list --help` (`bin/escapement:312-315`), which is a quirk, not a convention worth copying (D11). `dial version` and `--version` read `version` from `package.json` next to the binary (`new URL('../package.json', import.meta.url)`); Escapement has no version command at all (D11).

The entry file is `bin/dial.mjs` with `bin: { "dial": "bin/dial.mjs" }` in `package.json` (D12). Escapement's binary is extensionless; the epic names `bin/dial.mjs`, and an `.mjs` extension keeps the file importable by the in-process tests of `main()` without a loader hint.

`fail(reason, code = 1)` writes `dial: ${reason}\n` to stderr and returns the code. Lib reasons are written bare (no `dial:` prefix) so the prefix appears once — Escapement's `HomeUnwritable` message already starts with the tool name and so prints `escapement: escapement home is not writable`, which Dial avoids.

### The home (D13, D14)

`resolveHome(env)` is Escapement's `resolveHome` (`lib/home.mjs:26-32`) with the default changed to `join(homedir(), '.config', 'dial')` (D13): trim, blank → default, `~` and `~/` expansion, otherwise `path.resolve`, never a fallback. `~/.config/dial` is the epic's choice and sits beside `gh`, `git`, `mise` and `openspec` in the user's `~/.config/`.

`ensureHome(env)` creates `root` and `root/logs` with `mkdirSync({ recursive: true })` and proves writability with a probe file `.probe-<pid>-<now>` that it writes and unlinks, exactly as Escapement does (`lib/home.mjs:54-72`). Any failure is `HomeUnwritable` with `.path`, `.cause`, `.code`, and the message `dial home is not writable: <path> (<code>: <message>)`. `logs/` is created now, though unused until the LaunchAgent change, so that the home layout is stable from the first version and the idempotence test has two directories to compare.

Read commands never call `ensureHome` (D14): `loadRegistry(home)` only resolves the path and reads; a missing file is `{ ok: true, registry: EMPTY }` where `EMPTY` is `{ dial_schema, vaults: {}, repos: [], limits: {} }`. Only `register` and `unregister` call `ensureHome` before `writeRegistry`. The `doctor` `home` check does not call `ensureHome` and does not create the home. When the resolved home exists and is a directory, it writes and unlinks the same probe file inside it, and a failed probe is `HomeUnwritable`. When the home does not exist, it checks the nearest existing ancestor with `accessSync(W_OK)` and reports `ok` with the detail `will be created on first register` when that ancestor is writable; it reports `fail` with the `HomeUnwritable` reason when the ancestor is not writable or the resolved path is a regular file.

### The registry (D1, D3, D4, D5, D6, D7, D14, D17)

**Schema (D1).** The file is the epic's JSON plus `"dial_schema": "dial.registry/1"`. The marker follows the epic's own note frontmatter (`dial_schema: dial.change/1`) and Interlock's `interlock.outcome/2` and `interlock.preflight/1` records; it costs one line and lets a later change migrate the file instead of guessing its shape. A missing or unknown marker is refused on load rather than assumed, because an unversioned file is the one kind that cannot be migrated safely.

**Validation on load** happens in one function, `validateRegistry(raw, path)`, called by `loadRegistry`, so that `register`, `unregister`, `repos`, `limits` and `doctor` all see the same verdict. It checks: the marker; `vaults` is an object of string paths; each repo has `path`, a `vault` present in `vaults`, and a `host` in `{ github, gitlab }` (D6, D17); no two repos share an expanded path; no two repos share a name (D4); `limits`, when present, passes `effectiveLimits` (see below). The reason strings name the file path and the offending value so the fix is obvious from stderr.

**Repo name (D4).** `repoName(path)` is the last path segment. It must be unique across all entries in all vaults because it becomes the note filename `Projects/<repo>.md` and the prefix of `Changes/<repo>--<change>.md` (epic lines 181-182), and the vault guide says note names must be unique across a vault. Allowing a `name` override field was considered and left out: no registered repo today collides, and the field can be added later without a schema bump because unknown keys are not refused.

**Boundary at register (D3).** `register(reg, { path, vault, host })` returns `{ ok: false, reason }` when an entry with the same expanded path or the same repo name exists with a different vault, with the reason `<name> is registered to vault <other> (<stored path>); a repo belongs to exactly one vault`. Same path and same vault updates `host` in place and returns `{ ok: true, updated: true }`. This is option (A) of the brief: it implements the epic's principle 5 literally with zero schema change. Option (B), per-vault directory roots, is the pending question D18; if the human wants it, it is an additive check in `register` plus a sibling top-level map `"roots": { "~/VSCodeProjects": "work" }`, so `vaults` values stay strings. This change's schema is the same either way. Option (C), inferring the vault from the git remote host, was rejected because it conflates `host` with `vault`.

**Paths (D7).** `register` requires `existsSync(path)`, `statSync(path).isDirectory()` and `existsSync(join(path, '.git'))` — the `.git` entry may be a file, so linked worktrees register. The path is stored with the home directory collapsed to `~` (as every example in the epic shows) and expanded on read by `expandHome`, so the file stays readable and portable across a username change. All comparisons use the expanded absolute path.

**Vaults are hand-declared (D5).** The epic's Stage 0 has no vault-add command and calls the registry "the only maintained artefact". `register --vault <unknown>` fails with a reason that quotes the exact JSON line to add under `vaults`, which is a one-line edit. `dial vault init` (epic 0.3) arrives with the renderer and may record the mapping then.

**Atomic write (D14).** `writeRegistry(home, reg)` serialises with `JSON.stringify(reg, null, 2) + '\n'`, writes to `registry.json.<pid>.tmp` in the home, then `renameSync` over `registry.json`. Keys are written in the fixed order `dial_schema, vaults, repos, limits`, and `repos` sorted by name, so an unchanged registry is byte-identical after a rewrite — the same property the vault writer needs in the next change.

**`unregister` (D16)** matches the argument against the stored path, the expanded path and the repo name, in that order, and removes the first hit.

### Limits (D2)

`lib/limits.mjs` exports a frozen `LIMITS = { staleDays: 14, archivedKeepDays: 30, briefLines: 40 }` and a frozen `DESCRIPTIONS` with the same keys, exactly Escapement's pair (`lib/limits.mjs:6-52`). The epic puts a `limits` block in the registry, so unlike Escapement the defaults can be overridden: `effectiveLimits(overrides, path)` returns `{ ok, limits }` after refusing an unknown key or a non-positive-integer value with the key and the file named. `formatLimits(limits)` is Escapement's renderer verbatim (`${name.padEnd(width)} = ${String(value).padStart(9)}  ${description}`). `dial limits` loads the registry if present (a missing file means defaults), and takes `--json` because the epic wants JSON on every read command, where Escapement's `limits` is text only.

### The frontmatter reader

`readFrontmatter(text)` returns `null` unless the text starts with `---\n`, then parses each `key: value` line up to the closing `---`, trimming and stripping one pair of surrounding quotes; it does not handle nested YAML, lists or multi-line values, because the Dial notes this change reads (and the renderer will write) use only flat scalars in frontmatter. It returns an object; the doctor boundary audit asks it for `dial_schema` and `repo`. This small module exists now so the renderer and the brief reuse one parser rather than each growing their own.

### Doctor (D8, D9, D10)

**Record and renderer (D8).** `check(id, status, detail, extra)` and the report shape come from Interlock (`lib/doctor.mjs:429-431`, `1743-1761`): `{ id, status, detail, evidence: [], fix? }` with `status ∈ { ok, warn, fail, skip }`, and a report `{ ok, home, counts, checks, failures, warnings }` with `ok = counts.fail === 0`. The renderer uses the four-character marks both tools share (`ok  `, `warn`, `FAIL`, `skip`), the nine-space evidence indent, `      fix:` at six spaces and continuation lines at eleven, printing evidence and fix only at `warn` or `fail`. The header is Escapement's style with Interlock's counts: `DIAL OK — N passed` or `DIAL BLOCKED — N failing check(s)`, `, N warning(s)` appended, then `  home: <path>`. `N passed` is the count of checks with status `ok`, the same number as `counts.ok`; a `skip` is not included. Escapement's three-status record was considered and rejected because `skip` is the honest status for an optional tool that is absent, and `evidence[]` is the epic's principle 1 ("every value carries its evidence") applied to doctor itself. Every check runs inside a `run()` wrapper that converts a throw into a `fail` record with `check could not run: <message>`.

**Checks.** `node` compares `process.versions.node`'s major to 22. `home` probes without creating, as The home describes, and catches `HomeUnwritable`. `registry` calls `loadRegistry`; absent is `ok` with `no registry yet`; invalid is `fail` with the load reason; each vault path is `statSync`'d and a missing or non-directory one is `fail` (sync could write nowhere); each repo path is checked for existence and a `.git` entry and a bad one is `warn` (a later sync can mark that repo `unobserved` and carry on). `obsidian-cli` scans the directories in `env.PATH` for an executable named `obsidian` with `accessSync(X_OK)` — no subprocess — and is `ok` or `skip`. `diagnose` takes `pathDirs` and `cwd` as arguments so tests control both.

**Boundary audit (D10).** For each vault in the registry, `boundary` lists `Projects/*.md` and `Changes/*.md` (missing folders are fine), reads each file, and keeps it only if `readFrontmatter` returns an object with a `dial_schema` key — so the user's own notes in the same folders are never mistaken for Dial's. The repo is `frontmatter.repo`, else the filename stem up to the first `--` under `Changes/` or the whole stem under `Projects/`. It looks the repo up by name in the registry; a different vault is a violation and the check is `fail` with the detail `<file> is in vault <a> but <repo> is registered to vault <b>` and the fix `fix the registry entry or move the note`; an unregistered repo is not a violation (that is staleness, a later change's concern). When `loadRegistry` fails, `boundary` is `skip` with the detail `registry not loaded` and does not scan; a missing file is an empty registry, so the check is `ok`. The audit only opens files for reading; the spec pins that the vault tree is byte-identical afterwards. Reading frontmatter rather than trusting filenames was chosen because the frontmatter is what the renderer will write and what Obsidian Bases filters on; the filename is the fallback for a note that lost its `repo` key.

**Permissions (D9).** `lib/settings.mjs` is a reduced copy of Interlock's `settings-sources.mjs:24-37` and `doctor.mjs:297-391`: the four scopes (managed `/Library/Application Support/ClaudeCode/managed-settings.json`, user `~/.claude/settings.json`, project `<cwd>/.claude/settings.json`, local `<cwd>/.claude/settings.local.json`), `parseRule` for `Bash(x:*)`, `Bash(x *)`, `Bash` and `Bash(*)`, and token-prefix `ruleCovers` where a narrower rule never covers a broader requirement. The requirement is the single token `dial`. The verdict differs from Interlock's in one deliberate way: an uncovered or denied rule is `warn`, not `fail`, because nothing in this change needs the rule — the Stage 4 hooks do, and that change can raise the severity when it adds them. The `permissions` check does not read the registry, so a load failure does not change it. The fix snippet is Interlock's format (`doctor.mjs:1189-1192`) with the target changed to `~/.claude/settings.json`, because a hook that fires in every registered repo needs the rule in the user scope, not in one project's settings. Evidence lists `<scope>: <path>` for each file that existed, and an unparseable file is `warn` naming it.

### Tests (D15)

`test/helpers.mjs` lifts Escapement's private `cli()` (`test/cli.test.mjs:25-34`) into a shared `runCli(args, env)`: `execFile(process.execPath, [BIN, ...args], { env, timeout: 30_000 })`, resolving `{ code, stdout, stderr }` and never rejecting, with the child env built from an allowlist (`PATH`, `TMPDIR`, a throwaway `HOME`, then the caller's overrides) so no test can see the real `~/.config/dial` or `~/.claude/settings.json`. `tmp(prefix)` is Escapement's `mkdtempSync` under `TMPDIR`. New helpers Escapement lacks: `snapshotTree(dir)` returns a sorted map of relative path to content hash, used for every byte-identical scenario (home re-ensure, unchanged registry write, doctor never writes to a vault); `makeGitDir(root, { worktree })` creates a directory with a `.git` directory or file; `makeVault(root, notes)` writes `Projects/` and `Changes/` notes from `{ path, frontmatter, body }` records. Fixtures under `test/fixtures/` are single files (a valid registry, a wrong-schema registry, a non-JSON registry, three settings files) with a `README.md` provenance table, as in Escapement.

Tests pin exact stderr strings for the reasons the specs quote verbatim and use `assert.match` elsewhere, and always pass `res.stderr` as the assertion message on an expected exit 0, Escapement's idiom.

## Risks / Trade-offs

- [Reading the user's Claude Code settings and Obsidian vaults from doctor] → every read is wrapped: an unreadable or unparseable file is a `warn` record naming it, never a crash, and the audit opens files read-only; the spec's byte-identical scenario proves no write.
- [The permissions check uses `cwd` for the project and local scopes, so its verdict changes with the directory doctor is run from] → the evidence lists exactly which files were read; the snippet targets the user scope, which is correct regardless of `cwd`.
- [A flat frontmatter reader will misread a nested or multi-line YAML value] → it only needs two scalar keys, and a note whose frontmatter it cannot parse is treated as not a Dial note, which is the safe direction for an audit.
- [`repoName` uniqueness may one day bite two legitimately same-named repos] → the refusal names both paths; adding an optional `name` override later needs no schema bump.
- [Option (A) does not refuse a never-registered work path given `--vault personal`] → the doctor audit catches the result once notes exist; D18 asks the human whether to add (B).
- [`logs/` exists before anything logs to it] → one empty directory; it keeps the home layout stable from version 0.1.0.

## Migration Plan

Greenfield: install with `npm i -g .` from the repo, run `dial doctor`. Rollback is `npm uninstall -g dial`; the only file Dial has written is `~/.config/dial/registry.json`, which can be deleted by hand.

## Open Questions

- D18 (pending, ledger): whether `register` should also refuse by directory prefix. Answering yes adds a sibling top-level `"roots": { "~/VSCodeProjects": "work" }` map and one more check in `register`. `vaults` values stay strings. This change's schema is the same either way, so it can be answered at the checkpoint or in a follow-up change.
