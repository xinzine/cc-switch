import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Gauge, Loader2, X, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { BatchProgress } from "@/hooks/useModelProbe";

interface BatchProbeToolbarProps {
  /** 可测的供应商数量（已排除官方账号类） */
  candidateCount: number;
  progress: BatchProgress | null;
  onStart: () => void;
  onStartFetch: () => void;
  onCancel: () => void;
}

/**
 * 批量模型测试工具栏。
 *
 * 与「批量连通检查」的关键区别：这里每个供应商都会发一次**真实的**模型请求，
 * 会消耗额度。因此启动前必须让用户确认，且把请求次数说清楚。
 */
export function BatchProbeToolbar({
  candidateCount,
  progress,
  onStart,
  onStartFetch,
  onCancel,
}: BatchProbeToolbarProps) {
  const { t } = useTranslation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmFetchOpen, setConfirmFetchOpen] = useState(false);
  const isRunning = progress !== null;
  const isProbeRunning = progress?.kind === "probe";
  const isFetchRunning = progress?.kind === "fetch";

  if (candidateCount === 0) return null;

  return (
    <>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setConfirmOpen(true)}
          disabled={isRunning}
        >
          {isProbeRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Gauge className="h-3.5 w-3.5" />
          )}
          {isProbeRunning
            ? t("modelProbe.batchRunning", {
                total: progress.total,
                defaultValue: `测试中… (${progress.total})`,
              })
            : t("modelProbe.batchStart", {
                count: candidateCount,
                defaultValue: `批量测试模型 (${candidateCount})`,
              })}
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setConfirmFetchOpen(true)}
          disabled={isRunning}
        >
          {isFetchRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {isFetchRunning
            ? t("modelProbe.batchFetchRunning", {
                total: progress.total,
                defaultValue: `获取中… (${progress.total})`,
              })
            : t("modelProbe.batchFetchStart", {
                count: candidateCount,
                defaultValue: `批量获取模型 (${candidateCount})`,
              })}
        </Button>

        {isRunning && (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground"
            onClick={onCancel}
          >
            <X className="h-3.5 w-3.5" />
            {t("common.cancel", { defaultValue: "取消" })}
          </Button>
        )}
      </div>

      <ConfirmDialog
        isOpen={confirmOpen}
        title={t("modelProbe.batchConfirmTitle", {
          defaultValue: "批量测试模型",
        })}
        message={t("modelProbe.batchConfirmMessage", {
          count: candidateCount,
          defaultValue: `将对 ${candidateCount} 个供应商各发一次真实的模型请求，用于测量首字延迟与总耗时。这会消耗少量额度。未配置模型的供应商会被跳过。`,
        })}
        confirmText={t("modelProbe.batchConfirmOk", {
          defaultValue: "开始测试",
        })}
        onConfirm={() => {
          setConfirmOpen(false);
          onStart();
        }}
        onCancel={() => setConfirmOpen(false)}
      />

      <ConfirmDialog
        isOpen={confirmFetchOpen}
        title={t("modelProbe.batchFetchConfirmTitle", {
          defaultValue: "批量获取模型",
        })}
        message={t("modelProbe.batchFetchConfirmMessage", {
          count: candidateCount,
          defaultValue: `将对 ${candidateCount} 个供应商调用 /v1/models 接口，拉取可用模型列表。不会消耗额度。`,
        })}
        confirmText={t("modelProbe.batchFetchConfirmOk", {
          defaultValue: "开始获取",
        })}
        onConfirm={() => {
          setConfirmFetchOpen(false);
          onStartFetch();
        }}
        onCancel={() => setConfirmFetchOpen(false)}
      />
    </>
  );
}
