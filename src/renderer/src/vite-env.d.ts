/// <reference types="vite/client" />

import type { ArchicodeApi } from "../../preload";

declare global {
  interface Window {
    archicode: ArchicodeApi;
  }
}
