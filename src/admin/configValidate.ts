import { ConfigSchema, type Config } from "../config.js";

/**
 * Validate an in-memory object as a Config (the schema is shared with
 * `loadConfig()`). Throws `ZodError` on failure; callers convert to the
 * Anthropic invalid_request envelope.
 *
 * Plan 11 needs this because `loadConfig()` reads from disk; PUT/PATCH need
 * to validate an in-memory body without round-tripping through the filesystem.
 */
export function parseConfig(raw: unknown): Config {
  return ConfigSchema.parse(raw);
}
