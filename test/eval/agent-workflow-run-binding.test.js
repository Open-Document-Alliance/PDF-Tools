import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindAgentWorkflowRun,
} from "../../scripts/eval-bind-agent-workflow-run.mjs";
import {
  inventory as campaignInventory,
  prepareAgentWorkflowCampaign,
  syntheticGitIdentity,
} from "../../scripts/eval-prepare-agent-workflow-campaign.mjs";
import {
  artifactRecordFromHandle,
  CAMPAIGN_ISOLATION_SCHEMA_VERSION,
  campaignTraversalMetadataRoots,
  CODEX_ENVIRONMENT_NAMES,
  codexBaseContextArgs,
  codexEnvironment,
  codexSandboxProfile,
  isCleanProcessResult,
  PRIVATE_CREATION_UMASK,
  RUNNER_API_VERSION,
  runCaptured,
  runCodexAgentWorkflowCase,
  validateBaseContextCapture,
  withPrivateRunnerUmask,
} from "../../scripts/eval-run-codex-agent-workflow-case.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const roots = [];
const darwinIt = process.platform === "darwin" ? it : it.skip;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })));
});

describe("Codex workflow environment", () => {
  it("binds the platform-effective minimal environment", () => {
    expect(RUNNER_API_VERSION).toBe(
      "pdf-tools.agent-workflow-runner.r14-v1",
    );
    expect(CAMPAIGN_ISOLATION_SCHEMA_VERSION).toBe(
      "pdf-tools.agent-workflow-campaign-isolation.v2-r14",
    );
    const codexHome = path.join(os.tmpdir(), "sealed-codex-home");
    const environment = codexEnvironment(codexHome);

    expect(Object.keys(environment).sort()).toEqual(CODEX_ENVIRONMENT_NAMES);
    expect(environment.CODEX_HOME).toBe(codexHome);
    expect(environment.TMPDIR).toBe(path.join(codexHome, "tmp"));
    expect(environment).not.toHaveProperty("HOME");

    if (process.platform === "darwin") {
      expect(environment.__CF_USER_TEXT_ENCODING).toBe(
        `0x${process.getuid().toString(16).toUpperCase()}:0x0:0x0`,
      );
      const effectiveEnvironment = JSON.parse(execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "process.stdout.write(JSON.stringify(process.env))",
        ],
        {
          encoding: "utf8",
          env: environment,
        },
      ));
      expect(effectiveEnvironment).toEqual(environment);
    } else {
      expect(environment).not.toHaveProperty("__CF_USER_TEXT_ENCODING");
    }
  });
});

async function fakeCodex(root, writeStyle = "direct") {
  const filename = path.join(root, "fake-codex.mjs");
  const invocationPath = path.join(root, "fake-codex-invocations.txt");
  const argvPath = path.join(root, "fake-codex-argv.jsonl");
  await fs.writeFile(filename, `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "--version") {
  process.stdout.write("codex-cli synthetic\\n");
} else if (args[0] === "exec") {
  const invocationPath = ${JSON.stringify(invocationPath)};
  const prior = fs.existsSync(invocationPath)
    ? Number.parseInt(fs.readFileSync(invocationPath, "utf8"), 10)
    : 0;
  fs.writeFileSync(invocationPath, String(prior + 1));
  let prompt = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) prompt += chunk;
  const caseId = prompt.match(/Case ID: ([a-z0-9-]+)/)?.[1];
  const response = { case_id: caseId };
  const output = args[args.indexOf("--output-last-message") + 1];
  const identity = path.basename(process.cwd()).replace(/[^a-zA-Z0-9_]/g, "_");
  const body = JSON.stringify(response);
  const writeStyle = ${JSON.stringify(writeStyle)};
  if (writeStyle === "rename") {
    const temporary = output + ".replacement";
    fs.writeFileSync(temporary, body);
    fs.renameSync(temporary, output);
  } else if (writeStyle === "unsafe-mode") {
    fs.writeFileSync(output, body);
    fs.chmodSync(output, 0o644);
  } else if (writeStyle === "symlink") {
    const target = output + ".target";
    fs.writeFileSync(target, body);
    fs.unlinkSync(output);
    fs.symlinkSync(target, output);
  } else if (writeStyle === "hardlink") {
    const target = output + ".target";
    fs.writeFileSync(target, body);
    fs.unlinkSync(output);
    fs.linkSync(target, output);
  } else {
    fs.writeFileSync(output, body);
  }
  const events = [
    { type: "thread.started", thread_id: \`thread_\${identity}\` },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: { id: \`item_\${identity}\`, type: "agent_message", text: JSON.stringify(response) },
    },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  process.stdout.write(events.map(event => JSON.stringify(event)).join("\\n") + "\\n");
} else if (args[0] === "debug" && args[1] === "prompt-input") {
  const separator = args.lastIndexOf("--");
  const prompt = separator === -1 ? args.at(-1) : args[separator + 1];
  const skill = path.join(
    process.cwd(),
    ".agents",
    "skills",
    "pdf-tools-workflow",
    "SKILL.md",
  );
  const inventory = fs.existsSync(skill) ? \`\\nfile: \${skill}\` : "";
  const metadata = { turn_id: "auto-compact-0" };
  // Keep the synthetic capture minimal: the optional closing </root> tag
  // collides with the unchanged denied-home substring check for Linux root.
  const environment = { type: "message", role: "user", internal_chat_message_metadata_passthrough: metadata, content: [{ type: "input_text", text: \`<environment_context><cwd>\${process.cwd()}</cwd></environment_context>\` }] };
  const context = prompt === undefined ? [
    { type: "message", role: "developer", internal_chat_message_metadata_passthrough: metadata, content: [
      { type: "input_text", text: "synthetic base policy" },
      { type: "input_text", text: "synthetic tool policy" },
    ] },
    { type: "message", role: "developer", internal_chat_message_metadata_passthrough: metadata, content: [{ type: "input_text", text: "synthetic workflow policy" }] },
    { type: "message", role: "developer", internal_chat_message_metadata_passthrough: metadata, content: [{ type: "input_text", text: "synthetic safety policy" }] },
    environment,
  ] : [
    { type: "message", role: "developer", internal_chat_message_metadata_passthrough: metadata, content: [{ type: "input_text", text: inventory }] },
    environment,
  ];
  if (prompt !== undefined) {
    context.push({ type: "message", role: "user", internal_chat_message_metadata_passthrough: metadata, content: [{ type: "input_text", text: prompt }] });
  }
  process.stdout.write(JSON.stringify(context));
} else {
  process.exitCode = 2;
}
`);
  await fs.chmod(filename, 0o700);
  return { filename, invocationPath, argvPath };
}

async function fakeSandbox(root) {
  const filename = path.join(root, "fake-sandbox.mjs");
  await fs.writeFile(filename, `#!${process.execPath}
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
if (args[0] !== "-p" || args.length < 4) process.exit(2);
const child = spawn(args[2], args.slice(3), { stdio: "inherit" });
child.once("error", () => process.exit(2));
child.once("close", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 2);
});
`);
  await fs.chmod(filename, 0o700);
  return filename;
}

async function executableFixture(root, name, source) {
  const filename = path.join(root, name);
  await fs.writeFile(filename, `#!${process.execPath}\n${source}`);
  await fs.chmod(filename, 0o700);
  return filename;
}

