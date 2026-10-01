import { describe, expect, it } from "bun:test";
import { parseId } from "./routeParams";

describe("parseId", () => {
  it("accepts positive integers", () => {
    expect(parseId("3")).toBe(3);
    expect(parseId("12345")).toBe(12345);
  });

  it("rejects everything else", () => {
    for (const bad of ["", "0", "-1", "01", "1.5", "1e3", "12abc", " 3", "99999999999999999999"]) {
      expect(parseId(bad)).toBeUndefined();
    }
  });
});
