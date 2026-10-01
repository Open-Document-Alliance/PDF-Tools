# Agent Plugins 1.0.0 packaging

- **Status:** proposal, with the portable filesystem-boundary work implemented
- **Bead:** child of `pdf-toolkit-mcp-22v.1` (portable skills, plugins, and MCP App workflows across agent hosts)
- **Branch:** `agent/agent-plugins-packaging`, branched from `master@5284fac`
- **Spec version reviewed:** Agent Plugins 1.0.0, published 2026-08-06

## What the standard is

Agent Plugins is an open, vendor-neutral specification for packaging agent extensions into a distributable directory. Vercel wrote the proposal; AWS, Anysphere, GitHub, Microsoft, OpenAI, and Vercel refined it and staff the technical steering committee. Launch clients are ChatGPT, Codex, Cursor, GitHub Copilot, Kiro, and VS Code.

The specification is deliberately small:

- A plugin is a directory with `plugin.json` at its root.
- The manifest schema is closed. The only permitted top-level fields are `$schema`, `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, and `extensions`.
- Version 1 defines exactly two component types: Agent Skills discovered at `skills/<name>/SKILL.md`, and MCP servers configured in `mcp.json`.
- Component locations are fixed. The manifest cannot remap them or carry inline component configuration.
- Client-specific data belongs under a reverse-domain namespace, either as a key in `extensions` or as a top-level directory of the same name.
- Package paths must resolve inside the plugin root. An MCP `command` must be a single token, either a bare executable name or a plugin-relative `./` path.
- Only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded, and only in `args`, `env` values, and `cwd`. All other placeholder-like text stays literal.
- Failures are scoped: an invalid skill is skipped, an invalid MCP entry is skipped, and only an invalid `plugin.json` rejects the plugin.

The standard defines no hooks, no agents, no commands, no user configuration, no credential or OAuth configuration, no install or build lifecycle, and no registry.

## Why this matters for PDF Tools

Two reasons, in order of weight.

**The workflow instructions travel with the server.** The standalone `plugins/pdf-tools-workflow` plugin supplies the evidence-first workflow against a separately configured MCP connection. The MCPB and share ZIP already carry the same authored files listed by `SKILL_FILES` in `server/skill-files.js`, which a modern-era session exposes through `io.modelcontextprotocol/skills`. The server-bearing Agent Plugin also carries `skills/` and `mcp.json` in one directory. Bundled or served instructions are not proof that a particular host activates them; qualify that separately against the exact artifact.

**The MCP Apps viewer is portable in principle, and was not in practice until 2026-08-10.** `server/index.js` serves `ui://pdf-toolkit/viewer` with `mimeType: "text/html;profile=mcp-app"` and attaches `_meta.ui.resourceUri` to the tools that benefit from it. MCP Apps is the official MCP extension for host-rendered UI, and OpenAI's own guidance now treats `_meta.ui.resourceUri` as the primary field, with `_meta["openai/outputTemplate"]` and `window.openai` demoted to compatibility aliases. We are on the current field, so the wiring is correct on any MCP Apps host.

The component itself was not. An earlier version of this paragraph claimed the viewer "already travels" and that it was "not a Claude Desktop exclusive". The first run on a non-Anthropic host disproved it: the viewer built its pdf.js worker as a `data:` module through Vite's `?url` import, ChatGPT desktop's component sandbox refused that secondary load, and the viewer rendered nothing while the MCP tool call succeeded. Claude Desktop happened to permit the same load, which is precisely why the claim survived. See issue #131.

The worker is now bundled in-realm and the component fetches nothing, with a regression test in `test/viewer-compat.test.js` asserting the built bundle carries no `data:` worker URL. **Treat rendering on any specific host as unverified until it has been observed there.** A component that mounts is not a component that renders, and no server-side test can tell the difference.

### Verified MCP Apps client matrix (2026-08-06)

Source: the community-maintained matrix at https://modelcontextprotocol.io/extensions/client-matrix plus each vendor's own documentation. Re-verify before any public claim; this decays quickly.

| Host | MCP Apps UI | Evidence |
|---|---|---|
| Claude web + desktop | Yes | Client matrix |
| ChatGPT | Yes | Client matrix; OpenAI UI docs |
| VS Code + GitHub Copilot | Yes | VS Code blog, 2026-01-26 |
| Microsoft 365 Copilot | Yes | GA announced 2026-04-07 |
| Cursor | Yes, with a live defect | Cursor 2.6 changelog, 2026-03-03 |
| Goose, Postman, MCPJam | Yes | Client matrix |
| Kiro, JetBrains | No evidence found | Absent from the matrix |
| GitHub Copilot outside VS Code | No evidence found | No matrix row |

