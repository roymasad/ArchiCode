import { defineConfig, loadEnv } from "vite";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  // Vite returns env-file values without exposing them to client code. Copy
  // only missing values into this explicit test process so shell-provided
  // overrides continue to win.
  const liveEnv = loadEnv(mode, process.cwd(), "");
  for (const [name, value] of Object.entries(liveEnv)) {
    if (process.env[name] === undefined) process.env[name] = value;
  }

  return {
    resolve: {
      alias: {
        "@renderer": resolve(__dirname, "src/renderer/src"),
        "@shared": resolve(__dirname, "src/shared")
      }
    },
    test: {
      // The .live.ts suffix is intentionally outside Vitest's default
      // *.test.* / *.spec.* discovery. This config is the only entrypoint.
      include: ["tests/live/**/*.live.ts"],
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
      retry: 0,
      testTimeout: 90_000,
      hookTimeout: 90_000
    }
  };
});
