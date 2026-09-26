import { assert, it } from "@effect/vitest";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { Effect } from "effect";

import {
  openCodeChildPermissionRules,
  openCodePermissionRules,
} from "../../../orchestration-v2/Adapters/OpenCodeAdapterV2.ts";
import { ProviderAdapterV2RuntimePolicy } from "../../../orchestration-v2/ProviderAdapter.ts";
import { J5_PREAPPROVED_TOOLS, j5PreapprovedTools } from "./j5ToolPreapproval.ts";
import {
  J5_APPROVAL_POLICY_MATRIX,
  J5_NEVER_PREAPPROVED_TOOLS,
} from "./j5ToolPreapproval.testkit.ts";
import { j5OpenCodeAllowsT3McpTools, j5OpenCodeT3McpKeysAreOurs } from "./openCodeToolApproval.ts";

type MatrixPolicy = NonNullable<(typeof J5_APPROVAL_POLICY_MATRIX)[number]["policy"]>;

type Rules = ReturnType<typeof openCodePermissionRules>;

const glob = (value: string, pattern: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
    "s",
  ).test(value);

// OpenCode 1.15 (`PermissionV2.evaluate`): the last rule whose permission and pattern both
// wildcard-match wins, and no match means ask. An MCP call asks for permission
// `<server>_<tool>` with pattern `*`, and the adapter registers the server as `t3-code`.
const action = (rules: Rules, tool: string) =>
  rules.findLast((rule) => glob(`t3-code_${tool}`, rule.permission) && glob("*", rule.pattern))
    ?.action ?? "ask";

// What OpenCode decides for a t3-code tool nobody lists: the adapter's own verdict.
const unlisted = (rules: Rules) => action(rules, "unlisted_tool");

const policy = (base: MatrixPolicy, override: Partial<ProviderAdapterV2RuntimePolicy> = {}) =>
  ProviderAdapterV2RuntimePolicy.make({
    interactionMode: "default",
    cwd: null,
    ...base,
    ...override,
  });

// Without a sandbox, full-access under never collapses to a single `* allow`; a read-only
// sandbox (how personas run) keeps the gated rule list.
const SANDBOXES = [
  { label: "no sandbox", override: {} },
  {
    label: "read-only sandbox",
    override: {
      sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
    },
  },
] as const;

const cases = J5_APPROVAL_POLICY_MATRIX.flatMap(({ label, policy: base }) =>
  base === undefined
    ? []
    : SANDBOXES.map((sandbox) => ({
        label: `${label}, ${sandbox.label}`,
        base,
        runtimePolicy: policy(base, sandbox.override),
      })),
);

const OTHER_T3_TOOLS = (allowed: ReadonlyArray<string>) => [
  ...J5_PREAPPROVED_TOOLS.filter((name) => !allowed.includes(name)),
  ...J5_NEVER_PREAPPROVED_TOOLS,
];

it("allows the shared J5 set in every runtime mode and leaves other t3-code tools to the adapter", () => {
  for (const { label, base, runtimePolicy } of cases) {
    const rules = openCodePermissionRules(runtimePolicy, true);
    const allowed = j5PreapprovedTools(base);
    for (const tool of allowed)
      assert.strictEqual(action(rules, tool), "allow", `${label} ${tool}`);
    for (const tool of OTHER_T3_TOOLS(allowed))
      assert.strictEqual(action(rules, tool), unlisted(rules), `${label} ${tool}`);
  }
});

it("still asks for spawning and lifecycle tools in approval-required mode", () => {
  const rules = openCodePermissionRules(policy({ runtimeMode: "approval-required" }), true);
  assert.strictEqual(action(rules, "propose_crew"), "allow");
  for (const tool of ["spawn_agent", "stop_crew", "delegate_task", "t3_worktree_handoff"])
    assert.strictEqual(action(rules, tool), "ask", tool);
});

it("lets a read-only persona under never use the full set but not worktree handoff", () => {
  const rules = openCodePermissionRules(
    policy({ runtimeMode: "approval-required", approvalPolicy: "never" }, SANDBOXES[1].override),
    true,
  );
  for (const tool of J5_PREAPPROVED_TOOLS) assert.strictEqual(action(rules, tool), "allow", tool);
  for (const tool of J5_NEVER_PREAPPROVED_TOOLS)
    assert.strictEqual(action(rules, tool), "deny", tool);
});

