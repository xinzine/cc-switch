import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { providersApi } from "@/lib/api/providers";
import {
  probeProviderModel,
  probeAllProviderModels,
  fetchModelsForProvider,
} from "@/lib/api/model-probe";
import type { AppId } from "@/lib/api/types";
import type { Provider } from "@/types";
import {
  getProviderModel,
  setProviderModel,
  supportsProviderModel,
} from "@/utils/providerModel";
import { WRITE_TOOLS } from "./tools";

/**
 * 工具执行器。
 *
 * 只读工具走 `executeRead`，新增 / 修改 / 删除走 `executeWrite`。
 * 是否需要确认由调用点的 `REQUIRES_CONFIRMATION` 决定（当前只有删除）；执行器只按
 * [`WRITE_TOOLS`] 校验工具类别，不把“是否写入”和“是否确认”混为一谈。
 */

export interface ToolOutcome {
  ok: boolean;
  /** 回传给模型的结果（会被 JSON 序列化）。 */
  data: unknown;
}

/** API Key 打码：助手不需要看到明文，日志和对话历史里也不该有。 */
function maskKey(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

/** 把 Provider 压成助手够用的摘要，避免整个 settingsConfig 塞满上下文。 */
function summarize(provider: Provider, appId: AppId, isCurrent: boolean) {
  const env = provider.settingsConfig?.env ?? {};
  return {
    id: provider.id,
    name: provider.name,
    baseUrl:
      env.ANTHROPIC_BASE_URL ??
      env.GOOGLE_GEMINI_BASE_URL ??
      provider.websiteUrl ??
      null,
    model: supportsProviderModel(appId)
      ? (getProviderModel(provider, appId) ?? null)
      : null,
    category: provider.category ?? null,
    notes: provider.notes ?? null,
    isCurrent,
  };
}

export function useChatTools(defaultAppId: AppId) {
  const queryClient = useQueryClient();

  const resolveAppId = useCallback(
    (raw: unknown): AppId =>
      typeof raw === "string" ? (raw as AppId) : defaultAppId,
    [defaultAppId],
  );

  /** 执行只读工具。写操作走 `executeWrite`。 */
  const executeRead = useCallback(
    async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<ToolOutcome> => {
      const appId = resolveAppId(args.appId);
      try {
        switch (name) {
          case "listProviders": {
            const [providers, currentId] = await Promise.all([
              providersApi.getAll(appId),
              providersApi.getCurrent(appId).catch(() => ""),
            ]);
            return {
              ok: true,
              data: {
                appId,
                providers: Object.values(providers).map((p) =>
                  summarize(p, appId, p.id === currentId),
                ),
              },
            };
          }
          case "getProvider": {
            const providers = await providersApi.getAll(appId);
            const provider = providers[String(args.id)];
            if (!provider) {
              return { ok: false, data: { error: `站点 ${args.id} 不存在` } };
            }
            const env = provider.settingsConfig?.env ?? {};
            return {
              ok: true,
              data: {
                ...summarize(provider, appId, false),
                // 明文密钥绝不进对话历史。
                apiKeyMasked: maskKey(
                  env.ANTHROPIC_AUTH_TOKEN ??
                    env.ANTHROPIC_API_KEY ??
                    env.GEMINI_API_KEY ??
                    provider.settingsConfig?.auth?.OPENAI_API_KEY,
                ),
              },
            };
          }
          case "fetchModels": {
            const models = await fetchModelsForProvider(appId, String(args.id));
            return {
              ok: true,
              data: { count: models.length, models: models.map((m) => m.id) },
            };
          }
          case "probeModel": {
            const result = await probeProviderModel(
              appId,
              String(args.id),
              typeof args.model === "string" ? args.model : undefined,
            );
            return { ok: result.success, data: result };
          }
          case "probeAllModels": {
            const ids = Array.isArray(args.ids)
              ? args.ids.map(String)
              : undefined;
            const pairs = await probeAllProviderModels(appId, ids);
            return {
              ok: true,
              data: pairs.map(([id, r]) => ({
                id,
                success: r.success,
                model: r.model,
                firstTokenMs: r.firstTokenMs ?? null,
                durationMs: r.durationMs ?? null,
                message: r.message || null,
              })),
            };
          }
          default:
            return { ok: false, data: { error: `未知工具: ${name}` } };
        }
      } catch (e) {
        return { ok: false, data: { error: String(e) } };
      }
    },
    [resolveAppId],
  );

  /**
   * 执行写操作。新增 / 修改可直接调用；删除由 `useAiChat` 的确认卡放行后调用。
   *
   * 用既有的 `providersApi`，与手工在界面上操作走同一条路径，因此同样的校验、
   * 同样的 live 配置写入逻辑都在。
   */
  const executeWrite = useCallback(
    async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<ToolOutcome> => {
      if (!WRITE_TOOLS.has(name)) {
        return { ok: false, data: { error: `${name} 不是写操作` } };
      }
      const appId = resolveAppId(args.appId);
      try {
        switch (name) {
          case "createProvider": {
            const provider = buildNewProvider(args, appId);
            await providersApi.add(provider, appId);
            await queryClient.invalidateQueries({
              queryKey: ["providers", appId],
            });
            return { ok: true, data: { id: provider.id, name: provider.name } };
          }
          case "updateProvider": {
            const providers = await providersApi.getAll(appId);
            const existing = providers[String(args.id)];
            if (!existing) {
              return { ok: false, data: { error: `站点 ${args.id} 不存在` } };
            }
            const updated = applyUpdates(existing, args, appId);
            await providersApi.update(updated, appId);
            await queryClient.invalidateQueries({
              queryKey: ["providers", appId],
            });
            return { ok: true, data: { id: updated.id, name: updated.name } };
          }
          case "deleteProvider": {
            await providersApi.delete(String(args.id), appId);
            await queryClient.invalidateQueries({
              queryKey: ["providers", appId],
            });
            return { ok: true, data: { id: args.id, deleted: true } };
          }
          default:
            return { ok: false, data: { error: `未知工具: ${name}` } };
        }
      } catch (e) {
        return { ok: false, data: { error: String(e) } };
      }
    },
    [queryClient, resolveAppId],
  );

  return { executeRead, executeWrite };
}

/** 按应用的 settingsConfig 约定构造新站点。 */
function buildNewProvider(
  args: Record<string, unknown>,
  appId: AppId,
): Provider {
  const name = String(args.name ?? "").trim();
  const baseUrl = String(args.baseUrl ?? "").trim();
  const apiKey = String(args.apiKey ?? "").trim();
  const model = typeof args.model === "string" ? args.model.trim() : undefined;

  let settingsConfig: Record<string, unknown>;
  if (appId === "codex" || appId === "grokbuild") {
    const lines = [
      model ? `model = "${model}"` : null,
      'model_provider = "custom"',
      "",
      "[model_providers.custom]",
      `name = "${name}"`,
      `base_url = "${baseUrl}"`,
      'wire_api = "chat"',
    ].filter(Boolean);
    settingsConfig = {
      auth: { OPENAI_API_KEY: apiKey },
      config: `${lines.join("\n")}\n`,
    };
  } else if (appId === "gemini") {
    settingsConfig = {
      env: {
        GOOGLE_GEMINI_BASE_URL: baseUrl,
        GEMINI_API_KEY: apiKey,
        ...(model ? { GEMINI_MODEL: model } : {}),
      },
    };
  } else {
    settingsConfig = {
      env: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ...(model ? { ANTHROPIC_MODEL: model } : {}),
      },
    };
  }

  return {
    id: crypto.randomUUID(),
    name,
    settingsConfig,
    category: "custom",
    createdAt: Date.now(),
    ...(typeof args.notes === "string" && args.notes.trim()
      ? { notes: args.notes.trim() }
      : {}),
  };
}

