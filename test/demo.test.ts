import { afterEach, describe, expect, it } from "vitest";
import { startDemo } from "../demo/demo.js";

let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stop?.();
  stop = undefined;
});

describe("demo fixture", () => {
  it("shows every liveness verdict and a quota-paused provider", async () => {
    const demo = await startDemo(0);
    stop = demo.stop;

    const workers = (await (
      await fetch(`${demo.url}/api/workers`)
    ).json()) as Array<{ slot_id: string; liveness: string }>;
    expect(workers.map((worker) => [worker.slot_id, worker.liveness])).toEqual([
      ["A", "alive"],
      ["B", "hung"],
      ["C", "dead"],
      ["D", "finished"],
    ]);

    const providers = (await (
      await fetch(`${demo.url}/api/providers`)
    ).json()) as Array<{ name: string; status: string }>;
    const status = (name: string) =>
      providers.find((provider) => provider.name === name)?.status;
    expect(status("worker-a")).toBe("BUSY");
    expect(status("worker-b")).toBe("QUOTA_LIMITED");
    expect(status("worker-d")).toBe("UNAVAILABLE");

    const snapshot = (await (
      await fetch(`${demo.url}/api/status`)
    ).json()) as { runtime_status: string; worker_count: number };
    expect(snapshot).toMatchObject({
      runtime_status: "RUNNING",
      worker_count: 4,
    });
  });
});
