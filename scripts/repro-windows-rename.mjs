// Reproduces the Windows failure mode behind the original flaky test:
// renaming a temp file over a destination that another task is reading
// concurrently. Prints how many of N renames failed and with which code.
// On POSIX the count is expected to be 0. Numbers vary by machine and
// antivirus; nothing here is asserted.
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRITES = Number(process.argv[2] ?? 500);
const dir = await mkdtemp(join(tmpdir(), "rename-race-"));
const target = join(dir, "state.json");
await writeFile(target, "{}");

async function run(withReader) {
  let stop = false;
  const errors = {};
  const reader = (async () => {
    while (withReader && !stop) {
      await readFile(target, "utf8").catch(() => undefined);
    }
  })();
  for (let index = 0; index < WRITES; index += 1) {
    const temporary = `${target}.${index}.tmp`;
    await writeFile(temporary, JSON.stringify({ index }));
    try {
      await rename(temporary, target);
    } catch (error) {
      errors[error.code] = (errors[error.code] ?? 0) + 1;
    }
  }
  stop = true;
  await reader;
  return errors;
}

console.log(`platform=${process.platform} writes=${WRITES}`);
console.log("no concurrent reader:", await run(false));
console.log("concurrent reader   :", await run(true));
await rm(dir, { recursive: true, force: true });
