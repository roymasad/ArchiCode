import { describe, expect, it } from "vitest";
import { readableTextForBackground } from "../src/renderer/src/utils/colorContrast";

describe("node color contrast", () => {
  it("uses dark text on light node backgrounds", () => {
    for (const color of ["#7bc6d5", "#8bd39e", "#f0c66b", "#f08a7a", "#b7a7ff", "#f3f6f8", "#58a6ff", "#ff9f43", "#e056a7"]) {
      expect(readableTextForBackground(color)).toBe("#172126");
    }
  });

  it("uses light text on dark node backgrounds", () => {
    for (const color of ["#0f1417", "#19333a", "#342817"]) {
      expect(readableTextForBackground(color)).toBe("#edf3f5");
    }
  });
});
