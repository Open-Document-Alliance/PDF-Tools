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
    const result = await callTool(name, args, context);
    process.send(result, () => process.exit(0));
  });
}
