import { describe, it, expect } from "vitest";
import {
  getProviderModel,
  setProviderModel,
  supportsProviderModel,
  prefersAnthropicAuth,
} from "./providerModel";
import { extractCodexModelName } from "./providerConfigUtils";
import type { Provider } from "@/types";

const provider = (settingsConfig: Record<string, unknown>): Provider => ({
  id: "p1",
  name: "test",
  settingsConfig,
});

describe("supportsProviderModel", () => {
  it("covers apps with a single fallback model", () => {
    for (const appId of [
      "claude",
      "claude-desktop",
      "codex",
      "gemini",
      "grokbuild",
    ] as const) {
      expect(supportsProviderModel(appId)).toBe(true);
    }
  });

  it("excludes apps that use model collections", () => {
    // openclaw / opencode / hermes 用的是模型集合，语义不是「单个兜底模型」，
    // 列表页不该显示模型控件。
    for (const appId of ["openclaw", "opencode", "hermes"] as const) {
      expect(supportsProviderModel(appId)).toBe(false);
    }
  });
});

describe("getProviderModel", () => {
  it("reads claude model from env", () => {
    const p = provider({ env: { ANTHROPIC_MODEL: "claude-opus-5" } });
    expect(getProviderModel(p, "claude")).toBe("claude-opus-5");
    expect(getProviderModel(p, "claude-desktop")).toBe("claude-opus-5");
  });

  it("strips the [1M] marker", () => {
    // [1M] 是 cc-switch 的 UI 约定，带着它去打 API 会 404。
    const p = provider({ env: { ANTHROPIC_MODEL: "claude-sonnet-5[1M]" } });
    expect(getProviderModel(p, "claude")).toBe("claude-sonnet-5");
  });

  it("reads gemini model from env", () => {
    const p = provider({ env: { GEMINI_MODEL: "gemini-3.6-flash" } });
    expect(getProviderModel(p, "gemini")).toBe("gemini-3.6-flash");
  });

  it("reads codex model from the top level of the TOML", () => {
    const p = provider({
      auth: { OPENAI_API_KEY: "sk-x" },
      config: 'model = "gpt-5.5"\nmodel_provider = "custom"\n',
    });
    expect(getProviderModel(p, "codex")).toBe("gpt-5.5");
    expect(getProviderModel(p, "grokbuild")).toBe("gpt-5.5");
  });

  it("returns undefined for missing or blank values", () => {
    expect(getProviderModel(provider({ env: {} }), "claude")).toBeUndefined();
    expect(
      getProviderModel(provider({ env: { ANTHROPIC_MODEL: "  " } }), "claude"),
    ).toBeUndefined();
    expect(getProviderModel(provider({}), "codex")).toBeUndefined();
  });

  it("returns undefined for unsupported apps", () => {
    const p = provider({ models: [{ id: "m1" }] });
    expect(getProviderModel(p, "openclaw")).toBeUndefined();
  });
});

describe("setProviderModel", () => {
  it("writes claude model without mutating the input", () => {
    const p = provider({ env: { ANTHROPIC_MODEL: "old" } });
    const next = setProviderModel(p, "claude", "new-model");

    expect(getProviderModel(next, "claude")).toBe("new-model");
    // 入参必须保持不变——调用方可能仍持有 query cache 里的对象。
    expect(getProviderModel(p, "claude")).toBe("old");
    expect(next).not.toBe(p);
  });

  it("preserves the [1M] marker across a model switch", () => {
    // 用户切换的是模型，不是长上下文开关。
    const p = provider({ env: { ANTHROPIC_MODEL: "claude-sonnet-5[1M]" } });
    const next = setProviderModel(p, "claude", "claude-opus-5");
    expect(next.settingsConfig.env.ANTHROPIC_MODEL).toBe("claude-opus-5[1M]");
  });

  it("does not add a [1M] marker when the original had none", () => {
    const p = provider({ env: { ANTHROPIC_MODEL: "claude-sonnet-5" } });
    const next = setProviderModel(p, "claude", "claude-opus-5");
    expect(next.settingsConfig.env.ANTHROPIC_MODEL).toBe("claude-opus-5");
  });

  it("keeps other env keys intact", () => {
    const p = provider({
      env: { ANTHROPIC_BASE_URL: "https://x", ANTHROPIC_MODEL: "old" },
    });
    const next = setProviderModel(p, "claude", "new");
    expect(next.settingsConfig.env.ANTHROPIC_BASE_URL).toBe("https://x");
  });

  it("writes gemini model without a [1M] marker", () => {
    const p = provider({ env: { GEMINI_MODEL: "old" } });
    const next = setProviderModel(p, "gemini", "gemini-3.6-pro");
    expect(next.settingsConfig.env.GEMINI_MODEL).toBe("gemini-3.6-pro");
  });

  it("writes codex model into the TOML", () => {
    const p = provider({
      auth: { OPENAI_API_KEY: "sk-x" },
      config: 'model = "gpt-5.5"\nmodel_provider = "custom"\n',
    });
    const next = setProviderModel(p, "codex", "gpt-5.6");
    expect(extractCodexModelName(next.settingsConfig.config)).toBe("gpt-5.6");
    // auth 不能被顺手改掉。
    expect(next.settingsConfig.auth.OPENAI_API_KEY).toBe("sk-x");
  });

  it("adds a model line to a TOML that lacks one", () => {
    const p = provider({ config: 'model_provider = "custom"\n' });
    const next = setProviderModel(p, "codex", "gpt-5.6");
    expect(extractCodexModelName(next.settingsConfig.config)).toBe("gpt-5.6");
  });

  it("clears the model when given an empty string", () => {
    const p = provider({ config: 'model = "gpt-5.5"\n' });
    const next = setProviderModel(p, "codex", "");
    expect(extractCodexModelName(next.settingsConfig.config)).toBeUndefined();
  });

  it("returns the provider unchanged for unsupported apps", () => {
    const p = provider({ models: [{ id: "m1" }] });
    expect(setProviderModel(p, "openclaw", "m2")).toBe(p);
  });
});

describe("prefersAnthropicAuth", () => {
  it("follows meta.apiFormat when declared", () => {
    // 中转站常把 OpenAI 格式挂在 claude 应用下，此时不该用 x-api-key。
    const p: Provider = {
      ...provider({}),
      meta: { apiFormat: "openai_chat" },
    };
    expect(prefersAnthropicAuth(p, "claude")).toBe(false);

    const anthropic: Provider = {
      ...provider({}),
      meta: { apiFormat: "anthropic" },
    };
    expect(prefersAnthropicAuth(anthropic, "codex")).toBe(true);
  });

  it("falls back to the app default when meta is absent", () => {
    const p = provider({});
    expect(prefersAnthropicAuth(p, "claude")).toBe(true);
    expect(prefersAnthropicAuth(p, "claude-desktop")).toBe(true);
    expect(prefersAnthropicAuth(p, "codex")).toBe(false);
    expect(prefersAnthropicAuth(p, "gemini")).toBe(false);
  });
});
