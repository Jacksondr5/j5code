#!/usr/bin/env node
// Migrates recorded Codex app-server replay transcripts (codex_transcript.ndjson)
// to the Codex 0.152.1 wire shape J5 generates its protocol schema from.
//
// Rules were derived by structurally diffing every fixture at the previous pin
// (62aef8587c) against the J5 fork head (8f56083a0f); applying this script to
// the pin's fixtures reproduces the fork head's fixtures byte for byte.
//
//   1. transcript_start.version, thread.cliVersion and the version inside the
//      initialize result's userAgent (`<client>/<version>`) become 0.152.1.
//   2. Every `thread` object in a response result or notification params gains
//      `sessionId` (= thread id) and `projectId: null` when absent.
//   3. item/started params gain `startedAtMs`, item/completed params gain
//      `completedAtMs`, and command/file-change approval requests gain
//      `startedAtMs`, each the constant 1756771200000 when absent.
//   4. item/tool/requestUserInput params gain `isBlocking: true` when absent.
//   5. remoteControl/status/changed params gain `installationId` /
//      `serverName` placeholders when absent.
// Missing keys are appended; nothing else in a line is changed.
//
// Usage: node migrate-codex-fixtures.mjs <file.ndjson>...   (rewrites in place)
import fs from "node:fs";

const VERSION = "0.152.1";
const FIXED_MS = 1756771200000;

const addMissing = (obj, key, value) => {
  if (obj && typeof obj === "object" && !(key in obj)) obj[key] = value;
};

const migrateThread = (thread) => {
  if (!thread || typeof thread !== "object") return;
  if (typeof thread.cliVersion === "string") thread.cliVersion = VERSION;
  addMissing(thread, "sessionId", thread.id);
  addMissing(thread, "projectId", null);
};

export const migrateLine = (line) => {
  if (line.trim() === "") return line;
  const entry = JSON.parse(line);
  if (entry.type === "transcript_start" && typeof entry.version === "string") {
    entry.version = VERSION;
  }
  const frame = entry.frame;
  if (frame && typeof frame === "object") {
    const result = frame.result;
    if (result && typeof result === "object") {
      if (typeof result.userAgent === "string") {
        result.userAgent = result.userAgent.replace(/^([^/\s]+)\/[^\s]+/, `$1/${VERSION}`);
      }
      migrateThread(result.thread);
    }
    const params = frame.params;
    if (entry.type === "emit_inbound" && params && typeof params === "object") {
      migrateThread(params.thread);
      switch (frame.method) {
        case "item/started":
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval":
          addMissing(params, "startedAtMs", FIXED_MS);
          break;
        case "item/completed":
          addMissing(params, "completedAtMs", FIXED_MS);
          break;
        case "item/tool/requestUserInput":
          addMissing(params, "isBlocking", true);
          break;
        case "remoteControl/status/changed":
          addMissing(params, "installationId", "fixture-installation");
          addMissing(params, "serverName", "fixture-server");
          break;
      }
    }
  }
  return JSON.stringify(entry);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const file of process.argv.slice(2)) {
    const text = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, text.split("\n").map(migrateLine).join("\n"));
  }
}
