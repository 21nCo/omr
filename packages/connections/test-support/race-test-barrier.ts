const RACE_STEP_TIMEOUT_MS = 3_000;

/** Bound a race-test step so a missed operation fails with its name. */
export async function raceStep<T>(operation: Promise<T>, step: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${step} did not complete within ${RACE_STEP_TIMEOUT_MS} ms`)),
          RACE_STEP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Fail immediately if the request ends without entering the expected spy. */
export async function waitForRaceBarrier(
  reached: Promise<void>, request: Promise<unknown>, step: string,
): Promise<void> {
  await raceStep(Promise.race([
    reached,
    request.then(
      () => { throw new Error(`${step} request completed before reaching its barrier`); },
      (error: unknown) => { throw new Error(`${step} request failed before reaching its barrier`, { cause: error }); },
    ),
  ]), step);
}

/** Consume a released request's outcome before test resources are closed. */
export async function settleRaceRequest(request: Promise<unknown>, step: string): Promise<void> {
  await raceStep(request.then(() => undefined, () => undefined), `${step} request after release`);
}
