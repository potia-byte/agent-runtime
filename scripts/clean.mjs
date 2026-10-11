import { rmSync } from "node:fs";

rmSync(new URL("../dist", import.meta.url), {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
});
