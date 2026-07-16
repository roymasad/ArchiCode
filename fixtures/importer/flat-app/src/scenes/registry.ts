import { createDrawApi } from "../engine/draw";

function scene(id: string, title: string, note: string) {
  return { id, title, note, draw: createDrawApi };
}

export const scenes = [
  scene("alpha", "Alpha Beams", "Radial alpha beam geometry with density controls."),
  scene("cyber", "Cyber Storm", "Tunnel and storm forms from the classic selector."),
  scene("delta", "Delta Waves", "Rotating triangular forms and mirrored fields."),
  scene("omega", "Omega Drift", "Slow drifting particle field with orbit trails.")
];