async function preparedRun({
  protocolId = "metadata-regression-v1",
  arm = "codex-explicit-skill",
  caseId = "missing-identity-fails-closed",
  responseWriteStyle = "direct",
  replaceResponseInPreInferenceHook = false,
  expectFailure = false,
} = {}) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pdf-workflow-bound-run-")),
  );
  roots.push(root);
  const participants = path.join(root, "participants");
  const oracle = path.join(root, "oracle");
  const manifest = await prepareAgentWorkflowCampaign({
    participantsDestination: participants,
    oracleDestination: oracle,
    protocolId,
  });
  const materialArm = manifest.explicit_case_attestations[arm]
    ? arm
    : "codex-explicit-skill";
  const scheduled = manifest.run_schedule.find(entry =>
    entry.arm === arm && entry.case_id === caseId);
  const caseRoot = path.join(root, "case");
  await fs.cp(
    path.join(participants, arm, "cases", caseId),
    caseRoot,
    { recursive: true },
  ).catch(async error => {
    if (materialArm === arm) throw error;
    await fs.cp(
      path.join(participants, materialArm, "cases", caseId),
      caseRoot,
      { recursive: true },
    );
  });
  const codexHome = path.join(root, "codex-home");
  const promptCaptureHome = path.join(root, "prompt-capture-home");
  await fs.mkdir(codexHome, { mode: 0o700 });
  await fs.mkdir(promptCaptureHome, { mode: 0o700 });
  await fs.writeFile(path.join(codexHome, "auth.json"), "{}\n", { mode: 0o600 });
  await fs.writeFile(
    path.join(promptCaptureHome, "auth.json"),
    "{}\n",
    { mode: 0o600 },
  );
  const resultsRoot = path.join(root, "results");
  const heldout = arm.startsWith("codex-prompt-");
  let heldoutPromptMarker = null;
  let expected = manifest.explicit_case_attestations[materialArm][caseId];
  if (heldout) {
    heldoutPromptMarker = await fs.readFile(
      path.join(caseRoot, "prompt.txt"),
      "utf8",
    );
    await fs.writeFile(
      path.join(caseRoot, "prompt.txt"),
      [
        "SKILL_BODY_BEGIN",
        "synthetic held-out skill body",
        "SKILL_BODY_END",
        "CASE_BODY_BEGIN",
        heldoutPromptMarker,
        "CASE_BODY_END",
        "",
      ].join("\n"),
    );
    const [contentInventory, syntheticGit] = await Promise.all([
      campaignInventory(caseRoot),
      syntheticGitIdentity(caseRoot),
    ]);
    expected = {
      synthetic_git: syntheticGit,
      content_inventory: contentInventory,
    };
  }
  const fake = await fakeCodex(root, responseWriteStyle);
  let isolation = null;
  let lifecycle = null;
  if (heldout) {
    const controlRoot = `${root}.control`;
    roots.push(controlRoot);
    const sealedBundleRoot = path.join(root, "sealed-bundle");
    const receiptControlRoot = path.join(controlRoot, "receipt-control");
    const authSensitiveRoot = path.join(controlRoot, "auth-source");
    const additionalSensitiveRoot = path.join(controlRoot, "other-sensitive");
    await fs.mkdir(controlRoot, { mode: 0o700 });
    await Promise.all([
      fs.mkdir(sealedBundleRoot, { mode: 0o700 }),
      fs.mkdir(receiptControlRoot, { mode: 0o700 }),
      fs.mkdir(authSensitiveRoot, { mode: 0o700 }),
      fs.mkdir(additionalSensitiveRoot, { mode: 0o700 }),
    ]);
    isolation = {
      schema_version: CAMPAIGN_ISOLATION_SCHEMA_VERSION,
      denied_roots: {
        operator_home: await fs.realpath(os.userInfo().homedir),
        campaign_evidence_control_root: root,
        sealed_bundle_root: sealedBundleRoot,
        source_repo_root: REPO_ROOT,
        receipt_control_roots: [receiptControlRoot],
        auth_sensitive_roots: [authSensitiveRoot],
        additional_sensitive_roots: [additionalSensitiveRoot],
      },
    };
    lifecycle = {
      schema_version: "pdf-tools.agent-workflow-process-lifecycle.v1",
      prompt_input_timeout_ms: 2_000,
      inference_timeout_ms: 2_000,
      termination_grace_ms: 50,
    };
  }
  let runError = null;
  let preInferenceEvidence = null;
  let processEvidence = null;
  try {
    await runCodexAgentWorkflowCase({
      arm,
      caseId,
      caseRoot,
      resultsRoot,
      codexHome,
      promptCaptureHome,
      codexBinary: fake.filename,
      sandboxBinary: await fakeSandbox(root),
      attesterPath: path.join(
        REPO_ROOT,
        "scripts",
        "eval-attest-agent-workflow-arm.mjs",
      ),
      expectedCommitSha1: expected.synthetic_git.expected_commit_sha1,
      expectedTreeSha1: expected.synthetic_git.expected_tree_sha1,
      expectedContentTreeSha256: expected.content_inventory.tree_sha256,
      sourceCommit: manifest.source_commit,
      model: "synthetic-model",
      isolation,
      lifecycle,
      forbiddenContextMarkers: heldout
        ? [heldoutPromptMarker, "CASE_BODY_BEGIN", "SKILL_BODY_BEGIN"]
        : null,
      onPreInferenceReady: async evidence => {
        preInferenceEvidence = structuredClone(evidence);
        if (replaceResponseInPreInferenceHook) {
          const replacement = path.join(resultsRoot, "response.replacement");
          await fs.writeFile(replacement, Buffer.alloc(0), { mode: 0o600 });
          await fs.rename(replacement, path.join(resultsRoot, "response.json"));
        }
      },
      onProcessComplete: async evidence => {
        processEvidence = structuredClone(evidence);
      },
      runId: scheduled?.run_id ?? `${caseId}-r1-${arm}`,
      scheduleOrdinal: scheduled?.ordinal ?? 1,
      repeatIndex: scheduled?.repeat_index ?? 1,
      pairId: scheduled?.pair_id ?? `${caseId}-r1`,
      pairPosition: scheduled?.pair_position ?? 1,
      scheduleSha256: manifest.run_schedule_sha256,
    });
  } catch (error) {
    if (!expectFailure) throw error;
    runError = error;
  }
  return {
    root,
    arm,
    caseId,
    resultsRoot,
    manifestPath: path.join(oracle, "preparation-manifest.json"),
    scheduled,
    runError,
    invocationPath: fake.invocationPath,
    argvPath: fake.argvPath,
    preInferenceEvidence,
    processEvidence,
    isolation,
    lifecycle,
    heldoutPromptMarker,
  };
}

