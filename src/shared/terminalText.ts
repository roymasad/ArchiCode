const ansiEscapePattern = /[\u001b\u009b](?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

export function stripAnsiEscapes(text: string): string {
  return text.replace(ansiEscapePattern, "");
}
