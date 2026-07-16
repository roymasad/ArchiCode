const readableDarkText = "#172126";
const readableLightText = "#edf3f5";

function hexChannel(hex: string, start: number): number {
  return Number.parseInt(hex.slice(start, start + 2), 16) / 255;
}

function linearChannel(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number | null {
  const normalized = hex.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) return null;
  const red = linearChannel(hexChannel(normalized, 1));
  const green = linearChannel(hexChannel(normalized, 3));
  const blue = linearChannel(hexChannel(normalized, 5));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(firstHex: string, secondHex: string): number {
  const first = relativeLuminance(firstHex) ?? 0;
  const second = relativeLuminance(secondHex) ?? 0;
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

export function isLightHexColor(hex: string): boolean {
  const luminance = relativeLuminance(hex);
  return luminance === null ? false : luminance > 0.42;
}

export function readableTextForBackground(hex: string): string {
  return contrastRatio(hex, readableDarkText) >= contrastRatio(hex, readableLightText)
    ? readableDarkText
    : readableLightText;
}
