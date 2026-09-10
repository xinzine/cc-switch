import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Bot,
  ImagePlus,
  Loader2,
  RotateCcw,
  Send,
  Settings,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { getDefaultAiConfig } from "@/lib/api/default-ai";
import type { AppId } from "@/lib/api/types";
import { useAiChat, type ChatImage } from "./useAiChat";
import { ChatMessageItem } from "./ChatMessageItem";
import { ToolConfirmCard } from "./ToolConfirmCard";
import { TooltipProvider } from "@/components/ui/tooltip";

/** 单张图片体积上限。base64 会膨胀约 1/3，5MB 原图约 6.7MB 请求体。 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 一条消息最多带几张图。多了容易超上游的请求体上限。 */
const MAX_IMAGES = 4;

interface AiChatPanelProps {
  /** 当前查看的应用；助手的工具调用省略 appId 时用它。 */
  appId: AppId;
  /** 跳转到设置页配置默认 AI。 */
  onOpenSettings: () => void;
}

/**
 * 站点管理助手。
 *
 * 由「默认 AI」驱动（凭据独立于站点列表存储），通过 function calling 操作站点。
 * 新增 / 修改直接执行；只有不可撤销的删除经 `ToolConfirmCard` 确认。
 */
export function AiChatPanel({ appId, onOpenSettings }: AiChatPanelProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ChatImage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    messages,
    isBusy,
    pending,
    error,
    send,
    confirmPending,
    rejectPending,
    reset,
  } = useAiChat(appId);

  const { data: config, isLoading: configLoading } = useQuery({
    queryKey: ["defaultAiConfig"],
    queryFn: getDefaultAiConfig,
  });
  const isConfigured = Boolean(
    config?.baseUrl?.trim() && config?.apiKey?.trim() && config?.model?.trim(),
  );

  // 新消息滚到底部。
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const handleSubmit = () => {
    const text = draft.trim();
    // 只发图不打字是合理用法（「看这张截图」），故有图时允许空文本。
    if ((!text && images.length === 0) || isBusy || pending) return;
    const attached = images;
    setDraft("");
    setImages([]);
    void send(text, attached.length > 0 ? attached : undefined);
  };

  /** 读入图片文件，转 data URL 存进待发送列表。 */
  const addFiles = async (files: File[]) => {
    const remaining = MAX_IMAGES - images.length;
    if (remaining <= 0) {
      toast.error(
        t("aiChat.imageTooMany", {
          max: MAX_IMAGES,
          defaultValue: `一条消息最多带 ${MAX_IMAGES} 张图`,
        }),
      );
      return;
    }

    const picked: ChatImage[] = [];
    for (const file of files.slice(0, remaining)) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        toast.error(
          t("aiChat.imageTooLarge", {
            name: file.name,
            max: Math.round(MAX_IMAGE_BYTES / 1024 / 1024),
            defaultValue: `${file.name} 超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB，已跳过`,
          }),
        );
        continue;
      }
      try {
        const dataUrl = await readAsDataUrl(file);
        picked.push({ dataUrl, name: file.name });
      } catch {
        toast.error(
          t("aiChat.imageReadFailed", {
            name: file.name,
            defaultValue: `${file.name} 读取失败`,
          }),
        );
      }
    }
    if (picked.length > 0) setImages((prev) => [...prev, ...picked]);
  };

  if (configLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isConfigured) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Bot className="h-10 w-10 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          {t("aiChat.notConfigured", {
            defaultValue: "还没有配置默认 AI，助手无法工作",
          })}
        </p>
        <p className="max-w-md text-xs text-muted-foreground/70">
          {t("aiChat.notConfiguredHint", {
            defaultValue:
              "默认 AI 的凭据独立于站点列表存储，删站点不会影响它。请在设置里填写 Base URL、API Key 和模型。",
          })}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={onOpenSettings}
        >
          <Settings className="h-3.5 w-3.5" />
          {t("aiChat.openSettings", { defaultValue: "去设置" })}
        </Button>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/40 px-6 py-2">
        <span className="text-xs text-muted-foreground">
          {t("aiChat.modelHint", {
            model: config?.model,
            defaultValue: `由 ${config?.model} 驱动`,
          })}
        </span>
        {messages.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs text-muted-foreground"
            onClick={() => {
              reset();
              setImages([]);
            }}
            disabled={isBusy}
          >
            <RotateCcw className="h-3 w-3" />
            {t("aiChat.newChat", { defaultValue: "新对话" })}
          </Button>
        )}
      </div>

      {/* 用原生滚动容器而非 ui/ScrollArea：需要直接持有 viewport ref 才能自动滚到底，
          而 ScrollArea 没有暴露 viewportRef。 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="space-y-3 px-6 py-4">
          {messages.length === 0 && <EmptyHint />}
          {messages.map((message) => (
            <ChatMessageItem key={message.id} message={message} />
          ))}

          {pending && (
            <ToolConfirmCard
              action={pending}
              busy={isBusy}
              onConfirm={() => void confirmPending()}
              onReject={() => void rejectPending()}
            />
          )}

          {isBusy && !pending && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("aiChat.thinking", { defaultValue: "思考中…" })}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border/40 px-6 py-3">
        {/* 待发送图片的缩略图 */}
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((img, i) => (
              <div
                key={`${img.name}-${i}`}
                className="group relative h-16 w-16 overflow-hidden rounded-md border border-border/60"
              >
                <img
                  src={img.dataUrl}
                  alt={img.name}
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  onClick={() =>
                    setImages((prev) => prev.filter((_, idx) => idx !== i))
                  }
                  className="absolute right-0.5 top-0.5 rounded-full bg-background/90 p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label={t("aiChat.imageRemove", {
                    defaultValue: "移除图片",
                  })}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              void addFiles(Array.from(e.target.files ?? []));
              // 清空 value：同一文件连续选两次也要能触发 onChange。
              e.target.value = "";
            }}
          />
          <Button
            variant="outline"
            size="icon"
            onClick={() => fileInputRef.current?.click()}
            disabled={isBusy || Boolean(pending) || images.length >= MAX_IMAGES}
            title={t("aiChat.imageAdd", { defaultValue: "添加图片" })}
          >
            <ImagePlus className="h-4 w-4" />
          </Button>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter 发送，Shift+Enter 换行。
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            onPaste={(e) => {
              // 支持直接粘贴截图。
              const files = Array.from(e.clipboardData.files);
              if (files.length > 0) {
                e.preventDefault();
                void addFiles(files);
              }
            }}
            placeholder={t("aiChat.placeholder", {
              defaultValue: "让助手帮你管理站点，比如「列出所有站点并测速」",
            })}
            className="max-h-48 min-h-[5rem] resize-none"
            rows={3}
            disabled={isBusy || Boolean(pending)}
          />
          <Button
            size="icon"
            onClick={handleSubmit}
            disabled={
              (!draft.trim() && images.length === 0) ||
              isBusy ||
              Boolean(pending)
            }
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        {pending && (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {t("aiChat.pendingHint", {
              defaultValue: "请先确认或拒绝上面的操作",
            })}
          </p>
        )}
      </div>
      </div>
    </TooltipProvider>
  );
}

/** File → `data:<mime>;base64,...`。后端据此转 Anthropic 的 base64 source。 */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function EmptyHint() {
  const { t } = useTranslation();
  const examples = [
    t("aiChat.example1", { defaultValue: "列出我所有的站点" }),
    t("aiChat.example2", { defaultValue: "测试一下哪个站点最快" }),
    t("aiChat.example3", { defaultValue: "帮我看看 xxx 站点有哪些模型" }),
  ];
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <Bot className="h-10 w-10 text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground">
        {t("aiChat.emptyTitle", { defaultValue: "用自然语言管理你的站点" })}
      </p>
      <ul className="space-y-1 text-xs text-muted-foreground/70">
        {examples.map((example) => (
          <li key={example}>「{example}」</li>
        ))}
      </ul>
    </div>
  );
}
