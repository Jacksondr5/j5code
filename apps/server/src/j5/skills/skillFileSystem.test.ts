// @effect-diagnostics nodeBuiltinImport:off - native async filesystem fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { readSkillsConcurrently, writeSkillStateAtomically } from "./skillFileSystem.ts";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof NodeFSP>()) }));
vi.mock("node:crypto", async (original) => ({ ...(await original<typeof NodeCrypto>()) }));

let root: string;
beforeEach(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "skill-files-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await NodeFSP.rm(root, { recursive: true, force: true });
});

it("limits reads to eight, fills available slots, and returns input order despite reverse completion", async () => {
  const gates = Array.from({ length: 17 }, () => Promise.withResolvers<number>());
  const started = gates.map(() => Promise.withResolvers<void>());
  let active = 0;
  let peak = 0;
  const reading = readSkillsConcurrently(gates, async (gate) => {
    const index = gates.indexOf(gate);
    peak = Math.max(peak, ++active);
    started[index]!.resolve();
    try {
      return await gate.promise;
    } finally {
      active--;
    }
  });
  await Promise.all(started.slice(0, 8).map((entry) => entry.promise));
  expect(active).toBe(8);
  // Free one slot at a time while the first seven reads remain blocked.
  for (let index = 7; index < 16; index++) {
    gates[index]!.resolve(index);
    await started[index + 1]!.promise;
    expect(active).toBe(8);
  }
  for (let index = 16; index >= 0; index--) gates[index]!.resolve(index);
  expect(await reading).toEqual(gates.map((_, index) => index));
  expect(peak).toBe(8);
  expect(active).toBe(0);
});

it("finishes outstanding reads and reports the first input error unchanged", async () => {
  const first = Promise.withResolvers<string>();
  const second = Promise.withResolvers<string>();
  const firstError = new Error("first input");
  const reading = readSkillsConcurrently([first, second], (entry) => entry.promise);
  const rejected = expect(reading).rejects.toBe(firstError);
  second.reject(new Error("second input completed first"));
  first.reject(firstError);
  await rejected;
});

it.each(["write", "rename"])(
  "keeps previous state and cleans temporary files after %s failure, then retries",
  async (phase) => {
    const file = NodePath.join(root, "state.json");
    await writeSkillStateAtomically(file, '{"previous":true}\n');
    if (phase === "rename")
      vi.spyOn(NodeFSP, "rename").mockRejectedValueOnce(new Error("disk full"));
    else {
      const open = NodeFSP.open;
      vi.spyOn(NodeFSP, "open").mockImplementationOnce(async (...args) => {
        const handle = await open(...args);
        vi.spyOn(handle, "writeFile").mockRejectedValueOnce(new Error("disk full"));
        return handle;
      });
    }
    await expect(writeSkillStateAtomically(file, '{"next":true}\n')).rejects.toThrow("disk full");
    expect(await NodeFSP.readFile(file, "utf8")).toBe('{"previous":true}\n');
    expect(await NodeFSP.readdir(root)).toEqual(["state.json"]);
    await writeSkillStateAtomically(file, '{"next":true}\n');
    expect(await NodeFSP.readFile(file, "utf8")).toBe('{"next":true}\n');
  },
);

it("uses exclusive temporary files and leaves a colliding foreign file intact", async () => {
  const uuid = "00000000-0000-0000-0000-000000000000";
  vi.spyOn(NodeCrypto, "randomUUID").mockReturnValue(uuid);
  const staging = NodePath.join(root, `.state.json.${uuid}.tmp`);
  await NodeFSP.writeFile(staging, "foreign");
  await expect(
    writeSkillStateAtomically(NodePath.join(root, "state.json"), "new"),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(await NodeFSP.readFile(staging, "utf8")).toBe("foreign");
});

it("uses independent temporary files for simultaneous writes", async () => {
  const file = NodePath.join(root, "state.json");
  const contents = [
    JSON.stringify({ value: "a".repeat(10000) }),
    JSON.stringify({ value: "b".repeat(10000) }),
  ];
  await Promise.all(contents.map((content) => writeSkillStateAtomically(file, content)));
  expect(contents).toContain(await NodeFSP.readFile(file, "utf8"));
  expect(await NodeFSP.readdir(root)).toEqual(["state.json"]);
});
