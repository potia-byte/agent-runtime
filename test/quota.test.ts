import { describe, expect, it } from "vitest";
import { classifyProcessOutcome } from "../src/quota.js";

describe("classifyProcessOutcome", () => {
  it("does not mistake implementation reports or test output for provider limits", () => {
    for (const exitCode of [0, 1]) {
      expect(
        classifyProcessOutcome({
          exitCode,
          timedOut: false,
          stderr: "",
          stdout:
            "Updated quota.ts and capacity tests. 429 assertions passed; reset in tests is mocked.",
        }),
      ).toBe("ordinary");
    }
    expect(
      classifyProcessOutcome({
        exitCode: 0,
        timedOut: false,
        stderr: "",
        stdout:
          "Implemented handling for HTTP 429 Too Many Requests.\nAll tests pass.",
      }),
    ).toBe("ordinary");
  });

  it("recognizes a standalone Claude limit refusal even with exit zero", () => {
    expect(
      classifyProcessOutcome({
        exitCode: 0,
        timedOut: false,
        stderr: "",
        stdout: "You've hit your limit · resets 5pm (Europe/Moscow)",
      }),
    ).toBe("quota");
  });

  it("recognizes common rate-limit and quota phrasing", () => {
    const cases = [
      "Error: rate limit exceeded, please retry",
      "You have hit your usage limit for this period",
      "quota exceeded for this account",
      "HTTP 429 Too Many Requests",
      "The API is currently overloaded, try again later",
      "limit exhausted, resets in 3 hours",
    ];
    for (const stdout of cases) {
      expect(
        classifyProcessOutcome({
          exitCode: 1,
          stdout,
          stderr: "",
          timedOut: false,
        }),
      ).toBe("quota");
    }
  });

  it("treats an unrelated failure as an ordinary error", () => {
    expect(
      classifyProcessOutcome({
        exitCode: 1,
        stdout: "",
        stderr: "TypeError: cannot read properties of undefined",
        timedOut: false,
      }),
    ).toBe("ordinary");
  });

  it("treats a timeout as ordinary even if quota wording appears earlier", () => {
    expect(
      classifyProcessOutcome({
        exitCode: null,
        stdout: "rate limit warning logged, continuing",
        stderr: "",
        timedOut: true,
      }),
    ).toBe("ordinary");
  });

  it("treats a clean success as ordinary", () => {
    expect(
      classifyProcessOutcome({
        exitCode: 0,
        stdout: "Completed ADMIN-101.",
        stderr: "",
        timedOut: false,
      }),
    ).toBe("ordinary");
  });
});
