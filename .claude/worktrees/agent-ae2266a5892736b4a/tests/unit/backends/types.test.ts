import { describe, expect, it } from "vitest";
import type {
  Backend,
  BackendCapabilities,
  BackendId,
  ModelDescriptor,
  NormalizedContentBlock,
  NormalizedEmbeddingRequest,
  NormalizedEmbeddingResponse,
  NormalizedEvent,
  NormalizedRequest
} from "../../../src/backends/types.js";

describe("backend types", () => {
  it("permits the four expected backend ids", () => {
    const ids: BackendId[] = ["claude", "gemini", "lmstudio", "ollama"];
    expect(ids).toHaveLength(4);
  });

  it("constructs a minimal NormalizedRequest", () => {
    const req: NormalizedRequest = {
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    };
    expect(req.model).toBe("claude-opus-4-7");
  });

  it("constructs all NormalizedEvent variants", () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "x" },
      { kind: "text_delta", index: 0, text: "hello" },
      { kind: "tool_use_start", index: 1, id: "t1", name: "fn" },
      { kind: "tool_use_delta", index: 1, partialJson: "{\"a\":" },
      { kind: "tool_use_stop", index: 1 },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    expect(events).toHaveLength(6);
  });

  it("requires Backend implementations to expose id and capabilitiesFor", () => {
    const fake: Backend = {
      id: "claude",
      capabilitiesFor(): BackendCapabilities {
        return {
          toolUse: true,
          multimodal: false,
          thinking: false,
          cacheControl: "none",
          samplingParams: { temperature: false, topP: false, topK: false },
          stopSequences: "server-side-cut",
          embeddings: false
        };
      },
      async listModels(): Promise<ModelDescriptor[]> {
        return [];
      },
      async *invoke(): AsyncIterable<NormalizedEvent> {
        // pragma: no cover
      },
      async countTokens(): Promise<number> {
        return 0;
      }
    };
    expect(fake.id).toBe("claude");
  });

  it("optional embed() conforms to NormalizedEmbedding types when present", () => {
    const req: NormalizedEmbeddingRequest = { model: "nomic-embed-text", input: ["hello"] };
    const resp: NormalizedEmbeddingResponse = {
      model: "nomic-embed-text",
      embeddings: [[0.1, 0.2, 0.3]]
    };
    expect(req.input).toEqual(["hello"]);
    expect(resp.embeddings[0]).toHaveLength(3);
  });
});

// ---- Compile-time exhaustiveness checks ---------------------------------
// These helpers are intentionally never called. They exist so that if a new
// variant is added to NormalizedEvent or NormalizedContentBlock and the
// switches below aren't updated, TypeScript errors at build time.

function assertNever(x: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(x)}`);
}

function _exhaustNormalizedEvent(event: NormalizedEvent): string {
  switch (event.kind) {
    case "message_start": return event.model;
    case "text_delta": return event.text;
    case "thinking_delta": return event.text;
    case "tool_use_start": return event.name;
    case "tool_use_delta": return event.partialJson;
    case "tool_use_stop": return String(event.index);
    case "message_stop": return event.stopReason;
    default: return assertNever(event);
  }
}

function _exhaustNormalizedContentBlock(block: NormalizedContentBlock): string {
  switch (block.type) {
    case "text": return block.text;
    case "thinking": return block.text;
    case "image": return block.mediaType;
    case "document": return block.mediaType;
    case "tool_use": return block.name;
    case "tool_result": return block.toolUseId;
    default: return assertNever(block);
  }
}

describe("exhaustiveness helpers exist", () => {
  it("the helpers are defined so TypeScript checks discriminated unions", () => {
    expect(typeof _exhaustNormalizedEvent).toBe("function");
    expect(typeof _exhaustNormalizedContentBlock).toBe("function");
  });
});