**On ChatGPT and Codex.** These are one application. OpenAI merged them on 2026-07-09 into a single desktop app with Chat, Work, and Codex modes; the standalone Codex app no longer exists and the previous ChatGPT desktop app was renamed ChatGPT Classic. Any source that reports Codex and ChatGPT as separate clients with different MCP Apps behavior predates the merge and should not be relied on — including openai/codex#21019, which was filed in May against the standalone Codex Desktop build, and the client matrix's separate rows.

The merged desktop app is therefore our primary non-Anthropic host target and it renders MCP Apps UI. The Codex **CLI** remains a separate terminal program and does not render HTML components; that distinction is unaffected by the merge.

This does not relax the degradation requirement. OpenAI's guidance still requires tools to be usable without a component, and our bounded reads and page/region renders already satisfy it. But we should not plan around a viewer-less OpenAI surface that no longer exists.

**Cursor** renders MCP Apps but carries an open regression in which the client advertises `io.modelcontextprotocol/ui` and never issues `resources/read`, so widgets silently fall back to text — reported against project-scoped servers, with global scope working, unresolved as of 2026-07-29. Cursor is a lower-priority target; record the scope used if it is ever trialed, and treat silent text fallback as an expected client failure mode rather than a defect in this server.

## Current packaging inventory

| Artifact | Consumer | Contents |
|---|---|---|
| `manifest.mcpb.json` and staged `SKILL_FILES` | Claude Desktop MCPB | Server config, `user_config`, tool list, canonical skill files |
| `package-for-friend.js` share ZIP | Local MCP hosts | Server and canonical skill files |
| `scripts/build-agent-plugin.mjs` output | Agent Plugin hosts | Server, dependencies, launchers, canonical skill, `plugin.json`, and `mcp.json` |
| `plugins/pdf-tools-workflow/.claude-plugin/plugin.json` | Claude Code | Skill-only plugin |
| `plugins/pdf-tools-workflow/.codex-plugin/plugin.json` | Codex (pre-standard) | Same skill plus an `interface` block |
| `.claude-plugin/marketplace.json` | Claude Code | Marketplace entry |
| `.agents/plugins/marketplace.json` | `.agents` convention | Marketplace entry |

Only the standalone workflow-only plugin and its marketplace entries require a separately configured server. The MCPB, share ZIP, and server-bearing Agent Plugin bundle the skill with the server. See `docs/MCP_CONTRACT.md`, Native Skills, for the served extension contract; packaging is not a native-host activation claim.

## Conformance gaps

### 1. `${HOME}` and `${user_config.*}` do not exist

The MCPB server configuration is:

```json
"args": ["${__dirname}/server/index.js", "--allowed-directories", "${user_config.allowed_directories}"],
"env": {
  "DEFAULT_PROFILES_DIR": "${HOME}/.pdf-toolkit-files",
  "ALLOWED_DIRECTORIES": "${user_config.allowed_directories}"
}
```

Under Agent Plugins, `${__dirname}` becomes `${PLUGIN_ROOT}`, but `${HOME}` and every `${user_config.*}` reference stay **literal text**. The specification expands nothing else and defines no user-configuration mechanism.

It is worse than a missing expansion. §9.1 says the client "MAY inherit, omit, or sanitize ambient variables" and that "plugins claiming conformance MUST NOT depend on a base-environment variable" unless the specification requires it or the configuration supplies it explicitly. **`HOME` may not be present at all.** `os.homedir()`, `%USERPROFILE%`, and `$XDG_CONFIG_HOME` are therefore all non-conformant to depend on.

This supersedes an earlier draft of this document, which proposed resolving `~/.pdf-toolkit-files` server-side through the home directory. That is not conformant. The only guaranteed writable, persistent, per-install location is `${PLUGIN_DATA}`, which §9.1 requires the client to create before launch, keep writable, and preserve across plugin updates.

The cost of that is real and must be stated rather than hidden: `PLUGIN_DATA` is per-installed-plugin, so under Agent Plugins a signature or profile saved in one client is not visible in another. The honest resolution is a documented precedence — use an explicitly configured store path when supplied, otherwise `${PLUGIN_DATA}`, and keep the home-directory store only for the MCPB build where `${HOME}` is a supported expansion. Do not silently pick one and let users discover the split.

