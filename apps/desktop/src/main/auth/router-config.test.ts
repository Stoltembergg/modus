import { describe, expect, it } from "vitest";
import { modelRouterUrl } from "./router-config";

const PROJECT = "https://crdgtmyvwdnswuggpjco.supabase.co";

describe("modelRouterUrl", () => {
  it("derives the fixed Function URL from the project origin", () => {
    expect(modelRouterUrl(PROJECT, { packaged: true })).toBe(
      `${PROJECT}/functions/v1/model-router`,
    );
    expect(modelRouterUrl(`${PROJECT}/some/path`, { packaged: false })).toBe(
      `${PROJECT}/functions/v1/model-router`,
    );
  });

  it("requires https in packaged builds, even for localhost", () => {
    expect(() => modelRouterUrl("http://127.0.0.1:54321", { packaged: true })).toThrow(/https/);
    expect(() => modelRouterUrl("http://localhost:54321", { packaged: true })).toThrow(/https/);
    expect(() => modelRouterUrl("http://example.com", { packaged: true })).toThrow(/https/);
  });

  it("allows http only for localhost / 127.0.0.1 when not packaged", () => {
    expect(modelRouterUrl("http://127.0.0.1:54321", { packaged: false })).toBe(
      "http://127.0.0.1:54321/functions/v1/model-router",
    );
    expect(modelRouterUrl("http://localhost:54321", { packaged: false })).toBe(
      "http://localhost:54321/functions/v1/model-router",
    );
    expect(() => modelRouterUrl("http://example.com", { packaged: false })).toThrow(/https/);
    expect(() => modelRouterUrl("http://10.0.0.5:54321", { packaged: false })).toThrow(/https/);
  });

  it("rejects credentials, queries, fragments and garbage", () => {
    expect(() => modelRouterUrl("https://u:p@x.supabase.co", { packaged: true })).toThrow();
    expect(() => modelRouterUrl("https://x.supabase.co/?a=1", { packaged: true })).toThrow();
    expect(() => modelRouterUrl("https://x.supabase.co/#a", { packaged: true })).toThrow();
    expect(() => modelRouterUrl("not a url", { packaged: true })).toThrow();
    expect(() => modelRouterUrl("ftp://x.supabase.co", { packaged: false })).toThrow();
  });
});
