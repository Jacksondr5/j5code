import { createJ5EnvironmentAtoms } from "@t3tools/client-runtime/j5/state";
import { connectionAtomRuntime } from "../connection/runtime";

export const j5Environment = createJ5EnvironmentAtoms(connectionAtomRuntime);
