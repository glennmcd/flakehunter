/** A positive integer id from a URL segment; undefined for anything else ("0", "-1", "1e3", "12abc", ""). */
export function parseId(segment: string): number | undefined {
  if (!/^[1-9]\d{0,14}$/.test(segment)) return undefined;
  return Number(segment);
}
