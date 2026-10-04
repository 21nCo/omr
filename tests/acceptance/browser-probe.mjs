/** Poll a browser condition without beginning or accepting a probe past its deadline. */
export async function until(check, label, deadline = Date.now() + 15_000,
  { now = Date.now, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const remaining = deadline - now();
  if (remaining <= 0) throw new Error(`Timed out waiting for ${label}`);
  let timer;
  let value;
  try {
    value = await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
  if (value) return value;
  await pause(Math.min(50, Math.max(0, deadline - now())));
  return until(check, label, deadline, { now, pause });
}

/** Attempt every cleanup step and report failures without hiding the probe error. */
export async function cleanupAll(steps, report) {
  let failed = false;
  for (const step of steps) {
    try { await step(); }
    catch (error) { failed = true; report(error); }
  }
  return failed;
}
