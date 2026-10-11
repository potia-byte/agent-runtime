export type ProcessOutcomeKind = "quota" | "ordinary";

export interface ProcessOutcomeInput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const QUOTA_PATTERNS: RegExp[] = [
  /rate[\s-]?limit(?:ed|\s+(?:exceeded|reached|hit))/i,
  /(?:hit|reached|exceeded)\s+(?:your\s+)?usage limit/i,
  /usage limit\s+(?:reached|exceeded|exhausted)/i,
  /\bquota\s+(?:exceeded|exhausted|reached)/i,
  /(?:HTTP|status|error)\s*[:=]?\s*429\b/i,
  /(?:API|server|service|model)\s+(?:is\s+)?(?:currently\s+)?overloaded/i,
  /too many requests/i,
  /(?:you(?:'ve| have)?\s+)?hit your limit/i,
  /(?:at|exceeded)\s+(?:its\s+)?capacity/i,
  /limit exhausted/i,
];

/**
 * Heuristic classification only: we deliberately do not try to parse an
 * exact reset time from provider output (it differs per CLI/provider and
 * changes over time). A "quota" verdict just means the run should cool the
 * agent down and be retried later instead of being treated as a normal
 * failure.
 */
export function classifyProcessOutcome(
  input: ProcessOutcomeInput,
): ProcessOutcomeKind {
  if (input.timedOut) return "ordinary";
  // A successful report can discuss quota handling, even quote provider
  // errors. Do not turn that report into a provider outage. Some CLIs emit
  // a standalone limit refusal with exit 0, so recognize that narrow case.
  const haystack = `${input.stdout}\n${input.stderr}`.trim();
  if (input.exitCode === 0) {
    return /^(?:error:\s*)?(?:you(?:'ve| have)? (?:hit|reached) your (?:usage )?limit|quota (?:exceeded|exhausted)|rate limit exceeded)\b[^\r\n]*$/i.test(
      haystack,
    )
      ? "quota"
      : "ordinary";
  }
  return QUOTA_PATTERNS.some((pattern) => pattern.test(haystack))
    ? "quota"
    : "ordinary";
}
