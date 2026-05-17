import type { NormalizedRequest } from "./backends/types.js";

/**
 * Char/4 estimate. Plan 05 swaps in `@anthropic-ai/tokenizer` and per-backend
 * dispatch; until then this is the single source of token counts for
 * `/v1/messages/count_tokens` and any internal accounting.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Image blocks contribute a fixed approximation. Anthropic's published
 * formula is roughly `tokens = (w * h) / 750`. With no source-image
 * dimensions in the normalized block today, 258 (≈ a 512x378 image, the
 * upper-bound for Anthropic's "low-detail" tier) is a conservative
 * placeholder — close enough for billing pre-flight on the count_tokens
 * endpoint. Plan 05 plumbs real dimensions through and refines this.
 */
const IMAGE_TOKEN_PLACEHOLDER = 258;

export function estimateRequestTokens(req: NormalizedRequest): number {
  let total = 0;
  if (req.system) total += estimateTokens(req.system);
  for (const msg of req.messages) {
    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          total += estimateTokens(block.text);
          break;
        case "image":
          total += IMAGE_TOKEN_PLACEHOLDER;
          break;
        case "document": {
          // Approximate document blocks by the decoded byte length of the
          // base64 payload; close enough for billing pre-flight.
          const rawBytes = Math.floor((block.data.length * 3) / 4);
          total += estimateTokens(" ".repeat(rawBytes));
          break;
        }
        case "tool_use":
          total += estimateTokens(JSON.stringify(block.input));
          break;
        case "tool_result":
          total += estimateTokens(block.content);
          break;
      }
    }
  }
  return total;
}
