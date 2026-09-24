import { EnvironmentId } from "@t3tools/contracts";
import {
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";

export function testPreparedConnection(
  httpBaseUrl = "http://environment.test",
  environmentId = EnvironmentId.make("test-environment"),
): PreparedConnection {
  const wsBaseUrl = httpBaseUrl.replace(/^http/, "ws");
  return {
    environmentId,
    label: "Test environment",
    httpBaseUrl,
    socketUrl: `${wsBaseUrl}/ws`,
    httpAuthorization: null,
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Test environment",
      httpBaseUrl,
      wsBaseUrl,
    }),
  };
}
