/**
 * 供应商「默认（兜底）模型」的统一读写。
 *
 * `Provider` 顶层没有 model 字段——模型埋在 `settingsConfig` 里，且每个应用的结构
 * 都不同。此前只有表单层（`forms/hooks/useModelState.ts`、`useCodexConfigState.ts`）
 * 各自处理，卡片层没有读写路径。本模块把分派收敛到一处，供列表页复用。
 *
 * 与后端 `commands/model_probe.rs` 的 `resolve_configured_model` 保持同一口径：
 * 两边读出来必须是同一个模型，否则「卡片显示 A、探测却测了 B」。
 */

import type { AppId } from "@/lib/api/types";
import type { Provider } from "@/types";
import {
  extractCodexModelName,
  setCodexModelName,
} from "@/utils/providerConfigUtils";
import {
  hasClaudeOneMMarker,
  setClaudeOneMMarker,
  stripClaudeOneMMarker,
} from "@/components/providers/forms/hooks/useModelState";

/** 支持在列表页读写默认模型的应用。其余应用的模型语义不是「单个兜底模型」。 */
const MODEL_CAPABLE_APPS: readonly AppId[] = [
  "claude",
  "claude-desktop",
  "codex",
  "gemini",
  "grokbuild",
];

/**
 * 该应用是否支持在列表页读写默认模型。
 *
 * openclaw / opencode / hermes 的 `settingsConfig` 用的是**模型集合**
 * （`models` 数组 / 字典）而非单个默认模型，改动语义与「切换兜底模型」不同，
 * 交由各自的专用面板处理，列表页不显示模型控件。
 */
export function supportsProviderModel(appId: AppId): boolean {
  return MODEL_CAPABLE_APPS.includes(appId);
}

/**
 * 读取供应商当前的默认模型。
 *
 * 返回值已剥离 Claude 的 `[1M]` 长上下文标记——那是 cc-switch 的 UI 约定，
 * 不是模型 ID 的一部分，带着它去打 API 会 404。
 */
export function getProviderModel(
  provider: Provider,
  appId: AppId,
): string | undefined {
  const config = provider.settingsConfig;
  if (!config || typeof config !== "object") return undefined;

  let raw: unknown;
  switch (appId) {
    case "claude":
    case "claude-desktop":
      raw = config.env?.ANTHROPIC_MODEL;
      break;
    case "gemini":
      raw = config.env?.GEMINI_MODEL;
      break;
    case "codex":
    case "grokbuild":
      raw = extractCodexModelName(
        typeof config.config === "string" ? config.config : "",
      );
      break;
    default:
      return undefined;
  }

  if (typeof raw !== "string") return undefined;
  const value = stripClaudeOneMMarker(raw).trim();
  return value || undefined;
}

/**
 * 写入供应商的默认模型，返回**新的** Provider 对象（不修改入参）。
 *
 * Claude 的 `[1M]` 标记会被保留：如果原模型开着长上下文，换模型后仍开着——
 * 用户切换的是模型，不是长上下文开关。
 *
 * 传空字符串表示清除模型（Codex 会删掉 `model` 行以回退到内置默认）。
 */
export function setProviderModel(
  provider: Provider,
  appId: AppId,
  model: string,
): Provider {
  const trimmed = model.trim();
  const config = provider.settingsConfig ?? {};

  switch (appId) {
    case "claude":
    case "claude-desktop":
    case "gemini": {
      const envKey = appId === "gemini" ? "GEMINI_MODEL" : "ANTHROPIC_MODEL";
      const previous = config.env?.[envKey];
      // 沿用原有的 [1M] 状态（仅 Claude 有此约定）。
      const next =
        appId === "gemini" || !trimmed
          ? trimmed
          : setClaudeOneMMarker(
              trimmed,
              typeof previous === "string" && hasClaudeOneMMarker(previous),
            );
      return {
        ...provider,
        settingsConfig: {
          ...config,
          env: { ...(config.env ?? {}), [envKey]: next },
        },
      };
    }
    case "codex":
    case "grokbuild": {
      const tomlText = typeof config.config === "string" ? config.config : "";
      return {
        ...provider,
        settingsConfig: {
          ...config,
          config: setCodexModelName(tomlText, trimmed),
        },
      };
    }
    default:
      // 不支持的应用原样返回，避免调用方误以为写入成功。
      return provider;
  }
}

/**
 * 该供应商的上游是否说 Anthropic 协议。
 *
 * 决定取模型列表时优先用哪种鉴权口径（原生 Anthropic 端点不认 Bearer）。
 * `meta.apiFormat` 优先，未标注时按应用默认——与后端 `ApiFormat::resolve` 一致。
 */
export function prefersAnthropicAuth(
  provider: Provider,
  appId: AppId,
): boolean {
  const declared = provider.meta?.apiFormat;
  if (declared) return declared === "anthropic";
  return appId === "claude" || appId === "claude-desktop";
}
