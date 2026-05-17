/**
 * Strip a leading `models/` prefix exactly once. The Gemini SDK sends model
 * names in both forms (`gemini-pro` and `models/gemini-pro`); this helper
 * normalizes to the bare id before handing off to the registry / router.
 */
export function stripModelsPrefix(id: string): string {
  if (id.startsWith("models/")) return id.slice("models/".length);
  return id;
}

/**
 * Parse a Gemini-style URL path segment of the form `[models/]<id>:<method>`,
 * returning the model id (without prefix) and the method name. Returns null on
 * any malformed input — handler treats null as a 404 because the route only
 * matches well-formed `:method` suffixes.
 *
 * The split is on the LAST `:` because Gemini model names are not guaranteed
 * to never contain colons in the future (defensive); method names are always
 * the alphanumeric camelCase trailing token (`generateContent`,
 * `streamGenerateContent`, `countTokens`).
 */
export function parseModelMethodPath(
  segment: string
): { model: string; method: string } | null {
  const lastColon = segment.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const rawModel = segment.slice(0, lastColon);
  const method = segment.slice(lastColon + 1);
  if (method.length === 0) return null;
  const model = stripModelsPrefix(rawModel);
  if (model.length === 0) return null;
  return { model, method };
}