async function preparedHeldoutRunnerRun() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pdf-workflow-heldout-runner-")),
  );
  roots.push(root);
  const controlRoot = `${root}.control`;
  roots.push(controlRoot);
  const caseId = "source-runner-isolation";
  const caseRoot = path.join(root, "case");
  const resultsRoot = path.join(root, "results");
  const codexHome = path.join(root, "codex-home");
  const promptCaptureHome = path.join(root, "prompt-capture-home");
  const sealedBundleRoot = path.join(root, "sealed-bundle");
  const receiptControlRoot = path.join(controlRoot, "receipt-control");
  const authSensitiveRoot = path.join(controlRoot, "auth-source");
  const additionalSensitiveRoot = path.join(controlRoot, "other-sensitive");
  await fs.mkdir(controlRoot, { mode: 0o700 });
  await Promise.all([
    fs.mkdir(caseRoot, { mode: 0o700 }),
    fs.mkdir(codexHome, { mode: 0o700 }),
    fs.mkdir(promptCaptureHome, { mode: 0o700 }),
    fs.mkdir(sealedBundleRoot, { mode: 0o700 }),
    fs.mkdir(receiptControlRoot, { mode: 0o700 }),
    fs.mkdir(authSensitiveRoot, { mode: 0o700 }),
    fs.mkdir(additionalSensitiveRoot, { mode: 0o700 }),
  ]);
  const casePrompt = [
    `Case ID: ${caseId}`,
    "Sealed case prompt sentinel: source-runner-must-not-leak-this-text.",
    "Return the case identifier only.",
  ].join("\n");
  const prompt = [
    "Planning-only synthetic held-out transport fixture.",
    "SKILL_BODY_BEGIN",
    "Synthetic skill body.",
    "SKILL_BODY_END",
    "CASE_BODY_BEGIN",
    casePrompt,
    "CASE_BODY_END",
    "",
  ].join("\n");
  await Promise.all([
    fs.writeFile(path.join(caseRoot, "prompt.txt"), prompt, { mode: 0o600 }),
    fs.writeFile(
      path.join(caseRoot, "response-schema.json"),
      `${JSON.stringify({
        type: "object",
        additionalProperties: false,
        properties: { case_id: { type: "string" } },
        required: ["case_id"],
      })}\n`,
      { mode: 0o600 },
    ),
    fs.writeFile(path.join(codexHome, "auth.json"), "{}\n", { mode: 0o600 }),
    fs.writeFile(
      path.join(promptCaptureHome, "auth.json"),
      "{}\n",
      { mode: 0o600 },
    ),
  ]);
  const [contentInventory, syntheticGit, fake, sandboxBinary] = await Promise.all([
    campaignInventory(caseRoot),
    syntheticGitIdentity(caseRoot),
    fakeCodex(root),
    fakeSandbox(root),
  ]);
  const isolation = {
    schema_version: CAMPAIGN_ISOLATION_SCHEMA_VERSION,
    denied_roots: {
      operator_home: await fs.realpath(os.userInfo().homedir),
      campaign_evidence_control_root: root,
      sealed_bundle_root: sealedBundleRoot,
      source_repo_root: REPO_ROOT,
      receipt_control_roots: [receiptControlRoot],
      auth_sensitive_roots: [authSensitiveRoot],
      additional_sensitive_roots: [additionalSensitiveRoot],
    },
  };
  const lifecycle = {
    schema_version: "pdf-tools.agent-workflow-process-lifecycle.v1",
    prompt_input_timeout_ms: 2_000,
    inference_timeout_ms: 2_000,
    termination_grace_ms: 50,
  };
  let preInferenceEvidence = null;
  let processEvidence = null;
  await runCodexAgentWorkflowCase({
    arm: "codex-prompt-no-skill-body",
    caseId,
    caseRoot,
    resultsRoot,
    codexHome,
    promptCaptureHome,
    codexBinary: fake.filename,
    sandboxBinary,
    attesterPath: path.join(
      REPO_ROOT,
      "scripts",
      "eval-attest-agent-workflow-arm.mjs",
    ),
    expectedCommitSha1: syntheticGit.expected_commit_sha1,
    expectedTreeSha1: syntheticGit.expected_tree_sha1,
    expectedContentTreeSha256: contentInventory.tree_sha256,
    sourceCommit: "1".repeat(40),
    model: "synthetic-model",
    runId: `${caseId}-r1-codex-prompt-no-skill-body`,
    scheduleOrdinal: 1,
    repeatIndex: 1,
    pairId: `${caseId}-r1`,
    pairPosition: 1,
    scheduleSha256: "2".repeat(64),
    isolation,
    lifecycle,
    forbiddenContextMarkers: [
      "CASE_BODY_BEGIN",
      "SKILL_BODY_BEGIN",
      casePrompt,
    ],
    onPreInferenceReady: async evidence => {
      preInferenceEvidence = structuredClone(evidence);
    },
    onProcessComplete: async evidence => {
      processEvidence = structuredClone(evidence);
    },
  });
  return {
    root,
    resultsRoot,
    heldoutPromptMarker: casePrompt,
    argvPath: fake.argvPath,
    preInferenceEvidence,
    processEvidence,
  };
}

