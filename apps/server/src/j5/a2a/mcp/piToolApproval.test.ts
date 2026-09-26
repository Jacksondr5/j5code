import * as NodeModule from "node:module";

import { assert, it } from "@effect/vitest";

import type { McpProviderSessionConfig } from "../../../mcp/McpProviderSession.ts";
import { PI_T3_MCP_EXTENSION_SOURCE } from "../../../orchestration-v2/Adapters/piT3McpExtensionSource.ts";
import { buildPiRpcLaunch } from "../../../orchestration-v2/Adapters/piT3McpInjection.ts";
import { J5_PREAPPROVED_TOOLS, j5PreapprovedTools, j5T3McpToolName } from "./j5ToolPreapproval.ts";
import {
  J5_APPROVAL_POLICY_MATRIX,
  J5_NEVER_PREAPPROVED_TOOLS,
} from "./j5ToolPreapproval.testkit.ts";
import {
  J5_PI_EXTENSION_PATH_ENV,
  J5_PI_PREAPPROVED_TOOLS_ENV,
  j5PiPreapprovalEnv,
} from "./piToolApproval.ts";

type MatrixPolicy = NonNullable<(typeof J5_APPROVAL_POLICY_MATRIX)[number]["policy"]>;

type ToolCallHandler = (
  event: { toolName: string; input: unknown },
  ctx: { ui: { confirm: () => Promise<boolean> } },
) => Promise<unknown>;

type RegisteredTool = {
  readonly name: string;
  readonly parameters: unknown;
  readonly path?: string;
};

const MCP_ENDPOINT = "http://127.0.0.1:43123/mcp";
const EXTENSION_PATH = "/tmp/pi-t3-mcp-extension.ts";
const T3_TOOLS = [...J5_PREAPPROVED_TOOLS, ...J5_NEVER_PREAPPROVED_TOOLS];
// Listed for the session but never served by T3's tools/list.
const UNSERVED_TOOL = "mcp__t3-code__unserved_tool";

// T3's MCP server as the bridge sees it: initialize, then one page of tools/list.
const fakeMcpFetch = async (_url: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as { id?: number; method: string };
  if (body.id === undefined) return new Response(null, { status: 202 });
  const result =
    body.method === "tools/list"
      ? { tools: T3_TOOLS.map((name) => ({ name, inputSchema: { type: "object" } })) }
      : {};
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
    headers: { "content-type": "application/json" },
  });
};

// Loads the real extension source Pi would load, against a fake Pi whose tool registry keeps the
// first registration of a name and stamps each with its extension's path, as Pi's does.
// `preregistered` stands in for extensions Pi loaded before T3's; `stampedPath` is the path Pi
// stamps on T3's own registrations. Each load is a fresh module, as each Pi process is.
let loads = 0;
const withToolCallHook = async (
  env: NodeJS.ProcessEnv,
  run: (hook: ToolCallHandler) => Promise<void>,
  options: {
    readonly preregistered?: ReadonlyArray<RegisteredTool>;
    readonly getAllTools?: false;
    readonly stampedPath?: string;
  } = {},
) => {
  const savedEnv = process.env;
  const savedFetch = globalThis.fetch;
  process.env = env;
  globalThis.fetch = fakeMcpFetch as typeof fetch;
  try {
    const source = NodeModule.stripTypeScriptTypes(PI_T3_MCP_EXTENSION_SOURCE).replace(
      /import \{ Type \} from "typebox";/,
      "const Type = { Object: () => ({}) };",
    );
    const module = await import(
      `data:text/javascript,${encodeURIComponent(`${source}\n// load ${loads++}`)}`
    );
    const registry = new Map<string, RegisteredTool>();
    for (const tool of options.preregistered ?? []) registry.set(tool.name, tool);
    const handlers = new Map<string, ToolCallHandler>();
    await module.default({
      on: (name: string, handler: ToolCallHandler) => handlers.set(name, handler),
      registerTool: (tool: RegisteredTool) => {
        if (!registry.has(tool.name))
          registry.set(tool.name, { ...tool, path: options.stampedPath ?? EXTENSION_PATH });
      },
      ...(options.getAllTools === false
        ? {}
        : {
            getAllTools: () =>
              [...registry.values()].map(({ name, parameters, path }) => ({
                name,
                parameters,
                sourceInfo: { path: path ?? "/other/extension.ts" },
              })),
          }),
    });
    const hook = handlers.get("tool_call");
    assert.isDefined(hook);
    await run(hook!);
  } finally {
    process.env = savedEnv;
    globalThis.fetch = savedFetch;
  }
};

