// Fault injection for the embedded-host native-canvas guard.
//
// The suite this replaces asserted the policy function against marker files the
// test wrote itself. That never ran the guard, so it could not have caught the
// defect that got the win32 default reverted: the guard cleared its marker the
// instant dlopen returned, covering only the link step while the risk it exists
// for is the first draw. A test that only writes markers and reads policy agrees
// with that bug completely.
//
// So everything here drives the real guarded process.dlopen with an injected
// loader, and asserts on the marker the guard actually left on disk.

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __installCanvasGuardForTest,
  armNativeCanvasAttempt,
  embeddedNativeCanvasAllowed,
  nativeCanvasBlockReason,
  nativeCanvasLatchState,
  nativeCanvasMarkerPath,
  settleNativeCanvasAttempt,
} from "../server/pdfjs-subprocess.js";

const CANVAS_BINDING = "/opt/app/node_modules/@napi-rs/canvas/index.node";
const SKIA_BINDING = "C:\\app\\vendor\\skia.win32-x64-msvc.node";
const UNRELATED_BINDING = "/opt/app/node_modules/better-sqlite3/build/better_sqlite3.node";

let profilesDir = null;
let savedProfilesDir;
let savedFlag;
let installed = null;

function markerPath() {
  return nativeCanvasMarkerPath(process.env);
}

function readMarker() {
  return JSON.parse(readFileSync(markerPath(), "utf8"));
}

// The same primitive the guard uses, so "dead" here means what it means there.
function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is another user's live process; only ESRCH is genuinely gone.
    return error?.code !== "ESRCH";
  }
}

// A pid that is definitely not running: spawn a trivial process, let it exit,
// and reuse its number. Beats guessing a high integer, which can collide. The
// number is probed before it is handed out, because it is only a dead pid if
// the OS has not already given it to something else.
function deadPid() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pid = spawnSync(process.execPath, ["-e", ""]).pid;
    if (Number.isInteger(pid) && pid > 0 && !pidIsAlive(pid)) return pid;
  }
  throw new Error("could not obtain a pid that is not in use");
}

// Runs `check` against a marker owned by a process that is not running.
//
// Pid reuse is not a defect here, it is the product's documented answer: when a
// crashed process's number has been handed to an unrelated live process,
// nativeCanvasLatchState reports "concurrent" rather than "latched" on purpose,
// failing toward retryable. On a busy host that can happen between deadPid()
// and the read, and a test that treats it as a latch failure is asserting
// against one of two intended outcomes.
//
// So a failed check is only accepted as a failure once the owner is confirmed
// still dead; if the OS reused the number under us, the run proved nothing
// either way and is repeated with a fresh one. A guard that genuinely stopped
// latching fails on the first pass, because the owner stays dead and the
// caller's assertions are re-run unweakened every time.
//
// The `force` cases below take a bare deadPid() instead: force short-circuits
// before the latch is consulted, so their outcome does not turn on whether the
// marker's owner is alive.
function withDeadOwnerMarker(marker, check) {
  for (let attempt = 0; ; attempt += 1) {
    const pid = deadPid();
    writeFileSync(markerPath(), JSON.stringify({ ...marker, pid }));
    try {
      check(pid);
      return pid;
    } catch (error) {
      if (attempt >= 20 || !pidIsAlive(pid)) throw error;
    }
  }
}

function install({ dlopen }) {
  installed = __installCanvasGuardForTest({ dlopen });
  return installed.guardedDlopen;
}

beforeEach(() => {
  profilesDir = mkdtempSync(join(tmpdir(), "pdf-tools-canvas-latch-"));
  savedProfilesDir = process.env.DEFAULT_PROFILES_DIR;
  savedFlag = process.env.PDF_TOOLS_EMBEDDED_NATIVE_CANVAS;
  process.env.DEFAULT_PROFILES_DIR = profilesDir;
  process.env.PDF_TOOLS_EMBEDDED_NATIVE_CANVAS = "1";
});

afterEach(() => {
  installed?.restore();
  installed = null;
  if (savedProfilesDir === undefined) delete process.env.DEFAULT_PROFILES_DIR;
  else process.env.DEFAULT_PROFILES_DIR = savedProfilesDir;
  if (savedFlag === undefined) delete process.env.PDF_TOOLS_EMBEDDED_NATIVE_CANVAS;
  else process.env.PDF_TOOLS_EMBEDDED_NATIVE_CANVAS = savedFlag;
  rmSync(profilesDir, { force: true, recursive: true });
});

