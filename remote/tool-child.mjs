/**
 * One hosted tool call in a child process started under RLIMIT_DATA by
 * process-isolation.mjs. In-memory only: no document persistence or user
 * filesystem access. `probe` mode answers the boot check without loading the
 * tool code.
 */
import { readFileSync } from "node:fs";

const mode = process.argv[2];

if (mode === "probe") {
  const line = readFileSync("/proc/self/limits", "utf8").split("\n").find(entry => entry.startsWith("Max data size")) ?? "";
  const [soft] = line.replace("Max data size", "").trim().split(/\s+/);
  process.send({ probe: true, dataLimitBytes: Number(soft) }, () => process.exit(0));
} else {
  // A parent that is gone cannot use the result; do not keep working for it.
  process.once("disconnect", () => process.exit(1));
  process.once("message", async ({ name, args, context }) => {
    const { callTool } = await import("./server.mjs");
    const { isAllocationFailure, MEMORY_LIMIT_CODE, MEMORY_LIMIT_MESSAGE } = await import("./decode-budget.mjs");
    // A send whose interruption leaves an unknown outcome never gets a
    // substitute answer: the child exits and the parent reports it as unknown.
    const sensitive = name === "send_lumin_request";
    const substitute = error => (isAllocationFailure(error)
      ? { isError: true, content: [{ type: "text", text: `${MEMORY_LIMIT_CODE}: ${MEMORY_LIMIT_MESSAGE}` }] }
      : { isError: true, content: [{ type: "text", text: "PROCESSING_FAILED: That document could not be processed." }] });
    let result;
    try {
      result = await callTool(name, args, context);
    } catch (error) {
      if (sensitive) process.exit(1);
      result = substitute(error);
    }
    try {
      process.send(result, error => {
        if (!error) return process.exit(0);
        if (sensitive) return process.exit(1);
        // The result itself could not cross (for example, too large to serialize); send a small typed failure instead.
        try { process.send(substitute(error), () => process.exit(0)); } catch { process.exit(1); }
      });
    } catch (error) {
      if (sensitive) process.exit(1);
      try { process.send(substitute(error), () => process.exit(0)); } catch { process.exit(1); }
    }
  });
}
