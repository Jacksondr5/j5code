import * as Schema from "effect/Schema";
import { ModelSelection } from "../modelSelection.ts";
import { ProviderInstanceId } from "../providerInstance.ts";

export const UsageLimitFailoverSettings = Schema.Struct({
  enabled: Schema.Boolean,
  routes: Schema.Array(ModelSelection),
  maxHops: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 4 })),
  // An operator attests these instances use subscription auth with paid usage disabled.
  subscriptionOnlyInstances: Schema.Array(ProviderInstanceId),
});