### 2. Native dependencies with no install lifecycle

`@napi-rs/canvas` resolves to one of eleven platform packages, and the specification has no install or build hook.

**Resolved: vendor into the plugin directory, no npm.** An earlier draft weighed publishing a scoped npm package and launching via `command: "npx"`. That was the wrong call — npm is not an Agent Plugins distribution channel at all (distribution is a git repo, a local directory, or a client marketplace; there is no registry), and `npx` would require a publish and a network round-trip at first run. The server and its production dependencies are carried under `${PLUGIN_ROOT}`, so startup needs no package installation or network access.

The manifest now launches `./bin/pdf-tools-launch`, with a POSIX executable and an adjacent Windows `.cmd` implementation in the package. This is necessary because Codex deliberately starts local MCP servers with a small environment: on Unix it preserves `HOME` and `PATH`, but it does not run an interactive shell profile or pass `NVM_DIR`/`NVM_BIN` unless the host explicitly supports those variables. A bare `command: "node"` therefore failed for a Windows user running Codex through WSL even though `node` worked in the user's regular NVM shell.

The launcher uses a compatible `node` already on `PATH`, then checks `NVM_BIN`, the default selected by NVM, and installed versions under the standard NVM home directories. It sources only `nvm.sh`, never `.bashrc` or `.zshrc`; it never downloads a runtime; and it rejects versions outside the package's `^20.19.0 || >=22.12.0` range with a clear stderr diagnostic. The Windows launcher checks `PATH`, NVM's active symlink, and version directories under the environment locations Codex preserves. One contained command remains portable because Codex resolves the adjacent `.cmd` through `PATHEXT` on Windows and executes the extensionless shebang file on POSIX hosts.

The package smoke test reads the generated `mcp.json` and launches that command. The former smoke used `process.execPath` directly, which proved the server worked once Node had already started but did not test the command a plugin host actually received.

The bundle is built by `scripts/build-agent-plugin.mjs` (`npm run build:plugin`), which reuses the MCPB build's `prepareCleanStage` verbatim — the same locked production dependencies, integrity-verified native canvas packages, secret scan, and symlink ban that gate the shipped `.mcpb`. It then drops the MCPB `manifest.json`, writes `plugin.json` and `mcp.json`, and copies the workflow skill and launchers. Reusing the stage rather than reimplementing it is deliberate: a second bundler would drift from the first.

Coverage matches the MCPB — the same five native platforms — so rasterization works everywhere the MCPB does, at roughly 175 MB unpacked. A smaller no-render variant (server plus a `PDF_RENDERER_UNAVAILABLE` message on the two render tools, ~33 MB) is a planned `--platforms` flag on the same builder, not yet implemented. `pdf-tools` and `pdf-toolkit-mcp` are both taken on npm by unrelated projects, which is now moot.

### 3. Package containment

Every path the client reads from the package must resolve inside the plugin root. Runtime paths the user supplies — the PDFs they ask us to open — are explicitly out of scope for that rule, so the existing allowed-directories model is unaffected. Anything fetched at first run rather than shipped in the package would be affected.

## Phase 1 — conformant skills-only plugin (this branch)

The existing workflow plugin becomes conformant by adding a root `plugin.json` next to the client-specific manifests. No rename, no `mcp.json`, no behavior change for existing Claude Code users, and nothing that depends on an unpublished npm package.

```text
plugins/pdf-tools-workflow/
├── plugin.json              # Agent Plugins 1.0.0 (new)
├── .claude-plugin/
│   └── plugin.json          # Claude Code (unchanged)
├── .codex-plugin/
│   └── plugin.json          # pre-standard Codex (retire after verification)
└── skills/
    └── pdf-tools-workflow/
        └── SKILL.md
```

This is immediately loadable by every launch client and is fully reversible.

Open validation items for phase 1:

- `skills/pdf-tools-workflow/agents/openai.yaml` is not a directory the Agent Skills specification names (`scripts/`, `references/`, `assets/`). Confirm clients tolerate it before assuming the skill loads everywhere.
- The SKILL.md non-claims list should narrow the viewer language: the component renders on MCP Apps hosts, and Cursor and Copilot are unverified.

## Phase 2 — server-bearing plugin (gated)

