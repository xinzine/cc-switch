import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DESTRUCTIVE_TOOLS } from "./tools";
import type { PendingAction } from "./useAiChat";

interface ToolConfirmCardProps {
  action: PendingAction;
  busy: boolean;
  onConfirm: () => void;
  onReject: () => void;
}

/**
 * 写操作确认卡。
 *
 * 助手对站点的增删改一律经过这里——模型误判很常见，让它直接改用户的配置不可接受。
 * 参数以「字段：值」列出，让用户在按下确认前能看清到底要改什么。
 */
export function ToolConfirmCard({
  action,
  busy,
  onConfirm,
  onReject,
}: ToolConfirmCardProps) {
  const { t } = useTranslation();
  const isDestructive = DESTRUCTIVE_TOOLS.has(action.call.name);

  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        isDestructive
          ? "border-destructive/50 bg-destructive/5"
          : "border-amber-500/50 bg-amber-500/5",
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <AlertTriangle
          className={cn(
            "h-4 w-4 shrink-0",
            isDestructive ? "text-destructive" : "text-amber-600",
          )}
        />
        {t(`aiChat.confirm.${action.call.name}`, {
          defaultValue: describeAction(action.call.name),
        })}
      </div>

      <dl className="mt-3 space-y-1 text-xs">
        {Object.entries(action.args).map(([key, value]) => (
          <div key={key} className="flex gap-2">
            <dt className="w-24 shrink-0 text-muted-foreground">{key}</dt>
            <dd className="min-w-0 break-all font-mono">
              {/* apiKey 打码显示：确认卡不需要暴露明文，用户知道「有值」即可。 */}
              {key === "apiKey" ? maskValue(value) : formatValue(value)}
            </dd>
          </div>
        ))}
        {Object.keys(action.args).length === 0 && (
          <div className="text-muted-foreground">
            {t("aiChat.confirm.noArgs", { defaultValue: "（无参数）" })}
          </div>
        )}
      </dl>

      {isDestructive && (
        <p className="mt-3 text-xs text-destructive">
          {t("aiChat.confirm.irreversible", {
            defaultValue: "此操作不可撤销。",
          })}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button
          size="sm"
          variant={isDestructive ? "destructive" : "default"}
          className="gap-1.5"
          onClick={onConfirm}
          disabled={busy}
        >
          <Check className="h-3.5 w-3.5" />
          {t("aiChat.confirm.approve", { defaultValue: "确认执行" })}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={onReject}
          disabled={busy}
        >
          <X className="h-3.5 w-3.5" />
          {t("aiChat.confirm.reject", { defaultValue: "拒绝" })}
        </Button>
      </div>
    </div>
  );
}

function describeAction(name: string): string {
  switch (name) {
    case "createProvider":
      return "助手想新增一个站点，确认吗？";
    case "updateProvider":
      return "助手想修改一个站点，确认吗？";
    case "deleteProvider":
      return "助手想删除一个站点，确认吗？";
    default:
      return `助手想执行 ${name}，确认吗？`;
  }
}

function maskValue(value: unknown): string {
  const s = typeof value === "string" ? value : String(value ?? "");
  if (!s) return "（空）";
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

function formatValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value || "（空）";
  return JSON.stringify(value);
}
