/**
 * Count of HTTP requests this process is serving, across every hosted entry
 * point. The memory guard only asks the platform to replace a process when it
 * is serving nothing, so no request in flight is cut off.
 */
let inflight = 0;

export async function trackRequest(handle) {
  inflight++;
  try {
    return await handle();
  } finally {
    inflight--;
  }
}

export const requestsInFlight = () => inflight;
