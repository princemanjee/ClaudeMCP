import type { BackendId } from "./backends/types.js";

export interface IdentifyResult {
  /** null means the registry must look this model up in its discovered map */
  backend: BackendId | null;
  remainingModel: string;
  /** When the prefix-override syntax includes :<instance>, set here */
  instance?: string;
  reason:
    | "prefix-override"
    | "anthropic-id-prefix"
    | "google-id-prefix"
    | "default-backend"
    | "cli-sentinel"
    | "needs-registry-lookup";
}

// Cloud-CLI alias shortcuts. These claim the bare names globally — a user
// running LM Studio with a model literally named "opus" will see it routed
// to Claude. To escape, use the prefix-override syntax (e.g., "lmstudio/opus").
const CLAUDE_ALIASES = new Set(["opus", "sonnet", "haiku"]);
const GEMINI_ALIASES = new Set(["pro", "flash", "flash-lite"]);
const SENTINELS = new Set(["auto", ""]);

function parsePrefix(
  model: string
): { backend: BackendId; instance?: string; remaining: string } | null {
  // Match backend prefix optionally followed by :instance, then /model.
  // Examples: "lmstudio/X", "lmstudio:work/X", "ollama:remote-1/X"
  const m = model.match(
    /^(claude|gemini|lmstudio|ollama)(?::([A-Za-z0-9_-]+))?\/(.+)$/
  );
  if (!m) return null;
  return {
    backend: m[1] as BackendId,
    instance: m[2],
    remaining: m[3] as string
  };
}

export function identifyBackend(
  model: string | undefined,
  defaultBackend: BackendId
): IdentifyResult {
  if (model === "claude-code-cli") {
    return {
      backend: "claude",
      remainingModel: "claude-code-cli",
      reason: "cli-sentinel"
    };
  }
  if (model === "gemini-cli") {
    return {
      backend: "gemini",
      remainingModel: "gemini-cli",
      reason: "cli-sentinel"
    };
  }

  if (model === undefined || SENTINELS.has(model)) {
    return {
      backend: defaultBackend,
      remainingModel: model ?? "",
      reason: "default-backend"
    };
  }

  const prefixed = parsePrefix(model);
  if (prefixed) {
    return {
      backend: prefixed.backend,
      remainingModel: prefixed.remaining,
      ...(prefixed.instance !== undefined && { instance: prefixed.instance }),
      reason: "prefix-override"
    };
  }

  if (model.startsWith("claude-") || CLAUDE_ALIASES.has(model)) {
    return {
      backend: "claude",
      remainingModel: model,
      reason: "anthropic-id-prefix"
    };
  }
  if (model.startsWith("gemini-") || GEMINI_ALIASES.has(model)) {
    return {
      backend: "gemini",
      remainingModel: model,
      reason: "google-id-prefix"
    };
  }

  return {
    backend: null,
    remainingModel: model,
    reason: "needs-registry-lookup"
  };
}
