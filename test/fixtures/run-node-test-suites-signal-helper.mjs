import { runNodeTestSuites } from "../../scripts/run-node-test-suites.mjs";

// A failed test worker must not orphan this helper's detached native runner.
let completed = false;
process.on("disconnect", () => { if (!completed) process.emit("SIGTERM"); });

const completion = runNodeTestSuites({
  suiteFiles: ["test/fixtures/node-runner-stubborn-fixture.mjs"],
  arguments_: ["--reporter=tap"],
  standardInputOutput: "ignore",
  escalationMs: 200,
});

// The cancellation handlers own the detached runner before this handshake.
process.send?.({ type: "runner-started" });
process.exitCode = await completion;
completed = true;
if (process.connected) process.disconnect();
