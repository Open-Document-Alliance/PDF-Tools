import { describe, expect, it } from "vitest";
import {
  captureChildCurrentRssReader,
  captureChildPeakRssReader,
  maximumRssOrUnavailable,
} from "../scripts/child-process-rss.mjs";

function procFixture({ parent = 700, localParent = 10, child = 701, localChild = 11, namespaces = true } = {}) {
  const files = new Map();
  const status = (pid, ppid, localPid, peak = 100, rss = 20) =>
    `Name:\tnode\nPid:\t${pid}\nPPid:\t${ppid}\n`
    + (namespaces ? `NSpid:\t${pid}${localPid === pid ? "" : ` ${localPid}`}\n` : "")
    + `VmHWM:\t${peak} kB\nVmRSS:\t${rss} kB\n`;
  const stat = (pid, start = "1234") => `${pid} (node worker (main)) S ${Array(18).fill("0").join(" ")} ${start} 0\n`;
  const put = (pid, ppid, localPid, peak = 100, start = "1234") => {
    files.set(`/proc/${pid}/status`, status(pid, ppid, localPid, peak));
    files.set(`/proc/${pid}/stat`, stat(pid, start));
  };
  files.set("/proc/self/status", status(parent, 1, localParent));
  put(child, parent, localChild);
  const fileSystem = {
    readFileSync(file) {
      if (!files.has(file)) throw new Error("Process disappeared.");
      return files.get(file);
    },
    readdirSync: () => [...new Set([...files.keys()].map(file => file.split("/")[2]))],
  };
  const options = {
    fileSystem, parentPid: localParent, platform: "linux",
  };
  return { files, status, stat, put,
    read: () => captureChildPeakRssReader(localChild, options),
    readCurrent: () => captureChildCurrentRssReader(localChild, options),
  };
}

describe("identity-bound child peak RSS", () => {
  it("maps an inner PID to its direct child, ignoring a colliding outer PID and descendants", () => {
    const fixture = procFixture();
    fixture.put(11, 1, 11, 999_999);
    fixture.put(702, 701, 12, 999_999);
    const read = fixture.read();
    expect(read()).toBe(100 * 1024);
    fixture.put(701, 700, 11, 250);
    expect(read()).toBe(250 * 1024);
  });

  it.each([true, false])("supports an ordinary proc mount with NSpid present=%s", namespaces => {
    expect(procFixture({ parent: 10, localParent: 10, child: 11, localChild: 11, namespaces }).read()())
      .toBe(100 * 1024);
  });

  it("supports a runner that is its PID namespace's init process", () => {
    const fixture = procFixture({ parent: 1, localParent: 1, child: 2, localChild: 2 });
    fixture.files.set("/proc/self/status", fixture.status(1, 0, 1));
    expect(fixture.read()()).toBe(100 * 1024);
  });

  it("does not map by a matching namespace PID under another parent", () => {
    const fixture = procFixture();
    fixture.put(701, 600, 11);
    expect(fixture.read()()).toBeNull();
  });

  it("fails closed when the mapping is ambiguous", () => {
    const fixture = procFixture();
    fixture.put(702, 700, 11);
    expect(fixture.read()()).toBeNull();
  });

  it("does not guess a nested mapping when NSpid is unavailable", () => {
    expect(procFixture({ namespaces: false }).read()()).toBeNull();
  });

  it("rejects PID reuse after capture even if parent and namespace PID match", () => {
    const fixture = procFixture();
    const read = fixture.read();
    fixture.put(701, 700, 11, 50, "9999");
    expect(read()).toBeNull();
  });

  it("rejects reparenting or namespace identity drift after capture", () => {
    for (const [parent, localPid] of [[1, 11], [700, 12]]) {
      const fixture = procFixture();
      const read = fixture.read();
      fixture.put(701, parent, localPid);
      expect(read()).toBeNull();
    }
  });

  it("never replaces absent or malformed VmHWM with VmRSS or zero", () => {
    for (const line of ["", "VmHWM: -1 kB", "VmHWM: 0 kB", "VmHWM: 9007199254740992 kB"]) {
      const fixture = procFixture();
      const read = fixture.read();
      fixture.files.set("/proc/701/status", fixture.status(701, 700, 11).replace(/^VmHWM:.*$/m, line));
      expect(read()).toBeNull();
    }
  });

  it("returns unavailable if the captured process vanishes", () => {
    const fixture = procFixture();
    const read = fixture.read();
    fixture.files.delete("/proc/701/stat");
    expect(read()).toBeNull();
  });

  it("returns unavailable on platforms without Linux proc", () => {
    expect(captureChildPeakRssReader(11, { platform: "darwin" })()).toBeNull();
  });

  it("reads current RSS separately from the kernel high-water mark", () => {
    const fixture = procFixture();
    fixture.put(11, 1, 11, 999_999);
    const read = fixture.readCurrent();
    expect(read()).toBe(20 * 1024);
    fixture.files.set("/proc/701/status", fixture.status(701, 700, 11, 100, 10));
    expect(read()).toBe(10 * 1024);
    fixture.put(701, 700, 11, 100, "9999");
    expect(read()).toBeNull();
  });

  it("does not substitute VmHWM when current RSS is unavailable", () => {
    const fixture = procFixture();
    const read = fixture.readCurrent();
    fixture.files.set("/proc/701/status", fixture.status(701, 700, 11).replace(/^VmRSS:.*$/m, ""));
    expect(read()).toBeNull();
  });
});

describe("sampled RSS aggregation", () => {
  it("retains the maximum when every supplied observation is measured", () => {
    expect(maximumRssOrUnavailable([20, 100, 50])).toBe(100);
  });

  it.each([[], [null], [null, null], [100, null], [null, 100], [0], [-1], [NaN]].map(samples => ({ samples })))(
    "keeps missing or invalid observations unavailable: $samples", ({ samples }) => {
      expect(maximumRssOrUnavailable(samples)).toBeNull();
    },
  );

  it("does not erase a missing call or sample when later values are available", () => {
    let peak = maximumRssOrUnavailable([100]);
    peak = maximumRssOrUnavailable([peak, null]);
    peak = maximumRssOrUnavailable([peak, 200]);
    expect(peak).toBeNull();
    expect(maximumRssOrUnavailable([100, peak, 300])).toBeNull();
  });
});