const confirms = async (hook: ToolCallHandler, toolName: string) => {
  let asked = false;
  await hook({ toolName, input: {} }, { ui: { confirm: async () => ((asked = true), true) } });
  return asked;
};

// A server environment that already carries a wider list and a stale mode, as a nested provider
// process would.
const INHERITED_ENV = {
  [J5_PI_PREAPPROVED_TOOLS_ENV]: J5_PREAPPROVED_TOOLS.map(j5T3McpToolName).join(","),
  [J5_PI_EXTENSION_PATH_ENV]: "/inherited/extension.ts",
  T3_PI_RUNTIME_MODE: "full-access",
};

const MCP_SESSION = {
  endpoint: MCP_ENDPOINT,
  authorizationHeader: "Bearer secret-pi-token",
} as McpProviderSessionConfig;

// The Pi process environment the adapter builds for this policy.
const launchEnv = (policy: MatrixPolicy, credentials = true) =>
  buildPiRpcLaunch({
    launchArgs: [],
    environment: { ...INHERITED_ENV, ...j5PiPreapprovalEnv(policy, credentials, EXTENSION_PATH) },
    mcpSession: credentials ? MCP_SESSION : undefined,
    extensionPath: EXTENSION_PATH,
    runtimeMode: policy.runtimeMode,
  }).env;

it("always sets the preapproval key so an inherited value never widens a session", () => {
  for (const { label, policy } of J5_APPROVAL_POLICY_MATRIX) {
    if (policy === undefined) continue;
    assert.deepEqual(
      j5PiPreapprovalEnv(policy, true, EXTENSION_PATH)[J5_PI_PREAPPROVED_TOOLS_ENV].split(","),
      j5PreapprovedTools(policy).map(j5T3McpToolName),
      label,
    );
    assert.strictEqual(launchEnv(policy)[J5_PI_EXTENSION_PATH_ENV], EXTENSION_PATH, label);
    // Without credentials both keys still overwrite the inherited values, with nothing.
    assert.strictEqual(launchEnv(policy, false)[J5_PI_PREAPPROVED_TOOLS_ENV], "", label);
    assert.strictEqual(launchEnv(policy, false)[J5_PI_EXTENSION_PATH_ENV], "", label);
  }
});

it("lets T3's own J5 tools through Pi's tool_call hook without a confirm", async () => {
  for (const { label, policy } of J5_APPROVAL_POLICY_MATRIX) {
    if (policy === undefined) continue;
    await withToolCallHook(launchEnv(policy), async (hook) => {
      const allowed = j5PreapprovedTools(policy);
      for (const tool of allowed)
        assert.isFalse(await confirms(hook, j5T3McpToolName(tool)), `${label} ${tool}`);
      // Pi keys off runtime mode alone: full-access already skips every confirm, which the
      // append must neither add to nor take away from.
      const gated = policy.runtimeMode !== "full-access";
      for (const tool of [
        ...J5_PREAPPROVED_TOOLS.filter((name) => !allowed.includes(name)),
        ...J5_NEVER_PREAPPROVED_TOOLS,
      ])
        assert.strictEqual(await confirms(hook, j5T3McpToolName(tool)), gated, `${label} ${tool}`);
      assert.strictEqual(await confirms(hook, "bash"), gated, label);
    });
  }
});

it("asks before spawning in approval-required mode but not for a read-only persona", async () => {
  await withToolCallHook(launchEnv({ runtimeMode: "approval-required" }), async (hook) => {
    assert.isFalse(await confirms(hook, "mcp__t3-code__propose_crew"));
    assert.isTrue(await confirms(hook, "mcp__t3-code__spawn_agent"));
    assert.isTrue(await confirms(hook, "bash"));
  });
  await withToolCallHook(
    launchEnv({ runtimeMode: "approval-required", approvalPolicy: "never" }),
    async (hook) => {
      assert.isFalse(await confirms(hook, "mcp__t3-code__spawn_agent"));
      assert.isTrue(await confirms(hook, "mcp__t3-code__t3_worktree_handoff"));
    },
  );
});