describe("the default is off, and stays off until the gates are met", () => {
  // This is the accidental-flip alarm. If someone adds "win32" to
  // NATIVE_CANVAS_DEFAULT_PLATFORMS without the host soak evidence, this is what
  // says so. Deleting it is the only way to flip the default quietly.
  it("blocks on every platform when no flag is set", () => {
    const absent = join(profilesDir, "no-marker.json");
    for (const platform of ["win32", "darwin", "linux"]) {
      expect(
        embeddedNativeCanvasAllowed({ env: {}, platform, markerPath: absent }),
      ).toBe(false);
    }
  });

  it("treats =0 as an unconditional kill switch", () => {
    const absent = join(profilesDir, "no-marker.json");
    expect(embeddedNativeCanvasAllowed({
      env: { PDF_TOOLS_EMBEDDED_NATIVE_CANVAS: "0" },
      platform: "win32",
      markerPath: absent,
    })).toBe(false);
  });

  it("allows =1 when nothing is latched", () => {
    const absent = join(profilesDir, "no-marker.json");
    expect(embeddedNativeCanvasAllowed({
      env: { PDF_TOOLS_EMBEDDED_NATIVE_CANVAS: "1" },
      platform: "linux",
      markerPath: absent,
    })).toBe(true);
  });
});