/** 把工具参数里出现的字段应用到已有站点；未出现的字段保持原值。 */
function applyUpdates(
  existing: Provider,
  args: Record<string, unknown>,
  appId: AppId,
): Provider {
  let next: Provider = { ...existing };

  if (typeof args.name === "string" && args.name.trim()) {
    next.name = args.name.trim();
  }
  if (typeof args.notes === "string") {
    next.notes = args.notes.trim() || undefined;
  }
  if (typeof args.model === "string" && supportsProviderModel(appId)) {
    next = setProviderModel(next, appId, args.model);
  }

  const hasBaseUrl = typeof args.baseUrl === "string" && args.baseUrl.trim();
  const hasApiKey = typeof args.apiKey === "string" && args.apiKey.trim();
  if (hasBaseUrl || hasApiKey) {
    const config = { ...(next.settingsConfig ?? {}) };
    if (appId === "codex" || appId === "grokbuild") {
      // Codex 的 baseUrl / key 在 TOML 与 auth 里，改动交给表单更稳妥；
      // 这里只支持改 key，baseUrl 让用户去编辑弹窗改。
      if (hasApiKey) {
        config.auth = {
          ...(config.auth ?? {}),
          OPENAI_API_KEY: String(args.apiKey).trim(),
        };
      }
    } else {
      const env = { ...(config.env ?? {}) };
      if (hasBaseUrl) {
        const key =
          appId === "gemini" ? "GOOGLE_GEMINI_BASE_URL" : "ANTHROPIC_BASE_URL";
        env[key] = String(args.baseUrl).trim();
      }
      if (hasApiKey) {
        const key =
          appId === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_AUTH_TOKEN";
        env[key] = String(args.apiKey).trim();
      }
      config.env = env;
    }
    next.settingsConfig = config;
  }

  return next;
}