describe("held-out campaign isolation and process lifecycle", () => {
  it("derives only the two production traversal ancestors", () => {
    const outputRoot = "/private/var/tmp/oda-r14-canary";
    const runRoot = path.join(outputRoot, "run");
    expect(campaignTraversalMetadataRoots({
      campaignEvidenceControlRoot: outputRoot,
      allowedRoots: [
        path.join(runRoot, "case"),
        path.join(runRoot, "results"),
        path.join(runRoot, "codex-home"),
        path.join(runRoot, "prompt-capture-home"),
      ],
    })).toEqual([outputRoot, runRoot]);
  });

  it("orders the Seatbelt boundary and never places the held-out prompt in argv or receipts", async () => {
    const run = await preparedHeldoutRunnerRun();
    const launchPlan = JSON.parse(await fs.readFile(
      path.join(run.resultsRoot, "launch-plan.json"),
      "utf8",
    ));
    const launchOutcome = JSON.parse(await fs.readFile(
      path.join(run.resultsRoot, "launch-outcome.json"),
      "utf8",
    ));
    const profile = launchPlan.isolation.sandbox_profile;
    const campaignDeny = profile.indexOf(
      `(deny file-read* (subpath "${run.root}"))`,
    );
    const caseAllow = profile.indexOf(
      `(allow file-read* (subpath "${path.join(run.root, "case")}"))`,
    );
    const traversalAllow = profile.indexOf(
      `(allow file-read-metadata (literal "${run.root}"))`,
    );
    const receiptDeny = profile.indexOf(
      `(deny file-read* (subpath "${path.join(
        `${run.root}.control`,
        "receipt-control",
      )}"))`,
    );
    expect(campaignDeny).toBeGreaterThan(-1);
    expect(traversalAllow).toBeGreaterThan(campaignDeny);
    expect(caseAllow).toBeGreaterThan(campaignDeny);
    expect(caseAllow).toBeGreaterThan(traversalAllow);
    expect(receiptDeny).toBeGreaterThan(caseAllow);
    expect(launchPlan.isolation.campaign.metadata_allowed_roots).toEqual([
      run.root,
    ]);
    expect(launchPlan.isolation.campaign.ordered_rule_classes).toEqual([
      "broad_deny",
      "current_attempt_traversal_allow",
      "current_attempt_allow",
      "protected_deny",
    ]);
    expect(launchPlan.runner_api_version).toBe(RUNNER_API_VERSION);
    expect(run.preInferenceEvidence.runner_api_version).toBe(RUNNER_API_VERSION);
    expect(run.processEvidence.runner_api_version).toBe(RUNNER_API_VERSION);
    expect(launchPlan.isolation.sandbox_profile_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(launchPlan.isolation.isolation_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(launchPlan.lifecycle.lifecycle_policy_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(run.preInferenceEvidence.isolation_sha256).toBe(
      launchPlan.isolation.isolation_sha256,
    );
    expect(run.preInferenceEvidence.lifecycle_policy_sha256).toBe(
      launchPlan.lifecycle.lifecycle_policy_sha256,
    );
    expect(run.processEvidence.isolation_sha256).toBe(
      launchPlan.isolation.isolation_sha256,
    );
    expect(run.processEvidence.lifecycle_policy_sha256).toBe(
      launchPlan.lifecycle.lifecycle_policy_sha256,
    );
    expect(run.preInferenceEvidence.base_context_capture).toMatchObject({
      item_count: 4,
      content_item_count: 5,
      heldout_prompt_absent: true,
      ordered_content: [
        { role: "developer", content_count: 2 },
        { role: "developer", content_count: 1 },
        { role: "developer", content_count: 1 },
        { role: "user", content_count: 1 },
      ],
    });
    const promptFragments = [
      run.heldoutPromptMarker,
      "CASE_BODY_BEGIN",
      "SKILL_BODY_BEGIN",
    ];
    const receiptStrings = [
      JSON.stringify(launchPlan),
      JSON.stringify(launchOutcome),
      JSON.stringify(run.preInferenceEvidence),
      JSON.stringify(run.processEvidence),
    ];
    for (const fragment of promptFragments) {
      expect(receiptStrings.every(value => !value.includes(fragment))).toBe(true);
    }
    const invocations = (await fs.readFile(run.argvPath, "utf8"))
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    const promptCapture = invocations.find(args =>
      args[0] === "debug" && args[1] === "prompt-input");
    expect(promptCapture).toEqual(codexBaseContextArgs());
    expect(promptCapture.at(-1)).toBe("--");
    for (const fragment of promptFragments) {
      expect(JSON.stringify(invocations)).not.toContain(fragment);
    }
  }, 15000);

  darwinIt("allows exact runtime-root traversal without exposing broad or sibling data", async () => {
    const outputRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "pdf-workflow-r14-seatbelt-")),
    );
    roots.push(outputRoot);
    const controlRoot = `${outputRoot}.control`;
    roots.push(controlRoot);
    const runRoot = path.join(outputRoot, "run");
    const allowedRoots = [
      path.join(runRoot, "case"),
      path.join(runRoot, "results"),
      path.join(runRoot, "codex-home"),
      path.join(runRoot, "prompt-capture-home"),
    ];
    const siblingRoot = path.join(runRoot, "future-attempt");
    const protectedRoot = path.join(controlRoot, "receipts");
    await fs.mkdir(controlRoot, { mode: 0o700 });
    await fs.mkdir(runRoot, { mode: 0o700 });
    await Promise.all([
      ...allowedRoots.map(root => fs.mkdir(root, { mode: 0o700 })),
      fs.mkdir(siblingRoot, { mode: 0o700 }),
      fs.mkdir(protectedRoot, { mode: 0o700 }),
    ]);
    const broadSentinel = path.join(outputRoot, "broad-sentinel.txt");
    const siblingSentinel = path.join(siblingRoot, "sibling-sentinel.txt");
    const protectedSentinel = path.join(
      protectedRoot,
      "protected-sentinel.txt",
    );
    const deniedCreatePath = path.join(
      siblingRoot,
      ".r14-denied-create",
    );
    await Promise.all([
      fs.writeFile(broadSentinel, "broad", { mode: 0o600 }),
      fs.writeFile(siblingSentinel, "sibling", { mode: 0o600 }),
      fs.writeFile(protectedSentinel, "protected", { mode: 0o600 }),
    ]);
    const profile = codexSandboxProfile({
      broadDeniedRoots: [outputRoot],
      metadataAllowedRoots: campaignTraversalMetadataRoots({
        campaignEvidenceControlRoot: outputRoot,
        allowedRoots,
      }),
      allowedRoots,
      protectedDeniedRoots: [protectedRoot],
    });
    const allowedScript = [
      "const fs=require('node:fs');",
      "const path=require('node:path');",
      "for(const root of JSON.parse(process.argv[1])){",
      " if(fs.realpathSync(root)!==root)throw new Error('noncanonical');",
      " const fd=fs.openSync(root,fs.constants.O_RDONLY",
      "  |fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);",
      " fs.closeSync(fd);fs.readdirSync(root);",
      " const f=path.join(root,'.r14-runtime-probe');",
      " fs.writeFileSync(f,'r14',{flag:'wx',mode:0o600});",
      " if(fs.readFileSync(f,'utf8')!=='r14')throw new Error('readback');",
      " fs.unlinkSync(f);",
      "}",
      "process.stdout.write('allowed');",
    ].join("");
    expect(execFileSync(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        profile,
        process.execPath,
        "-e",
        allowedScript,
        JSON.stringify(allowedRoots),
      ],
      { encoding: "utf8" },
    )).toBe("allowed");

    const operationScript = [
      "const fs=require('node:fs');",
      "const path=require('node:path');",
      "const op=process.argv[1],target=process.argv[2];",
      "try{",
      " if(op==='realpath')fs.realpathSync(target);",
      " else if(op==='readdir')fs.readdirSync(target);",
      " else if(op==='read')fs.readFileSync(target);",
      " else if(op==='write'){const fd=fs.openSync(target,",
      "  fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW);fs.closeSync(fd);}",
      " else if(op==='create'){const f=path.join(target,'.r14-denied-create');",
      "  fs.writeFileSync(f,'created',{flag:'wx',mode:0o600});fs.unlinkSync(f);}",
      " else throw new Error('unknown operation');",
      " process.stdout.write(JSON.stringify({ok:true,code:null}));",
      "}catch(e){process.stdout.write(JSON.stringify({ok:false,code:e.code||null}));}",
    ].join("");
    const deniedTargets = [
      { op: "readdir", path: outputRoot },
      { op: "readdir", path: runRoot },
      { op: "realpath", path: siblingRoot },
      { op: "read", path: broadSentinel },
      { op: "write", path: broadSentinel },
      { op: "read", path: siblingSentinel },
      { op: "write", path: siblingSentinel },
      { op: "create", path: siblingRoot },
      { op: "realpath", path: protectedRoot },
      { op: "read", path: protectedSentinel },
      { op: "write", path: protectedSentinel },
    ];
    for (const target of deniedTargets) {
      expect(JSON.parse(execFileSync(
        process.execPath,
        ["-e", operationScript, target.op, target.path],
        { encoding: "utf8" },
      ))).toEqual({ ok: true, code: null });
      const sandboxed = JSON.parse(execFileSync(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          profile,
          process.execPath,
          "-e",
          operationScript,
          target.op,
          target.path,
        ],
        { encoding: "utf8" },
      ));
      expect(sandboxed.ok).toBe(false);
      expect(["EACCES", "EPERM"]).toContain(sandboxed.code);
    }
    await expect(fs.readFile(broadSentinel, "utf8")).resolves.toBe("broad");
    await expect(fs.readFile(siblingSentinel, "utf8")).resolves.toBe(
      "sibling",
    );
    await expect(fs.readFile(protectedSentinel, "utf8")).resolves.toBe(
      "protected",
    );
    await expect(fs.stat(deniedCreatePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 15000);

  it("rejects malformed isolation and injected base-context material before inference", async () => {
    const profile = codexSandboxProfile({
      broadDeniedRoots: ["/private/campaign"],
      metadataAllowedRoots: [
        "/private/campaign",
        "/private/campaign/run",
      ],
      allowedRoots: ["/private/campaign/run/current"],
      protectedDeniedRoots: ["/private/campaign.control/receipts"],
    });
    expect(profile.indexOf(
      `(allow file-read-metadata (literal "/private/campaign"))`,
    )).toBeGreaterThan(profile.indexOf(
      `(deny file-write* (subpath "/private/campaign"))`,
    ));
    expect(profile.indexOf("/private/campaign/run/current")).toBeGreaterThan(
      profile.indexOf(
        `(allow file-read-metadata (literal "/private/campaign/run"))`,
      ),
    );
    expect(profile.indexOf("/private/campaign.control/receipts")).toBeGreaterThan(
      profile.indexOf("/private/campaign/run/current"),
    );
    const caseRoot = "/private/campaign/current/case";
    const exactCapture = [
      {
        type: "message",
        role: "developer",
        internal_chat_message_metadata_passthrough: {
          turn_id: "auto-compact-0",
        },
        content: [
          { type: "input_text", text: "base policy" },
          { type: "input_text", text: "tool policy" },
        ],
      },
      {
        type: "message",
        role: "developer",
        internal_chat_message_metadata_passthrough: {
          turn_id: "auto-compact-0",
        },
        content: [{ type: "input_text", text: "workflow policy" }],
      },
      {
        type: "message",
        role: "developer",
        internal_chat_message_metadata_passthrough: {
          turn_id: "auto-compact-0",
        },
        content: [{ type: "input_text", text: "safety policy" }],
      },
      {
        type: "message",
        role: "user",
        internal_chat_message_metadata_passthrough: {
          turn_id: "auto-compact-0",
        },
        content: [{
          type: "input_text",
          text: `<environment_context><cwd>${caseRoot}</cwd></environment_context>`,
        }],
      },
    ];
    const options = {
      forbiddenPrompt: [
        "SKILL_BODY_BEGIN",
        "CASE_BODY_BEGIN",
        "sealed case prompt sentinel",
      ].join("\n"),
      caseRoot,
      forbiddenContextMarkers: [
        "SKILL_BODY_BEGIN",
        "CASE_BODY_BEGIN",
        "sealed case prompt sentinel",
      ],
    };
    const evidence = validateBaseContextCapture(
      Buffer.from(JSON.stringify(exactCapture)),
      options,
    );
    expect(evidence.ordered_content.flatMap(item => item.content)).toHaveLength(5);
    const injected = structuredClone(exactCapture);
    injected[1].content[0].text = "sealed case prompt sentinel";
    expect(() => validateBaseContextCapture(
      Buffer.from(JSON.stringify(injected)),
      options,
    )).toThrow(/held-out material/);
    const extraItem = structuredClone(exactCapture);
    extraItem.push(structuredClone(exactCapture[3]));
    expect(() => validateBaseContextCapture(
      Buffer.from(JSON.stringify(extraItem)),
      options,
    )).toThrow(/unexpected message sequence/);
  });

  it("times out and reaps a detached process group including an ignoring grandchild", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "runner-timeout-group-")),
    );
    roots.push(root);
    const grandchildPidPath = path.join(root, "grandchild.pid");
    const grandchildReadyPath = path.join(root, "grandchild.ready");
    const parentReadyPath = path.join(root, "parent.ready");
    const program = await executableFixture(root, "group-parent.mjs", `
import { spawn } from "node:child_process";
import fs from "node:fs";
process.on("SIGTERM", () => {});
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(
  `const fs=require("node:fs");process.on("SIGTERM",()=>{});fs.writeFileSync(${JSON.stringify(
    grandchildReadyPath,
  )},"ready");setInterval(()=>{},1000);`,
)}], {
  detached: false,
  stdio: "ignore",
});
while (!fs.existsSync(${JSON.stringify(grandchildReadyPath)})) {
  await new Promise(resolve => setTimeout(resolve, 5));
}
fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));
fs.writeFileSync(${JSON.stringify(parentReadyPath)}, "ready");
setInterval(() => {}, 1000);
`);
    const timeoutMs = process.platform === "darwin" ? 2_000 : 300;
    const result = await runCaptured(program, [], {
      cwd: root,
      env: process.env,
      stdoutPath: path.join(root, "stdout.txt"),
      stderrPath: path.join(root, "stderr.txt"),
      timeoutMs,
      terminationGraceMs: process.platform === "darwin" ? 100 : 25,
      useProcessGroup: true,
    });
    expect(result).toMatchObject({
      timed_out: true,
      aborted: false,
      termination_reason: "timeout",
      sigterm_attempted: true,
      sigterm_sent: true,
      process_group_alive_after_close: false,
    });
    expect(["SIGTERM", "SIGKILL"]).toContain(result.signal);
    if (result.signal === "SIGKILL") {
      expect(result).toMatchObject({
        sigkill_attempted: true,
        sigkill_sent: true,
      });
    } else {
      expect(result).toMatchObject({
        sigkill_attempted: false,
        sigkill_sent: false,
      });
    }
    expect(isCleanProcessResult(result)).toBe(false);
    expect(await fs.readFile(parentReadyPath, "utf8")).toBe("ready");
    expect(await fs.readFile(grandchildReadyPath, "utf8")).toBe("ready");
    const grandchildPid = Number(await fs.readFile(grandchildPidPath, "utf8"));
    for (const pid of [result.pid, grandchildPid]) {
      expect(() => process.kill(pid, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    }
  }, 5000);

  it("reaps but rejects a leaked descendant after the direct child exits", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "runner-leaked-group-")),
    );
    roots.push(root);
    const grandchildPidPath = path.join(root, "leaked-grandchild.pid");
    const grandchildReadyPath = path.join(root, "leaked-grandchild.ready");
    const program = await executableFixture(root, "leaking-parent.mjs", `
import { spawn } from "node:child_process";
import fs from "node:fs";
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(
  `const fs=require("node:fs");process.on("SIGTERM",()=>{});fs.writeFileSync(${JSON.stringify(
    grandchildReadyPath,
  )},"ready");setInterval(()=>{},1000);`,
)}], {
  detached: false,
  stdio: "ignore",
});
while (!fs.existsSync(${JSON.stringify(grandchildReadyPath)})) {
  await new Promise(resolve => setTimeout(resolve, 5));
}
fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));
grandchild.unref();
`);
    const result = await runCaptured(program, [], {
      cwd: root,
      env: process.env,
      stdoutPath: path.join(root, "stdout.txt"),
      stderrPath: path.join(root, "stderr.txt"),
      timeoutMs: 1_000,
      terminationGraceMs: 25,
      useProcessGroup: true,
    });
    expect(result).toMatchObject({
      code: 0,
      signal: null,
      timed_out: false,
      aborted: false,
      termination_reason: "process_group_reap",
      sigterm_attempted: true,
      sigkill_attempted: true,
      process_group_alive_after_close: false,
    });
    expect(isCleanProcessResult(result)).toBe(false);
    const grandchildPid = Number(await fs.readFile(grandchildPidPath, "utf8"));
    expect(() => process.kill(grandchildPid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  }, 5000);

  it("records a post-close EPERM race without crashing cleanup", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "runner-eperm-group-")),
    );
    roots.push(root);
    const grandchildReadyPath = path.join(root, "grandchild.ready");
    const program = await executableFixture(root, "eperm-parent.mjs", `
import { spawn } from "node:child_process";
import fs from "node:fs";
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(
  `const fs=require("node:fs");process.on("SIGTERM",()=>{});fs.writeFileSync(${JSON.stringify(
    grandchildReadyPath,
  )},"ready");setInterval(()=>{},1000);`,
)}], {
  detached: false,
  stdio: "ignore",
});
while (!fs.existsSync(${JSON.stringify(grandchildReadyPath)})) {
  await new Promise(resolve => setTimeout(resolve, 5));
}
grandchild.unref();
`);
    let injected = false;
    const killProcess = (pid, signal) => {
      if (!injected && pid < 0 && signal === "SIGKILL") {
        process.kill(pid, signal);
        injected = true;
        const error = new Error("injected post-close process-group race");
        error.code = "EPERM";
        throw error;
      }
      return process.kill(pid, signal);
    };
    const result = await runCaptured(program, [], {
      cwd: root,
      env: process.env,
      stdoutPath: path.join(root, "stdout.txt"),
      stderrPath: path.join(root, "stderr.txt"),
      timeoutMs: 1_000,
      terminationGraceMs: process.platform === "darwin" ? 100 : 25,
      useProcessGroup: true,
      killProcess,
    });
    expect(injected).toBe(true);
    expect(result).toMatchObject({
      code: 0,
      signal: null,
      timed_out: false,
      aborted: false,
      termination_reason: "process_group_reap",
      sigterm_attempted: true,
      sigterm_sent: true,
      sigkill_attempted: true,
      sigkill_sent: false,
      process_group_alive_after_close: false,
      signal_outcomes: [
        {
          signal: "SIGTERM",
          target: "process_group",
          target_sent: true,
          target_error: null,
          sent: true,
        },
        {
          signal: "SIGKILL",
          target: "process_group",
          target_sent: false,
          target_error: "EPERM",
          sent: false,
        },
      ],
    });
    expect(isCleanProcessResult(result)).toBe(false);
  }, 5000);

  it("rejects boundedly when pre-close termination is unverifiable", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "runner-persistent-eperm-")),
    );
    roots.push(root);
    const parentPidPath = path.join(root, "parent.pid");
    const grandchildPidPath = path.join(root, "grandchild.pid");
    const grandchildReadyPath = path.join(root, "grandchild.ready");
    const program = await executableFixture(root, "persistent-eperm-parent.mjs", `
import { spawn } from "node:child_process";
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid));
process.on("SIGTERM", () => {});
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(
  `const fs=require("node:fs");process.on("SIGTERM",()=>{});fs.writeFileSync(${JSON.stringify(
    grandchildReadyPath,
  )},"ready");setInterval(()=>{},1000);`,
)}], {
  detached: false,
  stdio: "ignore",
});
while (!fs.existsSync(${JSON.stringify(grandchildReadyPath)})) {
  await new Promise(resolve => setTimeout(resolve, 5));
}
fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));
setInterval(() => {}, 1000);
`);
    const killProcess = (pid, signal) => {
      if (signal === 0) return process.kill(pid, signal);
      const error = new Error("injected persistent process-group denial");
      error.code = "EPERM";
      throw error;
    };
    let watchdog = null;
    let caught = null;
    let parentPid = null;
    let grandchildPid = null;
    let settledAt = null;
    const startedAt = Date.now();
    try {
      await Promise.race([
        runCaptured(program, [], {
          cwd: root,
          env: process.env,
          stdoutPath: path.join(root, "stdout.txt"),
          stderrPath: path.join(root, "stderr.txt"),
          timeoutMs: process.platform === "darwin" ? 300 : 150,
          terminationGraceMs: 25,
          useProcessGroup: true,
          killProcess,
        }),
        new Promise((_, reject) => {
          watchdog = setTimeout(
            () => reject(new Error("persistent EPERM test watchdog expired")),
            5_000,
          );
        }),
      ]);
    } catch (error) {
      caught = error;
    } finally {
      settledAt = Date.now();
      if (watchdog !== null) clearTimeout(watchdog);
      const readFixturePid = async filename => {
        try {
          const value = Number(await fs.readFile(filename, "utf8"));
          return Number.isSafeInteger(value) && value > 0 ? value : null;
        } catch (error) {
          if (error?.code === "ENOENT") return null;
          throw error;
        }
      };
      const reportedPid = caught?.process_result?.pid;
      parentPid = Number.isSafeInteger(reportedPid) && reportedPid > 0
        ? reportedPid
        : await readFixturePid(parentPidPath);
      // The injected killProcess denies every real signal, so the fixture is
      // still running once the runner gives up, and it records its grandchild
      // pid on its own schedule rather than inside the runner's rejection
      // budget. Wait for that observable readiness before the process group is
      // killed below, otherwise a slow host lets the kill beat the write and
      // the pid these assertions need is never recorded. The wait is bounded so
      // a genuinely missing pid still fails instead of hanging.
      grandchildPid = await readFixturePid(grandchildPidPath);
      const readinessDeadlineAt = Date.now() + 2_000;
      while (grandchildPid === null && Date.now() < readinessDeadlineAt) {
        await new Promise(resolve => setTimeout(resolve, 5));
        grandchildPid = await readFixturePid(grandchildPidPath);
      }
      if (parentPid !== null) {
        try {
          process.kill(-parentPid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
      const processTargets = [
        parentPid === null ? null : -parentPid,
        parentPid,
        grandchildPid,
      ].filter(pid => pid !== null);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        let alive = false;
        for (const pid of processTargets) {
          try {
            process.kill(pid, 0);
            alive = true;
          } catch (error) {
            if (error?.code === "EPERM") alive = true;
            else if (error?.code !== "ESRCH") throw error;
          }
        }
        if (!alive) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    // Bound the runner's own rejection, measured when the race settled, not the
    // fixture teardown that follows it.
    expect(settledAt).not.toBeNull();
    expect(settledAt - startedAt).toBeLessThan(5_000);
    expect(caught).toMatchObject({
      code: "CODEX_PROCESS_TERMINATION_UNVERIFIABLE",
      process_result: {
        pid: parentPid,
        process_group: parentPid,
        child_closed: false,
        termination_reason: "timeout",
        signal_outcomes: [
          {
            signal: "SIGTERM",
            target: "process_group",
            target_sent: false,
            target_error: "EPERM",
            sent: false,
          },
          {
            signal: "SIGKILL",
            target: "process_group",
            target_sent: false,
            target_error: "EPERM",
            sent: false,
          },
        ],
      },
    });
    expect(parentPid).not.toBeNull();
    expect(grandchildPid).not.toBeNull();
    expect(await fs.readFile(grandchildReadyPath, "utf8")).toBe("ready");
    for (const pid of [-parentPid, parentPid, grandchildPid]) {
      expect(() => process.kill(pid, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    }
  }, 7000);

  it("does not lose an abort during listener registration before launch", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "runner-registration-abort-")),
    );
    roots.push(root);
    const invokedPath = path.join(root, "invoked.pid");
    const program = await executableFixture(root, "must-not-launch.mjs", `
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(invokedPath)}, String(process.pid));
setInterval(() => {}, 1000);
`);
    let aborted = false;
    let addCount = 0;
    let removeCount = 0;
    const activeListeners = new Set();
    const registrationWindowSignal = {
      get aborted() {
        return aborted;
      },
      addEventListener(type, listener) {
        expect(type).toBe("abort");
        addCount += 1;
        activeListeners.add(listener);
        aborted = true;
        listener();
      },
      removeEventListener(type, listener) {
        expect(type).toBe("abort");
        removeCount += 1;
        activeListeners.delete(listener);
      },
    };
    await expect(runCaptured(program, [], {
      cwd: root,
      env: process.env,
      stdoutPath: path.join(root, "stdout.txt"),
      stderrPath: path.join(root, "stderr.txt"),
      timeoutMs: 1_000,
      terminationGraceMs: 25,
      abortSignal: registrationWindowSignal,
    })).rejects.toMatchObject({
      code: "CODEX_PROCESS_ABORTED",
      process_result: {
        pid: null,
        aborted: true,
        termination_reason: "abort_before_spawn",
        sigterm_attempted: false,
        sigkill_attempted: false,
      },
    });
    expect(addCount).toBe(1);
    expect(removeCount).toBe(1);
    expect(activeListeners.size).toBe(0);
    await expect(fs.access(invokedPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.access(path.join(root, "stdout.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.access(path.join(root, "stderr.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("distinguishes abort and spawn failure without hanging or double-settling", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "runner-abort-spawn-")),
    );
    roots.push(root);
    const program = await executableFixture(root, "waiting.mjs", `
setInterval(() => {}, 1000);
`);
    const controller = new AbortController();
    let addCount = 0;
    let removeCount = 0;
    const activeListeners = new Set();
    const trackedSignal = {
      get aborted() {
        return controller.signal.aborted;
      },
      addEventListener(type, listener, options) {
        addCount += 1;
        activeListeners.add(listener);
        controller.signal.addEventListener(type, listener, options);
      },
      removeEventListener(type, listener) {
        removeCount += 1;
        activeListeners.delete(listener);
        controller.signal.removeEventListener(type, listener);
      },
    };
    setTimeout(() => controller.abort(), 25);
    const aborted = await runCaptured(program, [], {
      cwd: root,
      env: process.env,
      stdoutPath: path.join(root, "abort.stdout.txt"),
      stderrPath: path.join(root, "abort.stderr.txt"),
      timeoutMs: 1_000,
      terminationGraceMs: 25,
      abortSignal: trackedSignal,
    });
    expect(aborted).toMatchObject({
      timed_out: false,
      aborted: true,
      termination_reason: "abort",
      sigterm_attempted: true,
      sigterm_sent: true,
      signal: "SIGTERM",
    });
    expect(addCount).toBe(1);
    expect(removeCount).toBe(1);
    expect(activeListeners.size).toBe(0);
    const spawnFailure = await runCaptured(
      path.join(root, "does-not-exist"),
      [],
      {
        cwd: root,
        env: process.env,
        stdoutPath: path.join(root, "spawn.stdout.txt"),
        stderrPath: path.join(root, "spawn.stderr.txt"),
        timeoutMs: 1_000,
        terminationGraceMs: 25,
      },
    );
    expect(spawnFailure.spawn_error).toMatch(/^Error:ENOENT$/);
    expect(spawnFailure).toMatchObject({
      code: -2,
      signal: null,
      timed_out: false,
      aborted: false,
    });
    expect(isCleanProcessResult(spawnFailure)).toBe(false);
    const truncatedInput = await runCaptured(
      process.execPath,
      ["-e", "process.stdin.destroy();setTimeout(()=>process.exit(0),50)"],
      {
        cwd: root,
        env: process.env,
        stdin: "x".repeat(16 * 1024 * 1024),
        stdoutPath: path.join(root, "stdin.stdout.txt"),
        stderrPath: path.join(root, "stdin.stderr.txt"),
        timeoutMs: 1_000,
        terminationGraceMs: 25,
      },
    );
    expect(truncatedInput).toMatchObject({
      code: 0,
      signal: null,
      stdin_error: "Error:EPIPE",
    });
    expect(isCleanProcessResult(truncatedInput)).toBe(false);
  }, 5000);
});

