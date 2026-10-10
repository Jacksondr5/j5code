/**
 * The T3 Code release this J5 build is based on. J5 keeps its own version line, so anything
 * upstream keys by its app version (the provider compatibility table's `t3CodeRange`) is looked up
 * with this instead of J5's own `package.json` version. Set it at every upstream advance.
 */
export const J5_UPSTREAM_T3_CODE_VERSION = "0.0.45";
