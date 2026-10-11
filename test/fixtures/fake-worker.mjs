// Stand-in worker CLI used by the durable-worker tests. It logs every
// launch, holds for FAKE_DELAY_MS, writes a file into its own cwd (the
// isolation proof) and answers on stdout.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const input = readFileSync(0, "utf8");
appendFileSync(process.env.FAKE_LOG, `launch ${process.pid}\n`);
await new Promise((resolve) =>
  setTimeout(resolve, Number(process.env.FAKE_DELAY_MS ?? 0)),
);
writeFileSync("worker-output.txt", `written by ${process.pid}`);
process.stdout.write(`worker finished; input=${input}`);
process.exit(Number(process.env.FAKE_EXIT ?? 0));
