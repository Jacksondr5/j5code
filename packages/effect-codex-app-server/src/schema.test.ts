import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as CodexSchema from "./schema.ts";

const decodeElicitation = Schema.decodeUnknownSync(CodexSchema.McpServerElicitationRequestParams);
const isElicitation = Schema.is(CodexSchema.McpServerElicitationRequestParams);

const isGetAccountResponse = Schema.is(CodexSchema.V2GetAccountResponse);
const isRateLimitsResponse = Schema.is(CodexSchema.V2GetAccountRateLimitsResponse);
const isRateLimitsUpdated = Schema.is(CodexSchema.V2AccountRateLimitsUpdatedNotification);
const isAccountUpdated = Schema.is(CodexSchema.V2AccountUpdatedNotification);
const isThreadReadResponse = Schema.is(CodexSchema.V2ThreadReadResponse);
const isThreadResumeResponse = Schema.is(CodexSchema.V2ThreadResumeResponse);
const isThreadRollbackResponse = Schema.is(CodexSchema.V2ThreadRollbackResponse);
const isThreadForkResponse = Schema.is(CodexSchema.V2ThreadForkResponse);
const isTurnCompletedNotification = Schema.is(CodexSchema.V2TurnCompletedNotification);
const decodeThreadResumeResponse = Schema.decodeUnknownSync(CodexSchema.V2ThreadResumeResponse);

const isNotificationCollabTool = Schema.is(CodexSchema.ServerNotification__CollabAgentTool);
const isResumeCollabTool = Schema.is(CodexSchema.V2ThreadResumeResponse__CollabAgentTool);
const isNotificationCollabStatus = Schema.is(
  CodexSchema.ServerNotification__CollabAgentToolCallStatus,
);
const isResumeCollabStatus = Schema.is(
  CodexSchema.V2ThreadResumeResponse__CollabAgentToolCallStatus,
);

it("keeps async questions in live notifications and thread history", () => {
  const item = {
    type: "agentMessage",
    id: "question-1",
    text: "Which package?\n- pnpm\n- npm\n\nWhat should it be named?",
    phase: "final_answer",
    delivery: "async",
    questions: [
      { title: "Which package manager?", options: ["pnpm", "npm"] },
      { title: "What should it be named?" },
    ],
  } as const;
  for (const schema of [
    CodexSchema.ServerNotification__ThreadItem,
    CodexSchema.V2ItemStartedNotification__ThreadItem,
    CodexSchema.V2ItemCompletedNotification__ThreadItem,
    CodexSchema.V2ThreadReadResponse__ThreadItem,
    CodexSchema.V2ThreadResumeResponse__ThreadItem,
    CodexSchema.V2ThreadRollbackResponse__ThreadItem,
  ]) {
    assert.deepEqual(Schema.decodeUnknownSync(schema)(item), item);
  }
});

it("accepts Codex 0.150 multi-agent values", () => {
  const schemas = [
    CodexSchema.ServerNotification__SubAgentActivityKind,
    CodexSchema.V2ItemStartedNotification__SubAgentActivityKind,
    CodexSchema.V2ItemCompletedNotification__SubAgentActivityKind,
    CodexSchema.V2ThreadReadResponse__SubAgentActivityKind,
    CodexSchema.V2ThreadResumeResponse__SubAgentActivityKind,
  ];

  for (const schema of schemas) {
    assert.equal(Schema.is(schema)("completed"), true);
  }

  for (const tool of ["sendMessage", "followupTask", "interruptAgent", "listAgents"]) {
    assert.equal(isNotificationCollabTool(tool), true);
    assert.equal(isResumeCollabTool(tool), true);
  }

  assert.equal(isNotificationCollabStatus("interrupted"), true);
  assert.equal(isResumeCollabStatus("interrupted"), true);

  const resumeResponse = {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "/tmp/project",
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    sandbox: { type: "dangerFullAccess" },
    thread: {
      cliVersion: "0.152.1",
      createdAt: 0,
      cwd: "/tmp/project",
      ephemeral: false,
      id: "root-thread",
      modelProvider: "openai",
      preview: "",
      sessionId: "session-1",
      projectId: null,
      source: "cli",
      status: { type: "idle" },
      turns: [
        {
          id: "turn-1",
          status: "completed",
          items: [
            {
              agentsStates: {},
              id: "item-1",
              receiverThreadIds: ["child-thread"],
              senderThreadId: "root-thread",
              status: "interrupted",
              tool: "followupTask",
              type: "collabAgentToolCall",
            },
          ],
        },
      ],
      updatedAt: 0,
    },
  };

  assert.equal(isThreadResumeResponse(resumeResponse), true);
});

