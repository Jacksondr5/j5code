/**
 * Token use per sample. `apiCostUsd` is what Claude Code reports a run would cost at API prices;
 * runs here go through subscriptions, so it measures load, not spend. Codex reports no price.
 */
export type Usage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiCostUsd: number;
};

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  apiCostUsd: 0,
});

/** Adds a Claude SDK result's usage and cost. */
export const addClaudeResult = (
  total: Usage,
  result: {
    readonly total_cost_usd: number;
    readonly usage: {
      readonly input_tokens: number;
      readonly output_tokens: number;
      readonly cache_read_input_tokens?: number | null;
      readonly cache_creation_input_tokens?: number | null;
    };
  },
) => {
  total.inputTokens += result.usage.input_tokens + (result.usage.cache_creation_input_tokens ?? 0);
  total.cachedInputTokens += result.usage.cache_read_input_tokens ?? 0;
  total.outputTokens += result.usage.output_tokens;
  total.apiCostUsd += result.total_cost_usd;
};

/** The shell simulator's use, per sample. */
export const shellUsage = new WeakMap<object, Usage>();
