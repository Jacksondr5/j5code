import * as Predicate from "effect/Predicate";

/**
 * Sends a command whose input came from a system sheet. Returning from a long sheet reconnects the
 * environment (`MOBILE_BACKGROUND_RECONNECT_AFTER_MS`), and a send made meanwhile is refused before
 * it leaves the device, so that one refusal waits for the reconnect and sends once more.
 */
export async function sendAfterReconnect<A>(input: {
  readonly send: () => Promise<A>;
  /** Resolves true once the environment is connected again, false when the wait runs out. */
  readonly waitForConnected: () => Promise<boolean>;
}): Promise<A> {
  try {
    return await input.send();
  } catch (error) {
    if (!Predicate.isTagged(error, "EnvironmentRpcUnavailableError")) throw error;
    if (!(await input.waitForConnected())) {
      throw new Error("The environment didn't reconnect in time. Try again.", { cause: error });
    }
    return input.send();
  }
}
