// Codex's PreToolUse hook for the eval: forwards the hook input to the runner, which answers with
// simulated output for the sample named by EVAL_HOOK_URL. Without that variable it allows the call.
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const url = process.env.EVAL_HOOK_URL;
if (url) {
  const reply = await fetch(url, { method: "POST", body: Buffer.concat(chunks) });
  process.stdout.write(await reply.text());
}
