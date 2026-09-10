import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Wrench,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ChatMessage } from "./useAiChat";

/** 一条消息。用户 / 助手是气泡，工具执行是可折叠的紧凑行。 */
export function ChatMessageItem({ message }: { message: ChatMessage }) {
  if (message.role === "tool") return <ToolResultRow message={message} />;

  const isUser = message.role === "user";
  return (
    <div className={cn("group flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "relative max-w-[85%] whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-sm",
          isUser
            ? "bg-primary text-primary-foreground"
            : "border border-border/60 bg-card",
        )}
      >
        <div
          className={cn(
            (message.content ||
              message.images?.length ||
              (message.toolCalls && message.toolCalls.length > 0)) &&
              "pr-6",
          )}
        >
          {message.images && message.images.length > 0 && (
            <div
              className={cn(
                "flex flex-wrap gap-1.5",
                message.content ? "mb-2" : "",
              )}
            >
              {message.images.map((img, i) => (
                <img
                  key={`${img.name}-${i}`}
                  src={img.dataUrl}
                  alt={img.name}
                  title={img.name}
                  className="h-20 w-20 rounded-md border border-border/40 object-cover"
                />
              ))}
            </div>
          )}
          {message.content}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {message.toolCalls.map((call) => (
                <span
                  key={call.id}
                  className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                >
                  <Wrench className="h-3 w-3" />
                  {call.name}
                </span>
              ))}
            </div>
          )}
        </div>
        {message.content && <CopyButton text={message.content} />}
      </div>
    </div>
  );
}

/** 气泡右上角的复制按钮：hover 显示，点击把文本写入剪贴板。 */
function CopyButton({ text, className }: { text: string; className?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  if (!text) return null;

  const handleCopy = async () => {
    try {
      await copyText(text);
      setCopied(true);
      toast.success(t("aiChat.copied", { defaultValue: "已复制" }));
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("aiChat.copyFailed", { defaultValue: "复制失败" }));
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={t("aiChat.copyMessage", { defaultValue: "复制内容" })}
          className={cn(
            "absolute right-1.5 top-1.5 rounded-md p-1 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/10 dark:hover:bg-white/10",
            className,
          )}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {copied
          ? t("aiChat.copied", { defaultValue: "已复制" })
          : t("aiChat.copyMessage", { defaultValue: "复制内容" })}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * 工具执行结果。默认折叠——原始 JSON 对用户没什么价值，但出问题时能展开看。
 */
function ToolResultRow({ message }: { message: ChatMessage }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const failed = message.toolOk === false;

  return (
    <div className="group text-xs">
      <div className="inline-flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          {failed ? (
            <XCircle className="h-3 w-3" />
          ) : (
            <Wrench className="h-3 w-3" />
          )}
          <span className="font-mono">{message.toolName}</span>
          <span>
            {failed
              ? t("aiChat.toolFailed", { defaultValue: "执行失败" })
              : t("aiChat.toolDone", { defaultValue: "已执行" })}
          </span>
        </button>
        {open && (
          <div className="relative max-h-48 overflow-auto rounded-md bg-muted/60">
            <pre className="p-2 pr-8 font-mono text-[11px] leading-relaxed">
              {message.content}
            </pre>
            <CopyButton
              text={message.content}
              className="right-1 top-1 opacity-100 hover:opacity-100"
            />
          </div>
        )}
      </div>
    </div>
  );
}