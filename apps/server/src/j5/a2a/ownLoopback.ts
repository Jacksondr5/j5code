import * as Layer from "effect/Layer";

import * as PeerLinks from "../../peer/PeerLinks.ts";

/**
 * No address counts as this machine: J5 links same-machine servers at 127.0.0.1/[::1], and a line
 * at 127.77.x.y. The answer must still name the environment the link expects (register D49).
 */
const noOwnLoopback = (_host: string): boolean => false;

/** For every place that builds upstream's `PeerLinks`: the server's links and `j5 environment`. */
export const noOwnLoopbackLayer = Layer.succeed(PeerLinks.LoopbackHost, noOwnLoopback);
