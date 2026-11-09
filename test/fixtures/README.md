# Fixtures

Authored on 2026-11-10 for the `scaffold-cli-and-registry` change from the
delta specs under `openspec/changes/scaffold-cli-and-registry/specs/`. Paths
inside them (`/vaults/...`, `/repos/...`) are placeholders; tests that need real
directories copy a fixture into a temp home and rewrite those paths.

| file | derived from | what it pins |
|------|--------------|--------------|
| `registry-valid.json` | `specs/registry/spec.md`, "Well-formed file loads" | marker `dial.registry/1`, two vaults, one repo, empty `limits` |
| `registry-wrong-schema.json` | `specs/registry/spec.md`, "Wrong schema marker" | `dial_schema` is `dial.registry/0`; refused naming the file and the value |
| `registry-not-json.txt` | `specs/registry/spec.md`, "File is not JSON" | text that fails `JSON.parse` |
| `settings-allow-dial.json` | `specs/doctor/spec.md`, permissions; shape of Interlock `settings-sources.mjs` | `permissions.allow` holds `Bash(dial:*)`, covering the `dial` requirement |
| `settings-allow-narrow.json` | `specs/doctor/spec.md`, permissions | `Bash(dial doctor:*)` is narrower and must not cover `dial` |
| `settings-broken.json` | `specs/doctor/spec.md`, "Unreadable settings file" | truncated JSON; reported as an error, never thrown |
