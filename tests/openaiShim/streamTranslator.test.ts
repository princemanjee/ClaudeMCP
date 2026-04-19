import { describe, test, expect } from "vitest";
import {
  translateStream,
  translateBuffered,
} from "../../src/openaiShim/streamTranslator.js";
import type {
  OpenAIChatCompletionChunk,
  StreamJsonEvent,
} from "../../src/openaiShim/types.js";

async function* fromArray<T>(arr: T[]): AsyncGenerator<T> {
  for (const x of arr) yield x;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

function textEvent(text: string): StreamJsonEvent {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  };
}

const INIT: StreamJsonEvent = {
  type: "system",
  subtype: "init",
  session_id: "s-1",
};
const RESULT: StreamJsonEvent = { type: "result", subtype: "success" };

describe("translateStream (answer mode)", () => {
  test("emits role chunk, content chunks, and stop chunk for plain text", async () => {
    const events: StreamJsonEvent[] = [
      INIT,
      textEvent("Hello world and a bit more text to pass the threshold."),
      RESULT,
    ];
    const chunks: OpenAIChatCompletionChunk[] = await collect(
      translateStream(fromArray(events), { id: "x", model: "claude", created: 1 }),
    );
    expect(chunks[0]?.choices[0]?.delta.role).toBe("assistant");
    const combined = chunks
      .map((c) => c.choices[0]?.delta.content ?? "")
      .join("");
    expect(combined).toContain("Hello world");
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
  });

  test("classification threshold: short ambiguous first event waits for more", async () => {
    const events: StreamJsonEvent[] = [
      INIT,
      textEvent("<"),
      textEvent(" normal text"),
      RESULT,
    ];
    const chunks = await collect(
      translateStream(fromArray(events), { id: "x", model: "claude", created: 1 }),
    );
    const combined = chunks
      .map((c) => c.choices[0]?.delta.content ?? "")
      .join("");
    expect(combined).toContain("<");
    expect(combined).toContain("normal text");
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
  });
});

describe("translateStream (tool mode)", () => {
  test("emits a tool_calls chunk when Claude outputs <tool_use>", async () => {
    const events: StreamJsonEvent[] = [
      INIT,
      textEvent('<tool_use>{"name":"search","arguments":{"q":"x"}}</tool_use>'),
      RESULT,
    ];
    const chunks = await collect(
      translateStream(fromArray(events), { id: "x", model: "claude", created: 1 }),
    );
    const toolChunk = chunks.find((c) =>
      c.choices[0]?.delta.tool_calls !== undefined,
    );
    expect(toolChunk).toBeDefined();
    expect(toolChunk?.choices[0]?.delta.tool_calls?.[0]?.function?.name).toBe(
      "search",
    );
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls");
  });

  test("emits multiple tool_calls entries for parallel blocks", async () => {
    const events: StreamJsonEvent[] = [
      INIT,
      textEvent(
        '<tool_use>{"name":"a","arguments":{}}</tool_use><tool_use>{"name":"b","arguments":{}}</tool_use>',
      ),
      RESULT,
    ];
    const chunks = await collect(
      translateStream(fromArray(events), { id: "x", model: "claude", created: 1 }),
    );
    const toolDeltas = chunks.flatMap(
      (c) => c.choices[0]?.delta.tool_calls ?? [],
    );
    expect(toolDeltas.length).toBe(2);
    expect(toolDeltas[0]?.function?.name).toBe("a");
    expect(toolDeltas[1]?.function?.name).toBe("b");
    expect(toolDeltas[0]?.index).toBe(0);
    expect(toolDeltas[1]?.index).toBe(1);
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls");
  });

  test("tool_use split across multiple events still parses", async () => {
    const events: StreamJsonEvent[] = [
      INIT,
      textEvent('<tool_use>{"nam'),
      textEvent('e":"search","arguments":{}}</tool_use>'),
      RESULT,
    ];
    const chunks = await collect(
      translateStream(fromArray(events), { id: "x", model: "claude", created: 1 }),
    );
    const toolDelta = chunks
      .flatMap((c) => c.choices[0]?.delta.tool_calls ?? [])
      [0];
    expect(toolDelta?.function?.name).toBe("search");
  });
});

describe("translateBuffered", () => {
  test("buffered text returns a content response", async () => {
    const events: StreamJsonEvent[] = [
      INIT,
      textEvent("just the final answer, nothing else"),
      RESULT,
    ];
    const { body, sessionId } = await translateBuffered(fromArray(events), {
      id: "resp-1",
      model: "claude",
      created: 1,
    });
    expect(sessionId).toBe("s-1");
    expect(body.choices[0]?.message.content).toContain("final answer");
    expect(body.choices[0]?.finish_reason).toBe("stop");
  });

  test("buffered tool_calls returns a tool_calls response", async () => {
    const events: StreamJsonEvent[] = [
      INIT,
      textEvent(
        '<tool_use>{"name":"search","arguments":{"q":"x"}}</tool_use>',
      ),
      RESULT,
    ];
    const { body } = await translateBuffered(fromArray(events), {
      id: "resp-1",
      model: "claude",
      created: 1,
    });
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");
    expect(body.choices[0]?.message.tool_calls?.length).toBe(1);
    expect(body.choices[0]?.message.tool_calls?.[0]?.function.name).toBe(
      "search",
    );
  });
});
