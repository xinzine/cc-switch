import { useTranslation } from "react-i18next";
import { Download, Gauge, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModelDropdown } from "@/components/providers/forms/shared/ModelDropdown";
import { formatSeconds } from "@/hooks/useModelProbe";
import type { ModelProbeResult } from "@/lib/api/model-probe";
import type { FetchedModel } from "@/lib/api/model-fetch";
import { cn } from "@/lib/utils";

interface ProviderModelRowProps {
  /** 当前配置的默认模型；未配置时为 undefined */
  model?: string;
  /** 已拉取的模型列表；未拉取过时为 undefined（此时下拉不可用） */
  modelOptions?: FetchedModel[];
  probeResult?: ModelProbeResult;
  isProbing: boolean;
  isFetchingModels: boolean;
  /** 只读供应商（如 Hermes 托管）不允许改模型 */
  readOnly?: boolean;
  onSelectModel: (model: string) => void;
  onFetchModels: () => void;
  onProbe: () => void;
}

/**
 * 卡片上的模型区：当前模型 + 切换下拉 + 获取模型 + 测速 + 上次测试结果。
 *
 * 结果条的数据来自 `useModelProbe` 的内存 state，刷新即丢——这是刻意的，
 * 探测回答的是「此刻能不能用」。
 */
export function ProviderModelRow({
  model,
  modelOptions,
  probeResult,
  isProbing,
  isFetchingModels,
  readOnly = false,
  onSelectModel,
  onFetchModels,
  onProbe,
}: ProviderModelRowProps) {
  const { t } = useTranslation();

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">
        {t("modelProbe.modelLabel", { defaultValue: "模型" })}
      </span>

      <span
        className={cn(
          "max-w-[16rem] truncate rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 font-mono text-xs",
          !model && "italic text-muted-foreground",
        )}
        title={model}
      >
        {model ||
          t("modelProbe.noModelConfigured", { defaultValue: "未配置模型" })}
      </span>

      {/* 模型列表要先拉取才有内容；没拉过就只显示「获取模型」按钮。 */}
      {modelOptions && modelOptions.length > 0 && !readOnly && (
        <ModelDropdown
          models={modelOptions}
          onSelect={onSelectModel}
          disabled={isProbing}
          triggerClassName="h-6 w-6"
        />
      )}

      <Button
        variant="outline"
        size="sm"
        className="h-6 gap-1 px-2 text-xs"
        onClick={onFetchModels}
        disabled={isFetchingModels || readOnly}
        title={t("modelProbe.fetchModels", { defaultValue: "获取模型" })}
      >
        {isFetchingModels ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Download className="h-3 w-3" />
        )}
        {t("modelProbe.fetchModels", { defaultValue: "获取模型" })}
      </Button>

      <Button
        variant="outline"
        size="sm"
        className="h-6 gap-1 px-2 text-xs"
        onClick={onProbe}
        disabled={isProbing || !model}
        title={
          model
            ? t("modelProbe.testTooltip", {
                defaultValue: "发一次真实请求测试模型（会消耗少量额度）",
              })
            : t("modelProbe.noModelConfigured", { defaultValue: "未配置模型" })
        }
      >
        {isProbing ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Gauge className="h-3 w-3" />
        )}
        {t("modelProbe.test", { defaultValue: "测试" })}
      </Button>

      {probeResult && <ProbeResultBadge result={probeResult} />}
    </div>
  );
}

/** 上次测试结果条：成功显示首字 / 总耗时，失败显示原因。 */
function ProbeResultBadge({ result }: { result: ModelProbeResult }) {
  const { t } = useTranslation();

  if (!result.success) {
    return (
      <span
        className="max-w-[20rem] truncate rounded-md border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs text-destructive"
        title={result.message}
      >
        {t("modelProbe.resultFailed", {
          message: result.message,
          defaultValue: `失败：${result.message}`,
        })}
      </span>
    );
  }

  return (
    <span
      className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400"
      title={result.responseText || undefined}
    >
      {t("modelProbe.resultOk", {
        firstToken: formatSeconds(result.firstTokenMs),
        duration: formatSeconds(result.durationMs),
        defaultValue: `通 · 首字 ${formatSeconds(result.firstTokenMs)} 秒 · 总耗时 ${formatSeconds(result.durationMs)} 秒`,
      })}
    </span>
  );
}
