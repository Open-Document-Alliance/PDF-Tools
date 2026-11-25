# Claude plugin

`node scripts/build-claude-plugin.mjs` builds `dist-plugin/claude-pdf-tools/`: one Claude plugin that gives each Claude surface the right PDF Tools.

| Surface | What loads |
| --- | --- |
| claude.ai and the Claude apps (chat) | The hosted connector `pdf-tools-hosted` (`https://mcp.opendocuments.ai/mcp`) and the skills. Chat ignores local servers and hooks. |
| Claude Code, and Cowork on the user's computer | The local server `pdf-tools`, the hosted connector, the SessionStart hook, and the skills. |

The `pdf-tools` skill routes between the two: local files go to the local server, chat attachments to the hosted connector, and a local file is never sent to the hosted connector unless the user asks.

## Why the bundle has no node_modules

The Claude directory stops validating a repository over 50 MiB as a GitHub archive and holds non-text binaries for a reviewer. The Agent Plugins bundle (`npm run build:plugin`) vendors the production graph with five native canvas builds, about 177 MB. So this bundle ships the same first-party files the MCPB ships (`copyRuntimeSource` in `scripts/build-mcpb.mjs`) plus `package.json` and `package-lock.json`, about 7 MB and 72 files.

`runtime/start.mjs` installs the locked graph on first run:

1. The build writes `runtime/payload.json`, the SHA-256 of every payload file, and a digest of that list.
2. On start, the launcher looks for `${CLAUDE_PLUGIN_DATA}/runtime/<digest16>/.pdf-tools-ready`.
3. If it is missing, the launcher takes a lock, copies the payload into a staging folder, verifies every hash, runs `npm ci --omit=dev --ignore-scripts` through `node npm-cli.js` (no shell, no PATH lookup), marks it ready, renames it into place, and deletes older runtimes.
4. It then starts `server/index.js` from that folder with `PLUGIN_DATA` set to the plugin data folder, so the existing folder-boundary and private-workspace logic applies unchanged.

npm installs only the host's own `@napi-rs/canvas` build from the lockfile, so every platform the lockfile covers renders (including Linux arm64, which the MCPB does not ship) without the bundle carrying every binary.

The SessionStart hook runs `start.mjs --prepare`, which starts the install in a detached process and returns at once, so the first PDF tool call usually finds the runtime ready. Measured on silvercloud on 2026-11-25: a cold-cache install took 2.6 s and pulled about 43 MB. A home connection will take longer. If the first start outlasts the host's MCP startup timeout, reconnecting from `/mcp` after the install finishes works.

## Checks

- `node scripts/build-claude-plugin.mjs` fails on any directory-checklist block it can see (junk files, Windows-invalid names, files over 5 MiB, a top-level `bin/`, a README under 40 words). It lists the items a reviewer will hold, then smoke-tests a first-run install and `tools/list` against an empty data folder.
- `claude plugin validate dist-plugin/claude-pdf-tools` must print `✔ Validation passed` with no plugin directory warnings.
- `test/claude-plugin.test.js` pins the generated config and exercises the launcher's install, reuse, upgrade and tamper paths offline.

Items the directory holds for a reviewer, all expected: `server/index.js`, `server/layout-extraction.js` and `dist-ui/index.html` exceed 256 KiB, `vendor/qpdf-wasm/runtime/qpdf.wasm` is a binary, and dependencies install from a lockfile.

## Adding a partner connector

Remote connectors come from `REMOTE_CONNECTORS` in `scripts/build-claude-plugin.mjs`. Lumin's own signing connector (`https://mcp.luminpdf.com/mcp`) would be one more entry there, with its host added to `network.hosts`, a README line, and a routing row in the `pdf-tools` skill. Add it only when Lumin agrees.

## Not yet decided

The listing needs a public GitHub repository whose tracked branch archives under 50 MiB, so it cannot share the default branch of `Open-Document-Alliance/pdf-tools-plugin` (177 MB). Once the repository is decided, build with `--marketplace <owner>/<repo>` so the README carries the `/plugin install pdf-tools --marketplace <owner>/<repo>` line `claude plugin validate` asks for; without it validate passes with that one README warning. The plugin's `name` (`pdf-tools`) is permanent once submitted, and the icon is taken only on the first save in the portal.