it("skips nothing when the launch has no T3 MCP credentials", async () => {
  const policy = { runtimeMode: "approval-required", approvalPolicy: "never" } as const;
  await withToolCallHook(launchEnv(policy, false), async (hook) => {
    for (const tool of J5_PREAPPROVED_TOOLS)
      assert.isTrue(await confirms(hook, j5T3McpToolName(tool)), tool);
  });
});

it("still confirms a J5 name that another extension registered first", async () => {
  const policy = { runtimeMode: "approval-required", approvalPolicy: "never" } as const;
  const hijacked = j5T3McpToolName("propose_crew");
  await withToolCallHook(
    launchEnv(policy),
    async (hook) => {
      assert.isTrue(await confirms(hook, hijacked));
      assert.isFalse(await confirms(hook, j5T3McpToolName("send_message")));
    },
    { preregistered: [{ name: hijacked, parameters: {} }] },
  );
});

it("confirms every tool on a Pi that cannot say which registration will run", async () => {
  const policy = { runtimeMode: "approval-required", approvalPolicy: "never" } as const;
  await withToolCallHook(
    launchEnv(policy),
    async (hook) => {
      for (const tool of J5_PREAPPROVED_TOOLS)
        assert.isTrue(await confirms(hook, j5T3McpToolName(tool)), tool);
    },
    { getAllTools: false },
  );
});

const PERSONA = { runtimeMode: "approval-required", approvalPolicy: "never" } as const;

it("confirms every tool when the bridge's extension path is missing or not the one Pi stamped", async () => {
  await withToolCallHook(
    { ...launchEnv(PERSONA), [J5_PI_EXTENSION_PATH_ENV]: "" },
    async (hook) => {
      for (const tool of J5_PREAPPROVED_TOOLS)
        assert.isTrue(await confirms(hook, j5T3McpToolName(tool)), tool);
    },
  );
  await withToolCallHook(
    launchEnv(PERSONA),
    async (hook) => {
      for (const tool of J5_PREAPPROVED_TOOLS)
        assert.isTrue(await confirms(hook, j5T3McpToolName(tool)), tool);
    },
    { stampedPath: "/elsewhere/pi-t3-mcp-extension.ts" },
  );
  // The same file reached through a non-normalized path is still the bridge.
  await withToolCallHook(
    launchEnv(PERSONA),
    async (hook) => assert.isFalse(await confirms(hook, j5T3McpToolName("propose_crew"))),
    { stampedPath: "/tmp/./pi-t3-mcp-extension.ts" },
  );
});

it("confirms a listed name the bridge never registered", async () => {
  const env = launchEnv(PERSONA);
  await withToolCallHook(
    {
      ...env,
      [J5_PI_PREAPPROVED_TOOLS_ENV]: `${env[J5_PI_PREAPPROVED_TOOLS_ENV]},${UNSERVED_TOOL}`,
    },
    async (hook) => assert.isTrue(await confirms(hook, UNSERVED_TOOL)),
    { preregistered: [{ name: UNSERVED_TOOL, parameters: {}, path: EXTENSION_PATH }] },
  );
});

it("ignores names outside the t3-code server even if the variable lists them", async () => {
  await withToolCallHook(
    {
      ...launchEnv({ runtimeMode: "approval-required" }),
      [J5_PI_PREAPPROVED_TOOLS_ENV]:
        "bash,edit,mcp__slack__send_message,mcp__t3-code__send_message",
    },
    async (hook) => {
      assert.isTrue(await confirms(hook, "bash"));
      assert.isTrue(await confirms(hook, "edit"));
      assert.isTrue(await confirms(hook, "mcp__slack__send_message"));
      assert.isFalse(await confirms(hook, "mcp__t3-code__send_message"));
    },
  );
});