describe("the marker survives past the link, which is the whole point", () => {
  it("keeps the marker on disk after dlopen returns, in the drawing phase", () => {
    // The reverted implementation deleted the marker here. If this file is ever
    // green with the marker already gone at this point, the latch covers only
    // the link step again and the default must not be flipped.
    const guarded = install({ dlopen: () => "loaded" });

    expect(guarded.call(process, {}, CANVAS_BINDING)).toBe("loaded");

    expect(existsSync(markerPath())).toBe(true);
    const marker = readMarker();
    expect(marker.phase).toBe("drawing");
    expect(marker.pid).toBe(process.pid);
  });

  it("arms the marker before dlopen is called, not after", () => {
    let phaseSeenDuringLoad = null;
    const guarded = install({
      dlopen: () => {
        // Observed from inside the load: a crash here must find a marker.
        phaseSeenDuringLoad = readMarker().phase;
        return "loaded";
      },
    });

    guarded.call(process, {}, CANVAS_BINDING);

    expect(phaseSeenDuringLoad).toBe("linking");
  });

  it("clears the marker only once the triggering request settles", () => {
    const guarded = install({ dlopen: () => "loaded" });
    guarded.call(process, {}, CANVAS_BINDING);
    expect(existsSync(markerPath())).toBe(true);

    settleNativeCanvasAttempt();

    expect(existsSync(markerPath())).toBe(false);
  });

  it("keeps the previous marker intact when the phase advance cannot be written", () => {
    // The advance replaces a valid `linking` marker with a `drawing` one. If it
    // truncated the file in place, a host crash inside that window would leave a
    // zero-length marker - and an empty marker reads as "no marker", losing the
    // latch at exactly the link-to-first-draw moment it exists to catch.
    //
    // The injected loader makes the profiles directory unwritable from inside
    // the load, so the advance fails after the linking marker already exists.
    const guarded = install({
      dlopen: () => {
        chmodSync(profilesDir, 0o500);
        return "loaded";
      },
    });

    guarded.call(process, {}, CANVAS_BINDING);
    chmodSync(profilesDir, 0o700);

    const marker = readMarker();
    expect(marker.phase).toBe("linking");
    expect(marker.token).toBeTruthy();
  });

  it("leaves no temp files behind after a completed cycle", () => {
    const guarded = install({ dlopen: () => "loaded" });
    guarded.call(process, {}, CANVAS_BINDING);
    settleNativeCanvasAttempt();

    expect(readdirSync(profilesDir).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  it("matches a Windows skia path with backslashes", () => {
    const guarded = install({ dlopen: () => "loaded" });
    guarded.call(process, {}, SKIA_BINDING);
    expect(existsSync(markerPath())).toBe(true);
  });

  it("leaves unrelated native modules completely alone", () => {
    const seen = [];
    const guarded = install({
      dlopen: (module, filename) => {
        seen.push(filename);
        return "loaded";
      },
    });

    expect(guarded.call(process, {}, UNRELATED_BINDING)).toBe("loaded");

    expect(seen).toEqual([UNRELATED_BINDING]);
    expect(existsSync(markerPath())).toBe(false);
  });
});

describe("a load that raises is survival, and must not latch", () => {
  it("clears the marker when dlopen throws", () => {
    // A missing VC++ runtime or an architecture mismatch raises. The host is
    // intact, so this has to stay retryable forever; latching it would disable
    // rendering permanently over a fixable environment problem.
    const guarded = install({
      dlopen: () => {
        throw new Error("Cannot find native binding");
      },
    });

    expect(() => guarded.call(process, {}, CANVAS_BINDING)).toThrow(/native binding/);

    expect(existsSync(markerPath())).toBe(false);
    expect(nativeCanvasLatchState(markerPath())).toBe("clear");
  });
});

describe("a load that never returns latches off on the next boot", () => {
  it("reports latched when a marker is left behind by a dead process", () => {
    // Simulate the crash: run the guard, never settle, then re-attribute the
    // marker to a process that no longer exists.
    //
    // restore() is load-bearing, not cleanup. A process that died cannot still
    // be holding its ownership token in memory, and the latch deliberately
    // recognises its own token as re-entry rather than a crash. Leaving the
    // token in memory would simulate a process that crashed and kept running.
    const guarded = install({ dlopen: () => "loaded" });
    guarded.call(process, {}, CANVAS_BINDING);
    const marker = readMarker();
    installed.restore();

    withDeadOwnerMarker(marker, () => {
      expect(nativeCanvasLatchState(markerPath())).toBe("latched");
      expect(embeddedNativeCanvasAllowed({
        env: { PDF_TOOLS_EMBEDDED_NATIVE_CANVAS: "1" },
        platform: "win32",
        markerPath: markerPath(),
      })).toBe(false);
    });
  });

  it("refuses the next load and records why", () => {
    const guarded = install({ dlopen: () => "loaded" });

    withDeadOwnerMarker({ phase: "drawing", token: "someone-elses-token" }, () => {
      expect(() => guarded.call(process, {}, CANVAS_BINDING))
        .toThrow(/native canvas binding is disabled/);

      expect(nativeCanvasBlockReason()).toBe("latched");
    });
  });

  it("lets =force recover a latched install without hand-editing state", () => {
    writeFileSync(markerPath(), JSON.stringify({
      phase: "drawing",
      token: "someone-elses-token",
      pid: deadPid(),
    }));
    process.env.PDF_TOOLS_EMBEDDED_NATIVE_CANVAS = "force";
    const guarded = install({ dlopen: () => "loaded" });

    expect(guarded.call(process, {}, CANVAS_BINDING)).toBe("loaded");
  });

  it("treats an unparseable marker as a latch rather than reasoning past it", () => {
    writeFileSync(markerPath(), "{ this is not json");
    expect(nativeCanvasLatchState(markerPath())).toBe("latched");
  });

  it("treats an empty marker as no marker", () => {
    writeFileSync(markerPath(), "");
    expect(nativeCanvasLatchState(markerPath())).toBe("clear");
  });
});

describe("ownership keeps two servers from erasing each other", () => {
  it("does not clear a marker written by another process", () => {
    // The reverted design had no ownership at all: any server sharing the home
    // directory could delete an in-flight marker and destroy the evidence of a
    // crash that was still in progress.
    const guarded = install({ dlopen: () => "loaded" });
    guarded.call(process, {}, CANVAS_BINDING);

    const foreign = { phase: "linking", token: "not-ours", pid: process.pid };
    writeFileSync(markerPath(), JSON.stringify(foreign));
    settleNativeCanvasAttempt();

    expect(existsSync(markerPath())).toBe(true);
    expect(readMarker().token).toBe("not-ours");
  });

  it("does not latch against its own in-flight attempt", () => {
    // Re-entry inside one process must not read as a crash. Without this the
    // second canvas load in a single session would latch the install off,
    // because the first one legitimately still has its marker on disk.
    const guarded = install({ dlopen: () => "loaded" });
    guarded.call(process, {}, CANVAS_BINDING);

    expect(nativeCanvasLatchState(markerPath())).toBe("clear");
    expect(guarded.call(process, {}, CANVAS_BINDING)).toBe("loaded");
  });

  it("reports a live foreign attempt as concurrent, not as a crash", () => {
    // A living process mid-attempt has not crashed. Calling that "latched" would
    // permanently disable rendering because two servers started at once.
    writeFileSync(markerPath(), JSON.stringify({
      phase: "linking",
      token: "not-ours",
      pid: process.pid,
    }));

    expect(nativeCanvasLatchState(markerPath())).toBe("concurrent");
  });

  it("refuses a concurrent load and records the reason", () => {
    writeFileSync(markerPath(), JSON.stringify({
      phase: "linking",
      token: "not-ours",
      pid: process.pid,
    }));
    const guarded = install({ dlopen: () => "loaded" });

    expect(() => guarded.call(process, {}, CANVAS_BINDING)).toThrow();

    expect(nativeCanvasBlockReason()).toBe("concurrent");
  });
});

describe("arming is exclusive, which closes the check-then-write race", () => {
  // nativeCanvasLatchState() reads and armNativeCanvasAttempt() writes, so two
  // servers sharing a home directory can both read "clear" before either writes.
  // The previous version let the second overwrite the first, and that lost real
  // crashes: if the first died mid-draw, the surviving marker carried the
  // second's token and a live pid, so the crash read as "concurrent" instead of
  // "latched" and was never caught.
  it("refuses to arm when another process already holds the marker", () => {
    // A foreign marker, i.e. one this process did not arm. Arming twice from a
    // single process is re-entry and is allowed, so contention can only be
    // exercised against a marker we do not own.
    writeFileSync(markerPath(), JSON.stringify({
      phase: "linking", token: "not-ours", pid: process.pid,
    }));

    expect(armNativeCanvasAttempt(markerPath())).toBe("contended");
  });

  it("does not overwrite the incumbent marker when it loses", () => {
    // The whole point of the exclusive create: the loser must leave the
    // incumbent intact, because that incumbent may be about to crash under it.
    writeFileSync(markerPath(), JSON.stringify({
      phase: "linking", token: "not-ours", pid: process.pid,
    }));

    armNativeCanvasAttempt(markerPath());

    expect(readMarker().token).toBe("not-ours");
  });

  it("allows re-entry within one process", () => {
    expect(armNativeCanvasAttempt(markerPath())).toBe("armed");
    // Same process, marker still in flight. This is not contention.
    expect(armNativeCanvasAttempt(markerPath())).toBe("armed");
  });

  it("reports an unwritable directory as unwritable, not as contention", () => {
    // mkdirSync also raises EEXIST when a path component is a plain file, so
    // these two failures are easy to conflate and must not be.
    process.env.DEFAULT_PROFILES_DIR = join(profilesDir, "blocked");
    writeFileSync(join(profilesDir, "blocked"), "not a directory");

    expect(armNativeCanvasAttempt(markerPath())).toBe("unwritable");
  });

  it("reports a create failure that is not contention as unwritable", () => {
    // The directory exists, so mkdir succeeds and the failure comes from the
    // exclusive create itself - the path that actually distinguishes EEXIST
    // (someone else owns it) from every other error (we cannot write at all).
    // Without this, conflating the two survives the suite untouched.
    chmodSync(profilesDir, 0o500);
    try {
      expect(armNativeCanvasAttempt(markerPath())).toBe("unwritable");
    } finally {
      chmodSync(profilesDir, 0o700);
    }
  });

  it("lets force take the marker from a crashed predecessor", () => {
    writeFileSync(markerPath(), JSON.stringify({
      phase: "drawing", token: "dead-process-token", pid: deadPid(),
    }));

    expect(armNativeCanvasAttempt(markerPath(), { force: true })).toBe("armed");
    expect(readMarker().token).not.toBe("dead-process-token");
  });

  it("refuses a second live process end to end", async () => {
    // A real second process, not a hand-written marker: it imports the module
    // and arms through the same code path, then holds the marker while this
    // process attempts its own load.
    const moduleUrl = new URL("../server/pdfjs-subprocess.js", import.meta.url).href;
    const child = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      `import { armNativeCanvasAttempt } from ${JSON.stringify(moduleUrl)};
       const outcome = armNativeCanvasAttempt(${JSON.stringify(markerPath())});
       process.stdout.write(outcome);
       setTimeout(() => {}, 10000);`,
    ], { stdio: ["ignore", "pipe", "ignore"] });

    const childOutcome = await new Promise(resolve => {
      child.stdout.once("data", chunk => resolve(String(chunk)));
    });
    expect(childOutcome).toBe("armed");

    try {
      const guarded = install({ dlopen: () => "loaded" });
      expect(() => guarded.call(process, {}, CANVAS_BINDING)).toThrow();
      expect(nativeCanvasBlockReason()).toBe("concurrent");
      // The child still owns its marker; this process must not have taken it.
      expect(readMarker().pid).toBe(child.pid);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("the marker location", () => {
  it("ignores an unsubstituted manifest template", () => {
    const path = nativeCanvasMarkerPath({ DEFAULT_PROFILES_DIR: "${HOME}/.pdf-toolkit-files" });
    expect(path).not.toContain("${");
  });

  it("honours a configured profiles directory", () => {
    const path = nativeCanvasMarkerPath({ DEFAULT_PROFILES_DIR: "/var/state/pdf" });
    expect(path).toBe(join("/var/state/pdf", "native-canvas-attempt.json"));
  });
});

describe("a marker that cannot be written refuses the load", () => {
  it("fails closed when the marker path is unwritable", () => {
    // If the marker cannot be written, a crash could not be detected, so the
    // load must not happen. Failing open here would silently remove the entire
    // safety mechanism on any machine with a read-only profiles directory.
    process.env.DEFAULT_PROFILES_DIR = join(profilesDir, "blocked");
    writeFileSync(join(profilesDir, "blocked"), "not a directory");
    let loaded = false;
    const guarded = install({
      dlopen: () => {
        loaded = true;
        return "loaded";
      },
    });

    expect(() => guarded.call(process, {}, CANVAS_BINDING)).toThrow();

    expect(loaded).toBe(false);
    expect(nativeCanvasBlockReason()).toBe("marker_unwritable");
  });
});
