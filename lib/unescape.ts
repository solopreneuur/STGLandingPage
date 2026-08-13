/**
 * Undo double-escaped unicode in model output.
 *
 * The model sometimes emits the two characters `\` + `u2014` inside a JSON
 * string rather than the escape sequence itself. JSON.parse then correctly
 * returns a literal "—", which rendered verbatim in the UI ("promise
 * — it asks you to..."). Parsing was never the problem — the payload is.
 *
 * Decoding at the boundary is the reliable fix; a prompt instruction is not,
 * because it fails open and the damage is user-visible.
 */
export function decodeEscapes(s: string): string {
  if (typeof s !== "string" || !s.includes("\\")) return s;
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/** Apply decodeEscapes to every string in a flat or one-level-nested object. */
export function decodeDeep<T>(value: T): T {
  if (typeof value === "string") return decodeEscapes(value) as unknown as T;
  if (Array.isArray(value)) return value.map(decodeDeep) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = decodeDeep(v);
    return out as T;
  }
  return value;
}