describe("agent workflow run binding", () => {
  it("creates direct and rename-style responses privately and restores umask", async () => {
    const previous = process.umask(0o022);
    try {
      for (const responseWriteStyle of ["direct", "rename"]) {
        const run = await preparedRun({ responseWriteStyle });
        const stat = await fs.lstat(
          path.join(run.resultsRoot, "response.json"),
        );
        expect(stat.mode & 0o777).toBe(0o600);
        expect(stat.nlink).toBe(1);
        expect(stat.isFile()).toBe(true);
        expect(stat.isSymbolicLink()).toBe(false);
        expect(process.umask()).toBe(0o022);
      }
    } finally {
      process.umask(previous);
    }
  }, 30000);

  it("binds the zero-byte precreated response before inference", async () => {
    const run = await preparedRun();
    const launchPlan = JSON.parse(await fs.readFile(
      path.join(run.resultsRoot, "launch-plan.json"),
      "utf8",
    ));
    const expected = {
      bytes: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      mode: 0o600,
      nlink: 1,
      file_type: "regular",
      symbolic_link: false,
    };
    expect(launchPlan.pre_inference_artifacts["response.json"]).toMatchObject(
      expected,
    );
    expect(run.preInferenceEvidence.artifacts["response.json"]).toEqual(
      launchPlan.pre_inference_artifacts["response.json"],
    );
    expect(run.preInferenceEvidence.artifacts["response.json"]).toMatchObject({
      ...expected,
      device: expect.any(Number),
      inode: expect.any(Number),
      ctime_ms: expect.any(Number),
      mtime_ms: expect.any(Number),
    });
  }, 15000);

  it("rejects an empty private inode replacement by the pre-inference hook before Codex exec", async () => {
    const run = await preparedRun({
      replaceResponseInPreInferenceHook: true,
      expectFailure: true,
    });
    expect(run.runError).toBeTruthy();
    expect(run.runError.message).toMatch(
      /changed after pre-inference hook/,
    );
    await expect(fs.access(run.invocationPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 15000);

  it("rejects unsafe mode, symlink, and hardlink responses without retry or repair", async () => {
    for (const responseWriteStyle of ["unsafe-mode", "symlink", "hardlink"]) {
      const run = await preparedRun({
        responseWriteStyle,
        expectFailure: true,
      });
      expect(run.runError).toBeTruthy();
      expect(await fs.readFile(run.invocationPath, "utf8")).toBe("1");
      const responsePath = path.join(run.resultsRoot, "response.json");
      const stat = await fs.lstat(responsePath);
      if (responseWriteStyle === "unsafe-mode") {
        expect(stat.mode & 0o777).toBe(0o644);
      } else if (responseWriteStyle === "symlink") {
        expect(stat.isSymbolicLink()).toBe(true);
      } else {
        expect(stat.nlink).toBe(2);
      }
    }
  }, 30000);

  it("rejects replacement between the opened response handle and final path check", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "runner-replacement-drift-")),
    );
    roots.push(root);
    const responsePath = path.join(root, "response.json");
    await fs.writeFile(responsePath, "{}\n", { mode: 0o600 });
    const handle = await fs.open(
      responsePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const replacement = path.join(root, "replacement.json");
      await fs.writeFile(replacement, "{}\n", { mode: 0o600 });
      await fs.rename(replacement, responsePath);
      await expect(artifactRecordFromHandle(handle, {
        filename: responsePath,
      })).rejects.toThrow(/path identity differs/);
    } finally {
      await handle.close();
    }
  });

  it("forbids concurrent runner umask scopes and restores the caller value", async () => {
    const previous = process.umask(0o022);
    let release;
    try {
      const first = withPrivateRunnerUmask(() => new Promise(resolve => {
        release = resolve;
      }));
      await Promise.resolve();
      expect(process.umask()).toBe(PRIVATE_CREATION_UMASK);
      await expect(
        withPrivateRunnerUmask(async () => {}),
      ).rejects.toThrow(/concurrent workflow runner invocation/);
      release();
      await first;
      expect(process.umask()).toBe(0o022);
    } finally {
      process.umask(previous);
    }
  });

  it("binds the scored response to the validated event and every run artifact", async () => {
    const run = await preparedRun();
    const controllerRunRoot = path.join(run.root, "controller-results");
    await fs.cp(run.resultsRoot, controllerRunRoot, { recursive: true });
    const outputPath = path.join(controllerRunRoot, "run-manifest.json");
    const manifest = await bindAgentWorkflowRun({
      runRoot: controllerRunRoot,
      preparationManifestPath: run.manifestPath,
      arm: run.arm,
      caseId: run.caseId,
      runId: run.scheduled?.run_id,
      outputPath,
    });
    expect(manifest).toMatchObject({
      claim_ready: true,
      arm: run.arm,
      case_id: run.caseId,
      response: { case_id: run.caseId },
      event_validation: { pass: true, model_callable_tool_items: 0 },
    });
    expect(Object.keys(manifest.artifacts)).toEqual(
      expect.arrayContaining([
        "events.jsonl",
        "response.json",
        "pre-run-attestation.json",
        "post-run-attestation.json",
        "prompt-input.json",
      ]),
    );
  }, 15000);

  it("rejects a swapped response and refuses to reuse a result directory", async () => {
    const run = await preparedRun();
    await expect(runCodexAgentWorkflowCase({
      arm: run.arm,
      caseId: run.caseId,
      caseRoot: path.join(run.root, "case"),
      resultsRoot: run.resultsRoot,
      codexHome: path.join(run.root, "codex-home"),
      codexBinary: path.join(run.root, "fake-codex.mjs"),
      sandboxBinary: path.join(run.root, "fake-sandbox.mjs"),
      attesterPath: path.join(
        REPO_ROOT,
        "scripts",
        "eval-attest-agent-workflow-arm.mjs",
      ),
      expectedCommitSha1: "0".repeat(40),
      expectedTreeSha1: "0".repeat(40),
      expectedContentTreeSha256: "0".repeat(64),
      sourceCommit: "0".repeat(40),
      model: "synthetic-model",
    })).rejects.toThrow();

    await fs.writeFile(
      path.join(run.resultsRoot, "response.json"),
      JSON.stringify({ case_id: "safe-fill-plans-distinct-output" }),
    );
    await expect(bindAgentWorkflowRun({
      runRoot: run.resultsRoot,
      preparationManifestPath: run.manifestPath,
      arm: run.arm,
      caseId: run.caseId,
      runId: run.scheduled?.run_id,
      outputPath: path.join(run.resultsRoot, "run-manifest.json"),
    })).rejects.toThrow(/response does not equal/);
  }, 15000);

  it("rejects actual denied-home text in prompt-input evidence", async () => {
    const run = await preparedRun();
    const plan = JSON.parse(await fs.readFile(
      path.join(run.resultsRoot, "launch-plan.json"),
      "utf8",
    ));
    const promptInputPath = path.join(run.resultsRoot, "prompt-input.json");
    const promptInput = JSON.parse(await fs.readFile(promptInputPath, "utf8"));
    promptInput.unshift({
      type: "message",
      role: "developer",
      content: [{
        type: "input_text",
        text: `Synthetic forbidden home path: ${plan.isolation.denied_user_home}`,
      }],
    });
    await fs.writeFile(promptInputPath, JSON.stringify(promptInput));
    await expect(bindAgentWorkflowRun({
      runRoot: run.resultsRoot,
      preparationManifestPath: run.manifestPath,
      arm: run.arm,
      caseId: run.caseId,
      runId: run.scheduled?.run_id,
      outputPath: path.join(run.resultsRoot, "run-manifest.json"),
    })).rejects.toThrow(/prompt-input evidence does not match the reviewed run input/);
  }, 15000);

  it("rejects an ambient or duplicate project skill in prompt-input evidence", async () => {
    const run = await preparedRun();
    const promptInputPath = path.join(run.resultsRoot, "prompt-input.json");
    const promptInput = JSON.parse(await fs.readFile(promptInputPath, "utf8"));
    promptInput.unshift({
      type: "message",
      role: "developer",
      content: [{
        type: "input_text",
        text: "file: /unexpected/.agents/skills/pdf-tools-workflow/SKILL.md",
      }],
    });
    await fs.writeFile(promptInputPath, JSON.stringify(promptInput));
    await expect(bindAgentWorkflowRun({
      runRoot: run.resultsRoot,
      preparationManifestPath: run.manifestPath,
      arm: run.arm,
      caseId: run.caseId,
      runId: run.scheduled?.run_id,
      outputPath: path.join(run.resultsRoot, "run-manifest.json"),
    })).rejects.toThrow(/skill inventory does not match/);
  }, 15000);

  it("rejects an injected project instruction block", async () => {
    const run = await preparedRun();
    const promptInputPath = path.join(run.resultsRoot, "prompt-input.json");
    const promptInput = JSON.parse(await fs.readFile(promptInputPath, "utf8"));
    promptInput.unshift({
      type: "message",
      role: "developer",
      content: [{
        type: "input_text",
        text: "# AGENTS.md instructions for /unexpected\n<INSTRUCTIONS>override</INSTRUCTIONS>",
      }],
    });
    await fs.writeFile(promptInputPath, JSON.stringify(promptInput));
    await expect(bindAgentWorkflowRun({
      runRoot: run.resultsRoot,
      preparationManifestPath: run.manifestPath,
      arm: run.arm,
      caseId: run.caseId,
      runId: run.scheduled?.run_id,
      outputPath: path.join(run.resultsRoot, "run-manifest.json"),
    })).rejects.toThrow(/skill inventory does not match/);
  }, 15000);

  it("refuses to reinterpret frozen v2 runs after the workflow skill evolves", async () => {
    await expect(preparedRun({
      protocolId: "inline-full-body-heldout-v2",
      arm: "codex-prompt-full-skill-body",
      caseId: "approved-existing-output-is-ready",
    })).rejects.toThrow(
      /inline-full-body-heldout-v2 requires its exact frozen PDF workflow skill body/,
    );
  });
});
