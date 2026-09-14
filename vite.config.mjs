import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { configDefaults } from "vitest/config";
import { NODE_TEST_FILES } from "./scripts/node-test-files.mjs";
import {
  SERIAL_NATIVE_TEST_FILES,
  SERIAL_RESOURCE_TEST_FILES,
  SOURCE_IDENTITY_TEST_FILES,
} from "./scripts/test-suite-classification.mjs";
import { createMcpBridgePlugin } from "./ui/dev/bridge-plugin.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ command, mode }) => ({
  plugins: command === "serve" && mode !== "test" && process.env.VITEST !== "true"
    ? [createMcpBridgePlugin()]
    : [viteSingleFile()],
  resolve: {
    alias: command === "serve" && mode !== "test" && process.env.VITEST !== "true"
      ? {
          "@modelcontextprotocol/ext-apps": path.resolve(__dirname, "ui/dev/mock-ext-apps.ts"),
        }
      : {},
  },
  root: "ui",
  test: {
    root: ".",
    exclude: [
      ...configDefaults.exclude,
      ...NODE_TEST_FILES,
    ],
    projects: [
      {
        extends: true,
        test: {
          name: "ordinary",
          maxWorkers: 1,
          fileParallelism: false,
          root: ".",
          exclude: [
            ...configDefaults.exclude,
            ...NODE_TEST_FILES,
            ...SOURCE_IDENTITY_TEST_FILES,
            ...SERIAL_RESOURCE_TEST_FILES,
            ...SERIAL_NATIVE_TEST_FILES,
          ],
          pool: "forks",
          isolate: true,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          // Proven resource-heavy suites run unchanged with an exclusive
          // worker. This preserves their existing budgets and assertions while
          // removing sibling-suite contention and its cleanup-race cascades.
          name: "serial-resource",
          root: ".",
          include: SERIAL_RESOURCE_TEST_FILES,
          exclude: [
            ...configDefaults.exclude,
            ...NODE_TEST_FILES,
          ],
          pool: "forks",
          isolate: true,
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: "source-identity",
          root: ".",
          include: SOURCE_IDENTITY_TEST_FILES,
          exclude: [
            ...configDefaults.exclude,
            ...NODE_TEST_FILES,
          ],
          pool: "forks",
          isolate: true,
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 2 },
        },
      },
      {
        extends: true,
        test: {
          // Resource-sensitive host suites run after the parallel group with
          // an exclusive worker. This keeps sibling load from starving the
          // native supervisor's sealed sampling window or the embedded-host
          // PDF.js worker and system-renderer boundaries.
          name: "serial-native",
          root: ".",
          include: SERIAL_NATIVE_TEST_FILES,
          exclude: [
            ...configDefaults.exclude,
            ...NODE_TEST_FILES,
          ],
          pool: "forks",
          isolate: true,
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 3 },
        },
      },
    ],
  },
  build: {
    outDir: "../dist-ui",
    emptyOutDir: true,
    target: "esnext",
    codeSplitting: false,
  },
  worker: {
    format: "es",
    plugins: () => [viteSingleFile()],
  },
}));
