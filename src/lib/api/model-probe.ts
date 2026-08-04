import { invoke } from "@tauri-apps/api/core";
import type { AppId } from "./types";
import type { FetchedModel } from "./model-fetch";

/**
 * 模型可用性探测 API。
 *
 * 与 `connectivity-check.ts`（只探 base_url 可达）不同：这里发**真实的流式 chat
 * 请求**，因此能测出模型是否真的可用、首字延迟与总耗时，代价是消耗少量额度。
 *
 * 结果不落库，前端只放在内存里，刷新即丢。
 */

export interface ModelProbeConfig {
  /** 单次探测超时（秒） */
  timeoutSecs: number;
  /** 生成上限 */
  maxTokens: number;
  /** 探测用提示词 */
  message: string;
  /** 批量探测的最大并发 */
  maxConcurrency: number;
}

export interface ModelProbeResult {
  success: boolean;
  /** 实际探测的模型；未配置模型时为空串 */
  model: string;
  /** 首字延迟（毫秒）：第一个非空文本增量到达的时刻 */
  firstTokenMs?: number;
  /** 总耗时（毫秒）：流结束的时刻 */
  durationMs?: number;
  /** 回复内容（已截断） */
  responseText: string;
  httpStatus?: number;
  /** 失败原因；成功时为空串 */
  message: string;
  testedAt: number;
}

/**
 * 探测单个供应商的模型。
 *
 * `model` 省略时后端读该供应商配置里的默认模型；读不到会回传
 * `success: false`，**不会**自动挑一个模型代测。
 */
export async function probeProviderModel(
  appType: AppId,
  providerId: string,
  model?: string,
): Promise<ModelProbeResult> {
  return invoke("probe_provider_model", { appType, providerId, model });
}

/**
 * 批量探测多个供应商的默认模型。
 *
 * `providerIds` 省略时探测该应用下全部供应商（跳过官方账号类）。
 * 后端按配置的并发上限并行，默认 4。
 */
export async function probeAllProviderModels(
  appType: AppId,
  providerIds?: string[],
): Promise<Array<[string, ModelProbeResult]>> {
  return invoke("probe_all_provider_models", { appType, providerIds });
}

/**
 * 拉取指定供应商的可用模型列表（凭据取自已保存的配置）。
 *
 * `modelsUrl` 可选覆写：部分供应商的 `/models` 端点在前端预设里有精确地址。
 */
export async function fetchModelsForProvider(
  appType: AppId,
  providerId: string,
  modelsUrl?: string,
): Promise<FetchedModel[]> {
  return invoke("fetch_models_for_provider", {
    appType,
    providerId,
    modelsUrl,
  });
}

export async function getModelProbeConfig(): Promise<ModelProbeConfig> {
  return invoke("get_model_probe_config");
}

export async function saveModelProbeConfig(
  config: ModelProbeConfig,
): Promise<void> {
  return invoke("save_model_probe_config", { config });
}

/** 单个供应商的批量获取结果。 */
export interface BatchFetchModelsResult {
  providerId: string;
  success: boolean;
  models: FetchedModel[];
  error?: string;
}

/** 批量拉取多个供应商的模型列表（后端按配置限制并发数）。 */
export async function batchFetchModels(
  appType: AppId,
  providerIds?: string[],
): Promise<BatchFetchModelsResult[]> {
  return invoke("batch_fetch_provider_models", { appType, providerIds });
}
