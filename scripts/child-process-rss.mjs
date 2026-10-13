import fs from "node:fs";

const unavailable = () => null;
const positiveInteger = value => /^[1-9]\d*$/.test(value ?? "")
  && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const nonnegativeInteger = value => /^(?:0|[1-9]\d*)$/.test(value ?? "")
  && Number.isSafeInteger(Number(value)) ? Number(value) : null;

function statusIdentity(text) {
  const pid = positiveInteger(text.match(/^Pid:\s+(\d+)$/m)?.[1]);
  const ppid = nonnegativeInteger(text.match(/^PPid:\s+(\d+)$/m)?.[1]);
  const namespaceLine = text.match(/^NSpid:\s+(.+)$/m)?.[1];
  const namespacePids = namespaceLine === undefined ? [pid]
    : namespaceLine.trim().split(/\s+/).map(positiveInteger);
  if (!pid || ppid === null || namespacePids.some(value => !value) || namespacePids[0] !== pid) {
    throw new Error("Invalid process identity.");
  }
  return { pid, ppid, namespacePids };
}

function startTime(text, pid) {
  // comm can contain whitespace and parentheses. Fields after its final ')'
  // start at field 3; starttime is field 22 in /proc/<pid>/stat.
  const end = text.lastIndexOf(")");
  const value = text.slice(end + 2).trim().split(/\s+/)[19];
  if (!text.startsWith(`${pid} (`) || end < 0 || !/^\d+$/.test(value ?? "")) {
    throw new Error("Invalid process start identity.");
  }
  return value;
}

/** Capture one direct child's identity before observing its RSS.
 * /proc can expose outer PIDs while child_process returns inner PIDs. Match
 * both the actual parent and its namespace depth; never trust a bare PID.
 * The caller chooses VmRSS or VmHWM explicitly; neither includes descendants.
 */
function captureChildRssReader(childPid, field, {
  fileSystem = fs,
  parentPid = process.pid,
  platform = process.platform,
} = {}) {
  if (platform !== "linux" || !Number.isSafeInteger(childPid) || childPid < 1) return unavailable;
  try {
    const parent = statusIdentity(fileSystem.readFileSync("/proc/self/status", "utf8"));
    if (parent.namespacePids.at(-1) !== parentPid) return unavailable;
    const matchesChild = identity => identity.ppid === parent.pid
      && identity.namespacePids.length === parent.namespacePids.length
      && identity.namespacePids.at(-1) === childPid;
    const observe = pid => {
      const firstStart = startTime(fileSystem.readFileSync(`/proc/${pid}/stat`, "utf8"), pid);
      const status = fileSystem.readFileSync(`/proc/${pid}/status`, "utf8");
      const identity = statusIdentity(status);
      const lastStart = startTime(fileSystem.readFileSync(`/proc/${pid}/stat`, "utf8"), pid);
      if (identity.pid !== pid || firstStart !== lastStart) throw new Error("Process changed during observation.");
      const kib = status.match(field === "VmHWM"
        ? /^VmHWM:\s+(\d+)\s+kB$/m : /^VmRSS:\s+(\d+)\s+kB$/m)?.[1];
      const bytes = kib === undefined ? null : Number(kib) * 1024;
      return { ...identity, start: firstStart,
        bytes: Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null };
    };
    const candidates = [];
    for (const name of fileSystem.readdirSync("/proc")) {
      const pid = positiveInteger(name);
      if (!pid) continue;
      try {
        const identity = statusIdentity(fileSystem.readFileSync(`/proc/${pid}/status`, "utf8"));
        if (identity.pid !== pid || !matchesChild(identity)) continue;
        const observed = observe(pid);
        if (matchesChild(observed)) candidates.push(observed);
      } catch { /* Unrelated processes may exit during enumeration. */ }
    }
    if (candidates.length !== 1) return unavailable;
    const captured = candidates[0];
    return () => {
      try {
        const observed = observe(captured.pid);
        return matchesChild(observed) && observed.start === captured.start
          && observed.namespacePids.every((pid, index) => pid === captured.namespacePids[index])
          ? observed.bytes : null;
      } catch { return null; }
    };
  } catch { return unavailable; }
}

/** Kernel lifetime high-water mark for one identity-bound child. */
export function captureChildPeakRssReader(childPid, options) {
  return captureChildRssReader(childPid, "VmHWM", options);
}

/** Current resident bytes for one identity-bound child, for sampled metrics. */
export function captureChildCurrentRssReader(childPid, options) {
  return captureChildRssReader(childPid, "VmRSS", options);
}

/** A missing observation makes the combined sampled maximum unavailable. */
export function maximumRssOrUnavailable(samples) {
  if (samples.length === 0 || samples.some(value => !Number.isSafeInteger(value) || value <= 0)) return null;
  return samples.reduce((maximum, value) => Math.max(maximum, value), 0);
}
