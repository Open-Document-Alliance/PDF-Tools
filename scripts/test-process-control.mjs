import { spawn } from "node:child_process";
import path from "node:path";

const signalExitCodes = {
  SIGINT: 130,
  SIGTERM: 143,
};

export function windowsTaskkillPath(environment = process.env) {
  const windowsRoot = environment.SystemRoot || environment.WINDIR;
  return windowsRoot
    ? path.win32.join(windowsRoot, "System32", "taskkill.exe")
    : "taskkill.exe";
}

function signalPosixGroup(child, signal) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 2) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function killDirectChild(child) {
  try {
    return child.kill("SIGKILL") === true;
  } catch {
    return false;
  }
}

export function terminateWindowsTree(child, {
  environment = process.env,
  timeoutMs,
  spawnProcess = spawn,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Windows tree-termination timeout must be a positive integer");
  }
  if (!Number.isSafeInteger(child.pid) || child.pid < 2) {
    killDirectChild(child);
    return Promise.resolve({
      verified: false,
      reason: "direct child has no valid PID for taskkill",
    });
  }
  return new Promise(resolve => {
    let settled = false;
    let timeout = null;
    const settle = result => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    const fail = reason => {
      if (settled) return;
      const fallbackSignalSent = killDirectChild(child);
      settle({
        verified: false,
        reason: fallbackSignalSent
          ? reason
          : `${reason}; direct-child fallback signal was not accepted`,
      });
    };

    let killer;
    try {
      killer = spawnProcess(windowsTaskkillPath(environment), [
        "/PID",
        String(child.pid),
        "/T",
        "/F",
      ], {
        env: environment,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      fail(`taskkill failed to start: ${error.message}`);
      return;
    }
    killer.once("error", error => {
      fail(`taskkill failed to start: ${error.message}`);
    });
    killer.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        settle({ verified: true, reason: null });
        return;
      }
      fail(
        `taskkill did not verify tree termination (code=${code ?? "null"}, `
        + `signal=${signal ?? "null"})`,
      );
    });
    timeout = setTimeout(() => {
      try {
        killer.kill("SIGKILL");
      } catch {}
      fail(`taskkill exceeded ${timeoutMs} ms`);
    }, timeoutMs);
  });
}

export function runControlledTestProcess({
  command,
  args,
  cwd,
  environment = process.env,
  escalationMs = 1_000,
  label,
  platform = process.platform,
  standardInputOutput = "inherit",
}) {
  if (!Number.isSafeInteger(escalationMs) || escalationMs < 1) {
    throw new Error("test-process escalationMs must be a positive integer");
  }
  const child = spawn(command, args, {
    cwd,
    detached: platform !== "win32",
    env: environment,
    stdio: standardInputOutput,
    windowsHide: platform === "win32",
  });

  return new Promise(resolve => {
    let forwardedSignal = null;
    let escalationTimer = null;
    let settled = false;
    let windowsTermination = null;
    let posixKillSent = false;
    const killOwnedPosixGroup = () => {
      if (posixKillSent) return;
      signalPosixGroup(child, "SIGKILL");
      posixKillSent = true;
    };
    const signalHandlers = new Map();

    const cleanup = () => {
      if (escalationTimer) clearTimeout(escalationTimer);
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
    };
    const settle = exitCode => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(exitCode);
    };
    const forward = signal => {
      if (forwardedSignal) {
        if (platform === "win32") {
          killDirectChild(child);
        } else {
          killOwnedPosixGroup();
        }
        return;
      }
      forwardedSignal = signal;
      console.error(`[${label}] forwarding ${signal} to the complete test tree`);
      if (platform === "win32") {
        windowsTermination = terminateWindowsTree(child, {
          environment,
          timeoutMs: escalationMs,
        });
        escalationTimer = setTimeout(() => {
          console.error(
            `[${label}] Windows cancellation did not close the direct child `
            + `within ${escalationMs * 2} ms`,
          );
          if (!killDirectChild(child)) {
            console.error(`[${label}] direct-child fallback signal was not accepted`);
          }
          child.unref();
          settle(1);
        }, escalationMs * 2);
        return;
      }
      signalPosixGroup(child, signal);
      escalationTimer = setTimeout(() => {
        console.error(`[${label}] escalating cancellation to SIGKILL`);
        killOwnedPosixGroup();
      }, escalationMs);
    };

    for (const signal of Object.keys(signalExitCodes)) {
      const handler = () => forward(signal);
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }

    child.once("error", error => {
      console.error(`[${label}] failed to start: ${error.message}`);
      settle(1);
    });
    // The group is owned by this runner even when its leader exits without a
    // forwarded signal. Reap leftovers on exit, before inherited stdio held by
    // a grandchild can delay close and contaminate the next test partition.
    child.once("exit", () => {
      if (platform !== "win32") {
        if (escalationTimer) clearTimeout(escalationTimer);
        killOwnedPosixGroup();
      }
    });
    child.once("close", async (code, signal) => {
      if (forwardedSignal) {
        if (platform === "win32") {
          const result = await windowsTermination;
          if (!result.verified) {
            console.error(`[${label}] ${result.reason}`);
            settle(1);
            return;
          }
        }
        settle(signalExitCodes[forwardedSignal]);
        return;
      }
      if (signal) {
        console.error(`[${label}] terminated by ${signal}`);
        settle(1);
        return;
      }
      settle(code ?? 1);
    });
  });
}
