import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it } from "vitest";
import { clearRun, registerMcpCitations, resolveMcpCitation } from "./mcp-citation-registry";

function result(content: unknown[], overrides: Record<string, unknown> = {}): CallToolResult {
  return { content, ...overrides } as CallToolResult;
}

const owner = { sessionId: "session-a", runId: "run-a" };

describe("main MCP citation registry", () => {
  beforeEach(() => clearRun(owner.sessionId, owner.runId));

  it("extracts resource links and embedded resource URIs as metadata-only citations", () => {
    const citations = registerMcpCitations(
      owner.sessionId,
      owner.runId,
      "Docs server",
      "search",
      result([
        {
          type: "resource_link",
          uri: "https://docs.example.test/guide#overview",
          name: "Guide resource",
          title: "Guide title",
          _meta: { private: "do not copy" },
        },
        {
          type: "resource",
          resource: {
            uri: "https://docs.example.test/reference",
            name: "Reference resource",
            title: "Reference title",
            text: "private response body",
            _meta: { private: "do not copy" },
          },
        },
        { type: "text", text: "https://prose.example.test/not-a-citation" },
      ]),
    );

    expect(citations).toHaveLength(2);
    expect(citations[0]).toMatchObject({
      sessionId: owner.sessionId,
      runId: owner.runId,
      serverName: "Docs server",
      toolName: "search",
      url: "https://docs.example.test/guide",
      title: "Guide title",
    });
    expect(citations[1]).toMatchObject({
      url: "https://docs.example.test/reference",
      title: "Reference title",
    });
    expect(citations[0]?.id).toBeTruthy();
    expect(citations[0]?.retrievedAt).toBeTruthy();
    expect(JSON.stringify(citations)).not.toContain("private response body");
    expect(JSON.stringify(citations)).not.toContain("do not copy");
  });

  it("extracts candidates only from successful results", () => {
    const failed = registerMcpCitations(
      owner.sessionId,
      owner.runId,
      "server",
      "tool",
      result([{ type: "resource_link", uri: "https://failed.example.test", name: "failed" }], {
        isError: true,
      }),
    );
    const successful = registerMcpCitations(
      owner.sessionId,
      owner.runId,
      "server",
      "tool",
      result([{ type: "resource_link", uri: "https://success.example.test", name: "success" }]),
    );

    expect(failed).toEqual([]);
    expect(successful).toHaveLength(1);
  });

  it("does not mine prose or generic structured content for URLs", () => {
    const citations = registerMcpCitations(
      owner.sessionId,
      owner.runId,
      "server",
      "tool",
      result(
        [
          {
            type: "text",
            text: 'Visit https://prose.example.test or {"uri":"https://json.example.test"}',
          },
        ],
        { structuredContent: { url: "https://structured.example.test" } },
      ),
    );

    expect(citations).toEqual([]);
  });

  it.each([
    "not a url",
    "/relative/path",
    "file:///tmp/file.txt",
    "javascript:alert(1)",
    "https://user:password@example.test/private",
    "https://example.test/private?access_token=secret",
    "https://example.test/private?api_key=secret",
    `https://example.test/${"a".repeat(2048)}`,
  ])("rejects unsafe resource URL %s", (uri) => {
    const citations = registerMcpCitations(
      owner.sessionId,
      owner.runId,
      "server",
      "tool",
      result([{ type: "resource_link", uri, name: "candidate" }]),
    );

    expect(citations).toEqual([]);
  });

  it.each([
    "sessionId",
    "SESSION_ID",
    "session_id",
    "refreshToken",
    "REFRESH_TOKEN",
    "refresh_token",
  ])("rejects resource URLs with credential-like query key %s", (queryKey) => {
    const citations = registerMcpCitations(
      owner.sessionId,
      owner.runId,
      "server",
      "tool",
      result([{ type: "resource_link", uri: `https://example.test/private?${queryKey}=secret` }]),
    );
    expect(citations).toEqual([]);
  });

  it("deduplicates canonical URLs per run and removes fragments", () => {
    const first = registerMcpCitations(
      owner.sessionId,
      owner.runId,
      "server",
      "tool",
      result([
        { type: "resource_link", uri: "https://EXAMPLE.test:443/a#first", name: "first" },
        { type: "resource_link", uri: "https://example.test/a#second", name: "second" },
      ]),
    );
    const duplicate = registerMcpCitations(
      owner.sessionId,
      owner.runId,
      "another server",
      "another tool",
      result([{ type: "resource_link", uri: "https://example.test/a#third", name: "third" }]),
    );

    expect(first.map(({ url }) => url)).toEqual(["https://example.test/a"]);
    expect(duplicate).toEqual(first);
    expect(first[0]?.url).toBe("https://example.test/a");
    expect(first[0]?.serverName).toBe("server");
  });

  it("caps citations at ten per result and twenty per run", () => {
    const makeLinks = (start: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        type: "resource_link",
        uri: `https://resource-${start + index}.example.test/item`,
        name: `Resource ${start + index}`,
      }));
    const first = registerMcpCitations(
      owner.sessionId,
      owner.runId,
      "server",
      "tool",
      result(makeLinks(0, 15)),
    );
    const second = registerMcpCitations(
      owner.sessionId,
      owner.runId,
      "server",
      "tool",
      result(makeLinks(15, 15)),
    );

    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    expect(
      second.filter((citation) => resolveMcpCitation(owner.sessionId, owner.runId, citation.id)),
    ).toHaveLength(10);
    expect(
      registerMcpCitations(
        owner.sessionId,
        owner.runId,
        "server",
        "tool",
        result(makeLinks(30, 10)),
      ),
    ).toEqual([]);
  });

  it("bounds untrusted title and main-supplied server/tool display names", () => {
    const citation = registerMcpCitations(
      owner.sessionId,
      owner.runId,
      "s".repeat(300),
      "t".repeat(300),
      result([
        {
          type: "resource_link",
          uri: "https://bounded.example.test",
          title: "x".repeat(500),
          name: "fallback name",
        },
      ]),
    )[0];

    expect(citation?.serverName.length).toBeLessThanOrEqual(128);
    expect(citation?.toolName.length).toBeLessThanOrEqual(128);
    expect(citation?.title?.length).toBeLessThanOrEqual(256);
  });

  it("resolves only exact session/run/id tuples and expires all run IDs", () => {
    const citation = registerMcpCitations(
      owner.sessionId,
      owner.runId,
      "server",
      "tool",
      result([{ type: "resource_link", uri: "https://owned.example.test", name: "owned" }]),
    )[0];
    if (!citation) throw new Error("Expected a citation.");

    expect(resolveMcpCitation(owner.sessionId, owner.runId, citation.id)).toEqual(citation);
    expect(resolveMcpCitation("forged-session", owner.runId, citation.id)).toBeUndefined();
    expect(resolveMcpCitation(owner.sessionId, "forged-run", citation.id)).toBeUndefined();
    expect(resolveMcpCitation(owner.sessionId, owner.runId, "forged-id")).toBeUndefined();

    clearRun(owner.sessionId, owner.runId);
    clearRun(owner.sessionId, owner.runId);
    expect(resolveMcpCitation(owner.sessionId, owner.runId, citation.id)).toBeUndefined();
  });
});