Adding `mcp.json` is gated on the portable allowed-directories work and a published package. Target shape:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "pdf-tools": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@open-document-alliance/pdf-tools@<version>", "--cache-dir", "${PLUGIN_DATA}/cache"],
      "cwd": "${PLUGIN_ROOT}"
    }
  }
}
```

### Portable allowed-directories requirements

**Implementation status.** Direct user-folder access is established only by explicit configuration. An unexpanded placeholder never becomes a home-folder grant. When Agent Plugins supplies `PLUGIN_DATA` and no direct folders are configured, PDF Tools creates and uses only `${PLUGIN_DATA}/workspace`. This makes a fresh install useful without treating Documents, Downloads, Desktop, or the rest of `PLUGIN_DATA` as implicitly approved.

`${PLUGIN_DATA}/config.json` remains the optional direct-folder layer, below the CLI flag and environment variable, and layers are never merged. A non-empty config replaces the private workspace. The workspace is a physical child directory (mode 0700 on POSIX; inherited plugin-data ACL on Windows); a symlink or other path that resolves outside `PLUGIN_DATA` fails closed. A configured set that reaches its own config file is refused whole rather than trimmed.

Direct-path widening deliberately remains a human action: the config file is edited by the operator, not by a PDF Tools tool. Import is different. A host with filesystem permission may copy a user-selected file into the workspace. That does not widen PDF Tools' direct path boundary; it exercises the host's separate authority.

`get_allowed_directories` reports the active set and distinguishes `plugin_workspace` from explicit configuration. Runtime narrowing and MCP roots intersection remain separate future work.

One consequence to carry into release notes: Agent Plugin installs no longer need a folder allowlist merely to start. They use the private import workspace unless the operator opts into direct folders.

1. Precedence, highest first: explicit CLI flag, `ALLOWED_DIRECTORIES`, non-empty `${PLUGIN_DATA}/config.json`, non-empty well-known home config, then the private plugin workspace. Layers are never merged.
2. **No implicit user-folder grant.** The private workspace is not Documents, Downloads, Desktop, the home directory, or all of `PLUGIN_DATA`. Without `PLUGIN_DATA`, an unconfigured generic stdio launch still refuses all file paths.
3. **Unresolved host configuration fails closed.** A value that still contains an unexpanded placeholder means the host did not configure us. That is a refusal, not a reason to substitute a default.
4. A tool may read the active set. **Direct widening requires a restart and an edit PDF Tools cannot perform.** The host may independently import a file into the private workspace when its own permission model allows that operation.
5. The config file and its directory are denied to every tool, compared by canonical path and by `(dev, ino)` rather than by string prefix, so a symlink alias cannot reach it.
6. If MCP roots are honored, they **intersect** the established set and never replace it. Roots are client-declared, and the protocol constrains nothing about what a client may declare.
7. Refusals are identical regardless of which precedence layer supplied the set, and identical across every tool.
8. Tests cover each precedence layer, workspace creation and mode, direct access denial outside the workspace, self-configuration denial, symlink escape, and unresolved placeholders.

This is a PDF Tools direct-call boundary, not a source-confidentiality boundary against the host. Host filesystem permission, PDF Tools path policy, and model-provider data handling are separate controls and must be described separately.

## Acceptance gates

Per the product decision gate, a new host adapter is accepted only with evidence. For this work that means:

- The package validates against the published `plugin.schema.json` and, in phase 2, `mcp.schema.json`.
- The skill loads and the documented workflow runs on at least one non-Anthropic launch client, with the transcript retained.
- The viewer either renders on that client or the limitation is documented per host — no aggregate claim.
- Every dependency added for packaging has its license, version, and intended use recorded before it lands.
- Existing Claude Desktop MCPB behavior is unchanged by phase 1, verified rather than assumed.

## What this does not claim

- It does not claim Cursor or GitHub Copilot support for the MCP Apps viewer.
- It does not claim any host renders the viewer without a per-host test.
- It does not claim the standard replaces MCP. MCP remains the connectivity layer; Agent Plugins is packaging only.
- It does not claim Anthropic clients read root `plugin.json` today. Claude Code reads `.claude-plugin/plugin.json`; support for the standard has been described publicly as forthcoming, not shipped.

## References

- Agent Plugins specification 1.0.0 — https://github.com/agentplugins/agent-plugins-spec
- Introducing Agent Plugins — https://vercel.com/blog/introducing-agent-plugins
- MCP Apps — https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/
- Adding UI to an MCP server (OpenAI) — https://developers.openai.com/plugins/build/chatgpt-ui
- Agent Skills specification — https://agentskills.io/specification
- Claude Code plugins reference — https://code.claude.com/docs/en/plugins-reference
