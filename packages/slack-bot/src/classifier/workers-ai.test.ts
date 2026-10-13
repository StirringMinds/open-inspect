import { describe, expect, it, vi } from "vitest";
import { callWorkersAI, parseJsonObjectFromText } from "./index";

describe("Workers AI classifier transport", () => {
  it("parses OpenAI-shaped binding output", async () => {
    const run = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content:
              '{"targetId":"StirringMinds/agent-command-center","confidence":"high","reasoning":"dashboard","alternatives":[]}',
          },
        },
      ],
    });
    const result = await callWorkersAI(
      { run } as unknown as Ai,
      "cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code",
      "@cf/moonshotai/kimi-k2.7-code",
      "prompt"
    );
    expect(run.mock.calls[0][0]).toBe("@cf/moonshotai/kimi-k2.7-code");
    expect(result.targetId).toBe("StirringMinds/agent-command-center");
    expect(result.confidence).toBe("high");
  });

  it("tolerates fenced JSON in a `response` field", () => {
    expect(parseJsonObjectFromText('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("fails clearly without an AI binding", async () => {
    await expect(callWorkersAI(undefined, "@cf/x", "@cf/x", "p")).rejects.toThrow(/AI binding/);
  });
});
