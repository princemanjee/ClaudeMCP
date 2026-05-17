import { describe, expect, it } from "vitest";
import type {
  Backend,
  BackendCapabilities,
  BackendId,
  ModelDescriptor,
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
