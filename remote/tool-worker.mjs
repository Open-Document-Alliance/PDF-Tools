/** In-memory hosted operation. No document persistence or user filesystem API. */
import { parentPort, workerData } from "node:worker_threads";
import { callTool } from "./server.mjs";

parentPort.postMessage(await callTool(workerData.name, workerData.args));
