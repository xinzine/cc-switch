import { useState, useCallback, useRef } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  probeProviderModel,
  probeAllProviderModels,
  fetchModelsForProvider,
  batchFetchModels,
  type ModelProbeResult,
} from "@/lib/api/model-probe";
import type { FetchedModel } from "@/lib/api/model-fetch";
import type { AppId } from "@/lib/api/types";

/**
 * 模型探测状态。
 *
 * 结果只存在内存里（`useState`），**刻意不持久化**：探测回答的是「此刻能不能用」，
 * 存下来只会在下次打开时给出一个过期的判断。刷新即丢是预期行为。
 *
 * 与 `useStreamCheck`（只探 base_url 可达，不消耗额度）的区别：这里每次探测都发
 * 一次真实的流式 chat 请求，**会消耗额度**。因此批量探测要给用户明确的确认。
 */

export interface BatchProgress {
  done: number;
  total: number;
  kind: "probe" | "fetch";
}

export function useModelProbe(appId: AppId) {
  const { t } = useTranslation();
  const [results, setResults] = useState<Map<string, ModelProbeResult>>(
    new Map(),
  );
  const [probingIds, setProbingIds] = useState<Set<string>>(new Set());
  const [fetchingIds, setFetchingIds] = useState<Set<string>>(new Set());
  const [modelOptions, setModelOptions] = useState<Map<string, FetchedModel[]>>(
    new Map(),
  );
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(
    null,
  );
  // 取消标记用 ref 而非 state：批量循环里读的必须是最新值，state 会被闭包捕获成旧值。
  // 两个操作各自持有独立的 ref：若 probeAll / fetchAll 同时运行，其中一个重置为 false
  // 不会影响另一个的取消状态，cancelBatch 则同时置两者为 true。
  const probeCancelledRef = useRef(false);
  const fetchCancelledRef = useRef(false);

  const setResult = useCallback((id: string, result: ModelProbeResult) => {
    setResults((prev) => new Map(prev).set(id, result));
  }, []);

  /** 探测单个供应商。`model` 省略时用该供应商已配置的默认模型。 */
  const probeOne = useCallback(
    async (
      providerId: string,
      providerName: string,
      model?: string,
    ): Promise<ModelProbeResult | null> => {
      setProbingIds((prev) => new Set(prev).add(providerId));
      try {
        const result = await probeProviderModel(appId, providerId, model);
        setResult(providerId, result);

        if (result.success) {
          toast.success(
            t("modelProbe.success", {
              providerName,
              firstToken: formatSeconds(result.firstTokenMs),
              defaultValue: `${providerName} 可用 · 首字 ${formatSeconds(result.firstTokenMs)}`,
            }),
          );
        } else {
          toast.error(
            t("modelProbe.failed", {
              providerName,
              message: result.message,
              defaultValue: `${providerName} 测试失败: ${result.message}`,
            }),
            { duration: 8000, closeButton: true },
          );
        }
        return result;
      } catch (e) {
        const message = String(e);
        // 命令级失败（供应商不存在等）也要落到卡片上，否则用户只看到一个转瞬即逝的 toast。
        const failure: ModelProbeResult = {
          success: false,
          model: model ?? "",
          responseText: "",
          message,
          testedAt: Math.floor(Date.now() / 1000),
        };
        setResult(providerId, failure);
        toast.error(
          t("modelProbe.error", {
            providerName,
            error: message,
            defaultValue: `${providerName} 测试出错: ${message}`,
          }),
        );
        return null;
      } finally {
        setProbingIds((prev) => {
          const next = new Set(prev);
          next.delete(providerId);
          return next;
        });
      }
    },
    [appId, setResult, t],
  );

  /**
   * 批量探测。`providerIds` 省略时测该应用下全部（后端跳过官方账号类）。
   *
   * 后端按并发上限并行并一次性返回全部结果，故进度只有「进行中 → 完成」两态；
   * 这里仍显示 total 让用户知道会打多少次请求。
   */
  const probeAll = useCallback(
    async (providerIds?: string[], totalHint?: number) => {
      probeCancelledRef.current = false;
      const total = totalHint ?? providerIds?.length ?? 0;
      setBatchProgress({ done: 0, total, kind: "probe" });
      setProbingIds(new Set(providerIds ?? []));

      try {
        const pairs = await probeAllProviderModels(appId, providerIds);
        if (probeCancelledRef.current) return;

        setResults((prev) => {
          const next = new Map(prev);
          for (const [id, result] of pairs) next.set(id, result);
          return next;
        });
        setBatchProgress({
          done: pairs.length,
          total: pairs.length,
          kind: "probe",
        });

        const okCount = pairs.filter(([, r]) => r.success).length;
        toast.success(
          t("modelProbe.batchDone", {
            ok: okCount,
            total: pairs.length,
            defaultValue: `批量测试完成：${okCount}/${pairs.length} 可用`,
          }),
        );
      } catch (e) {
        toast.error(
          t("modelProbe.batchError", {
            error: String(e),
            defaultValue: `批量测试失败: ${String(e)}`,
          }),
        );
      } finally {
        setProbingIds(new Set());
        setBatchProgress(null);
      }
    },
    [appId, t],
  );

  /**
   * 取消当前批量操作。
   *
   * 这里只停止结果回填并立即解除 UI 加载状态；已经发出的网络请求无法撤回。
   */
  const cancelBatch = useCallback(() => {
    probeCancelledRef.current = true;
    fetchCancelledRef.current = true;
    setProbingIds(new Set());
    setFetchingIds(new Set());
    setBatchProgress(null);
  }, []);

  /**
   * 批量拉取模型列表。`providerIds` 省略时拉取该应用下全部（后端跳过官方账号类）。
   *
   * 成功的会更新 `modelOptions` 并触发 toast 提示。
   */
  const fetchAll = useCallback(
    async (providerIds?: string[], totalHint?: number) => {
      fetchCancelledRef.current = false;
      const total = totalHint ?? providerIds?.length ?? 0;
      setBatchProgress({ done: 0, total, kind: "fetch" });
      setFetchingIds(new Set(providerIds ?? []));

      try {
        const results = await batchFetchModels(appId, providerIds);
        if (fetchCancelledRef.current) return;

        const successful = results.filter((result) => result.success);
        const okCount = successful.length;
        setModelOptions((prev) => {
          const next = new Map(prev);
          for (const result of successful) {
            next.set(result.providerId, result.models);
          }
          return next;
        });

        setBatchProgress({
          done: results.length,
          total: results.length,
          kind: "fetch",
        });
        toast.success(
          t("modelProbe.batchFetchDone", {
            ok: okCount,
            total: results.length,
            defaultValue: `批量获取完成：${okCount}/${results.length} 成功`,
          }),
        );
      } catch (e) {
        toast.error(
          t("modelProbe.batchFetchError", {
            error: String(e),
            defaultValue: `批量获取失败: ${String(e)}`,
          }),
        );
      } finally {
        setFetchingIds(new Set());
        setBatchProgress(null);
      }
    },
    [appId, t],
  );

  /** 拉取某供应商的可用模型列表，供卡片上的下拉使用。 */
  const fetchModels = useCallback(
    async (
      providerId: string,
      providerName: string,
      modelsUrl?: string,
    ): Promise<FetchedModel[]> => {
      setFetchingIds((prev) => new Set(prev).add(providerId));
      try {
        const models = await fetchModelsForProvider(
          appId,
          providerId,
          modelsUrl,
        );
        setModelOptions((prev) => new Map(prev).set(providerId, models));
        if (models.length === 0) {
          toast.warning(
            t("modelProbe.noModels", {
              providerName,
              defaultValue: `${providerName} 没有返回任何模型`,
            }),
          );
        } else {
          toast.success(
            t("modelProbe.modelsFetched", {
              providerName,
              count: models.length,
              defaultValue: `${providerName} 获取到 ${models.length} 个模型`,
            }),
          );
        }
        return models;
      } catch (e) {
        toast.error(
          t("modelProbe.fetchModelsError", {
            providerName,
            error: String(e),
            defaultValue: `${providerName} 获取模型失败: ${String(e)}`,
          }),
          { duration: 8000, closeButton: true },
        );
        return [];
      } finally {
        setFetchingIds((prev) => {
          const next = new Set(prev);
          next.delete(providerId);
          return next;
        });
      }
    },
    [appId, t],
  );

  const getResult = useCallback(
    (providerId: string) => results.get(providerId),
    [results],
  );
  const getModelOptions = useCallback(
    (providerId: string) => modelOptions.get(providerId),
    [modelOptions],
  );
  const isProbing = useCallback(
    (providerId: string) => probingIds.has(providerId),
    [probingIds],
  );
  const isFetchingModels = useCallback(
    (providerId: string) => fetchingIds.has(providerId),
    [fetchingIds],
  );

  return {
    probeOne,
    probeAll,
    cancelBatch,
    fetchModels,
    fetchAll,
    getResult,
    getModelOptions,
    isProbing,
    isFetchingModels,
    batchProgress,
  };
}

/** 毫秒 → 秒（一位小数）。与图示口径一致：`2.2 秒`。 */
export function formatSeconds(ms?: number): string {
  if (ms == null) return "-";
  return (ms / 1000).toFixed(1);
}
