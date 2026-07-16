import type { CSSProperties } from "react";
import type { CanvasBackground } from "@shared/schema";

type CanvasBackgroundTheme = {
  canvas: string;
  grid: string;
};

export type CanvasBackgroundOption = {
  value: CanvasBackground;
  label: string;
  description: string;
  swatch: string;
  light: CanvasBackgroundTheme;
  dark: CanvasBackgroundTheme;
};

export const canvasBackgroundOptions: CanvasBackgroundOption[] = [
  {
    value: "neutral-gray",
    label: "Neutral gray",
    description: "Balanced default for both light and dark themes.",
    swatch: "#7a858c",
    light: { canvas: "#edf1f3", grid: "#cbd5da" },
    dark: { canvas: "#0d1215", grid: "#334047" }
  },
  {
    value: "graphite",
    label: "Graphite",
    description: "Quiet, denser gray with stronger contrast.",
    swatch: "#525b63",
    light: { canvas: "#e7ebee", grid: "#bac6cc" },
    dark: { canvas: "#0a0e11", grid: "#303b42" }
  },
  {
    value: "cool-mist",
    label: "Cool mist",
    description: "Soft blue-gray for a lighter planning surface.",
    swatch: "#8aa7b3",
    light: { canvas: "#eef5f7", grid: "#c5d9df" },
    dark: { canvas: "#0c1518", grid: "#314c54" }
  },
  {
    value: "soft-blue",
    label: "Soft blue",
    description: "Subtle blue canvas without turning the app monochrome.",
    swatch: "#7897c7",
    light: { canvas: "#eef3fb", grid: "#c9d7eb" },
    dark: { canvas: "#0b1320", grid: "#30465e" }
  },
  {
    value: "warm-paper",
    label: "Warm paper",
    description: "A warmer surface for notes and product planning.",
    swatch: "#b2a17e",
    light: { canvas: "#f3f0e8", grid: "#d8cfbb" },
    dark: { canvas: "#15120d", grid: "#463e2f" }
  },
  {
    value: "deep-slate",
    label: "Deep slate",
    description: "Darker canvas for focused graph work.",
    swatch: "#33424b",
    light: { canvas: "#e5eaed", grid: "#b5c2c9" },
    dark: { canvas: "#070d11", grid: "#293943" }
  }
];

export function canvasBackgroundStyle(value: CanvasBackground | undefined, theme: "light" | "dark"): CSSProperties {
  const option = canvasBackgroundOptions.find((item) => item.value === value) ?? canvasBackgroundOptions[0];
  const colors = theme === "dark" ? option.dark : option.light;
  return {
    "--canvas": colors.canvas,
    "--flow-grid": colors.grid
  } as CSSProperties;
}