it("gives task-created child sessions the parent's verdict for every t3-code tool", () => {
  for (const { label, runtimePolicy } of cases) {
    const parent = openCodePermissionRules(runtimePolicy, true);
    // OpenCode seeds a child with the parent's denies plus the agent's own recursion guard.
    const nativeChildRules: Rules = [
      ...parent.filter((rule) => rule.action === "deny"),
      { permission: "task", pattern: "*", action: "deny" },
    ];
    for (const native of [[], nativeChildRules]) {
      const child = openCodeChildPermissionRules(runtimePolicy, native, true);
      for (const tool of [...J5_PREAPPROVED_TOOLS, ...J5_NEVER_PREAPPROVED_TOOLS])
        assert.strictEqual(action(child, tool), action(parent, tool), `${label} ${tool}`);
    }
  }
});

it("installs no J5 allows in any mode on a session without T3's own t3-code server", () => {
  for (const { label, runtimePolicy } of cases) {
    const rules = openCodePermissionRules(runtimePolicy, false);
    for (const tool of [...J5_PREAPPROVED_TOOLS, ...J5_NEVER_PREAPPROVED_TOOLS])
      assert.strictEqual(action(rules, tool), unlisted(rules), `${label} ${tool}`);
  }
});

const statusClient = (servers: ReadonlyArray<string> | Error) =>
  ({
    mcp: {
      status: async () => {
        if (servers instanceof Error) throw servers;
        return { data: Object.fromEntries(servers.map((name) => [name, { status: "connected" }])) };
      },
    },
  }) as unknown as OpencodeClient;

it.effect("allows T3 tools only on an injected server no other MCP server can collide with", () =>
  Effect.gen(function* () {
    // An external OpenCode server never gets T3's injection, so it is never allowed.
    assert.isFalse(yield* j5OpenCodeAllowsT3McpTools(statusClient(["t3-code"]), false));
    assert.isTrue(yield* j5OpenCodeAllowsT3McpTools(statusClient(["t3-code", "github"]), true));
    // A server `t3-code_send` with a tool `message` sanitizes to `t3-code_send_message`.
    assert.isFalse(
      yield* j5OpenCodeAllowsT3McpTools(statusClient(["t3-code", "t3-code_send"]), true),
    );
    assert.isFalse(yield* j5OpenCodeAllowsT3McpTools(statusClient(new Error("offline")), true));
    // The adapter's client throws on error, but a client built without `throwOnError` resolves
    // `{ data: undefined, error }`; that must not read as "no colliding servers".
    const resolvedError = {
      mcp: { status: async () => ({ data: undefined, error: { message: "unavailable" } }) },
    } as unknown as OpencodeClient;
    assert.isFalse(yield* j5OpenCodeAllowsT3McpTools(resolvedError, true));
    // An error alongside data, or a body that is not a server map, also fails closed.
    for (const [index, response] of [
      { data: { "t3-code": { status: "connected" } }, error: { message: "partial" } },
      { data: null },
      { data: "t3-code" },
    ].entries())
      assert.isFalse(
        yield* j5OpenCodeAllowsT3McpTools(
          { mcp: { status: async () => response } } as unknown as OpencodeClient,
          true,
        ),
        `malformed status ${index}`,
      );
    // Only T3's own server, actually connected, backs the `t3-code_<tool>` keys.
    const withStatuses = (data: Record<string, { status: string }>) =>
      ({ mcp: { status: async () => ({ data }) } }) as unknown as OpencodeClient;
    assert.isFalse(
      yield* j5OpenCodeAllowsT3McpTools(withStatuses({ github: { status: "connected" } }), true),
      "t3-code missing",
    );
    for (const status of ["disabled", "failed", "needs_auth", "needs_client_registration"])
      assert.isFalse(
        yield* j5OpenCodeAllowsT3McpTools(withStatuses({ "t3-code": { status } }), true),
        `t3-code ${status}`,
      );
  }),
);

it("treats any server whose sanitized name starts with t3-code_ as a collision", () => {
  assert.isTrue(j5OpenCodeT3McpKeysAreOurs(["t3-code", "t3_code", "t3-codex", "t3code_x"]));
  for (const name of ["t3-code_send", "t3-code.send", "t3-code send", "t3-code/"])
    assert.isFalse(j5OpenCodeT3McpKeysAreOurs(["t3-code", name]), name);
});