it("accepts Codex rate limit errors for thread responses", () => {
  const failedThread = {
    cliVersion: "0.152.1",
    createdAt: 0,
    cwd: "/tmp/project",
    ephemeral: false,
    id: "thread-1",
    modelProvider: "openai",
    preview: "",
    sessionId: "session-1",
    projectId: null,
    source: "cli",
    status: { type: "idle" },
    turns: [
      {
        error: {
          codexErrorInfo: "rateLimitExceeded",
          message: "Rate limit exceeded",
        },
        id: "turn-1",
        items: [],
        status: "failed",
      },
    ],
    updatedAt: 0,
  };
  assert.equal(isThreadReadResponse({ thread: failedThread }), true);
  assert.equal(
    isThreadResumeResponse({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      cwd: "/tmp/project",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      sandbox: { type: "dangerFullAccess" },
      thread: failedThread,
    }),
    true,
  );
  assert.equal(isThreadRollbackResponse({ thread: failedThread }), true);
});

it("accepts Codex misalignment policy errors for thread responses", () => {
  const failedThread = {
    cliVersion: "0.150.0",
    createdAt: 0,
    cwd: "/tmp/project",
    ephemeral: false,
    id: "thread-1",
    modelProvider: "openai",
    preview: "",
    sessionId: "session-1",
    projectId: null,
    source: "cli",
    status: { type: "idle" },
    turns: [
      {
        error: {
          codexErrorInfo: "misalignmentPolicyViolation",
          message: "Misalignment policy violation",
        },
        id: "turn-1",
        items: [],
        status: "failed",
      },
    ],
    updatedAt: 0,
  };
  const resumeLikeResponse = {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "/tmp/project",
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    sandbox: { type: "dangerFullAccess" },
    thread: failedThread,
  };
  assert.equal(isThreadReadResponse({ thread: failedThread }), true);
  assert.equal(isThreadResumeResponse(resumeLikeResponse), true);
  assert.equal(isThreadRollbackResponse({ thread: failedThread }), true);
  assert.equal(isThreadForkResponse(resumeLikeResponse), true);
  const decodedResume = decodeThreadResumeResponse(resumeLikeResponse);
  assert.equal(decodedResume.thread.turns[0]?.error?.codexErrorInfo, "misalignmentPolicyViolation");
  assert.equal(
    isTurnCompletedNotification({
      threadId: "thread-1",
      turn: {
        error: {
          codexErrorInfo: "misalignmentPolicyViolation",
          message: "Misalignment policy violation",
        },
        id: "turn-1",
        items: [],
        status: "failed",
      },
    }),
    true,
  );
});

it("accepts known and future plan names in every account and rate-limit payload", () => {
  for (const planType of [
    "self_serve_business_prolite",
    "ent26",
    "edu_pro",
    "future_subscription_plan",
  ]) {
    const rateLimits = { primary: null, secondary: null, planType };
    assert.isTrue(
      isGetAccountResponse({
        account: { type: "chatgpt", email: "user@example.com", planType },
        requiresOpenaiAuth: true,
      }),
      planType,
    );
    assert.isTrue(isRateLimitsResponse({ rateLimits }), planType);
    assert.isTrue(isRateLimitsUpdated({ rateLimits }), planType);
    assert.isTrue(isAccountUpdated({ authMode: "chatgpt", planType }), planType);
  }
});

it("still rejects non-string plans and malformed account fields", () => {
  const account = { type: "chatgpt", email: "user@example.com", planType: "plus" };
  const response = (overrides: object) =>
    isGetAccountResponse({ account: { ...account, ...overrides }, requiresOpenaiAuth: true });

  assert.isTrue(response({}));
  assert.isFalse(response({ planType: 5 }));
  assert.isFalse(response({ planType: null }));
  assert.isFalse(response({ email: 5 }));
  assert.isFalse(response({ type: "unknown_account_type" }));
  assert.isFalse(
    isRateLimitsUpdated({ rateLimits: { primary: null, secondary: null, planType: 5 } }),
  );
});

it("preserves elicitation identity and mode-specific fields after schema generation", () => {
  const common = {
    serverName: "test-mcp",
    threadId: "thread-1",
    turnId: null,
    message: "Choose a value",
  };
  for (const fields of [
    { mode: "form", requestedSchema: { type: "object", properties: {}, required: [] } },
    { mode: "openai/form", requestedSchema: { type: "object" } },
    { mode: "openaiForm", requestedSchema: { type: "object" } },
    { mode: "url", url: "https://example.com/authorize", elicitationId: "request-1" },
  ] as const) {
    const request = { ...common, ...fields };
    assert.deepEqual(decodeElicitation(request), request);
    const { serverName: _server, ...withoutServer } = request;
    assert.isFalse(isElicitation(withoutServer));
  }
  assert.isFalse(isElicitation({ ...common, mode: "url" }));
});
