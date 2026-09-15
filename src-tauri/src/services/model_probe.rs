//! 模型可用性探测服务（真实流式请求）
//!
//! 与 [`crate::services::stream_check`] 的分工：
//! - `stream_check` 只 GET `base_url` 探端口可达，**不发真实请求**，不消耗额度，
//!   也无法回答「鉴权对不对、模型存不存在」。
//! - 本服务发一次**真实的流式 chat 请求**，因此能测出：模型是否真的可用、
//!   首字延迟（TTFT）、总耗时。代价是消耗少量额度（`max_tokens` 默认 64）。
//!
//! ## 首字延迟的定义
//!
//! 与项目既有口径一致（见 `proxy/response_processor.rs` 的 `SseUsageCollector`）：
//! 首字 = 收到**第一个携带非空文本增量的 SSE 事件**的时刻，而非 TCP 首字节。
//! 空的 role/ping/前导事件不计入，否则各家网关的前导事件数量差异会让数字不可比。
//!
//! 唯一的例外：整条流**只有**思维链增量、一个文本增量都没有时（开了思维链的模型
//! 遇上 `max_tokens` 上限，token 全花在思考上），退化为用首个思维链增量的时刻。
//! 此时数字与纯文本供应商不严格可比，但比「测不出」有用——模型确实在生成。
//!
//! ## 与故障转移的关系
//!
//! 本探测**绝不**触碰故障转移熔断器。熔断器只由 `proxy/forwarder.rs` 转发真实
//! 业务流量的成败驱动；主动探测的成功不应把一个坏供应商切回线上。

use futures::StreamExt;
use reqwest::header::{HeaderValue, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

use crate::app_config::AppType;
use crate::error::AppError;
use crate::provider::Provider;
use crate::proxy::providers::{get_adapter, ClaudeAdapter, ProviderAdapter};
use crate::proxy::sse::{append_utf8_safe, strip_sse_field, take_sse_block};

/// 错误响应体截断长度：避免把整页 HTML 错误页塞进错误串。
const ERROR_BODY_MAX_CHARS: usize = 512;

/// Anthropic Messages API 版本头，与转发路径口径一致。
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// 上游 API 协议格式。决定请求端点、请求体形状与增量字段的提取路径。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiFormat {
    /// Anthropic Messages API：`POST {base}/v1/messages`
    Anthropic,
    /// OpenAI Chat Completions：`POST {base}/v1/chat/completions`
    OpenAiChat,
    /// OpenAI Responses API：`POST {base}/v1/responses`
    OpenAiResponses,
    /// Gemini Native：`POST {base}/v1beta/models/{model}:streamGenerateContent`
    GeminiNative,
}

impl ApiFormat {
    /// 解析 `meta.apiFormat` 字符串；无法识别时返回 `None` 由调用方回退到 app 默认。
    pub fn from_meta_str(raw: &str) -> Option<Self> {
        match raw.trim() {
            "anthropic" => Some(Self::Anthropic),
            "openai_chat" => Some(Self::OpenAiChat),
            "openai_responses" => Some(Self::OpenAiResponses),
            "gemini_native" => Some(Self::GeminiNative),
            _ => None,
        }
    }

    /// 按应用类型给出默认协议：供应商未显式标注 `meta.apiFormat` 时使用。
    pub fn default_for_app(app_type: &AppType) -> Self {
        match app_type {
            AppType::Claude | AppType::ClaudeDesktop => Self::Anthropic,
            AppType::Gemini => Self::GeminiNative,
            // Codex / GrokBuild / OpenCode / OpenClaw / Hermes 的第三方上游
            // 绝大多数是 OpenAI Chat 兼容端点。
            _ => Self::OpenAiChat,
        }
    }

    /// 解析供应商实际使用的协议：`meta.apiFormat` 优先，否则按 app 默认。
    pub fn resolve(app_type: &AppType, provider: &Provider) -> Self {
        provider
            .meta
            .as_ref()
            .and_then(|m| m.api_format.as_deref())
            .and_then(Self::from_meta_str)
            .unwrap_or_else(|| Self::default_for_app(app_type))
    }

    /// 规范字符串形式，取值与 `meta.apiFormat` 一致。用于把解析结果传给按字符串
    /// 判定鉴权口径的下游（如 `/models` 取模型）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenAiChat => "openai_chat",
            Self::OpenAiResponses => "openai_responses",
            Self::GeminiNative => "gemini_native",
        }
    }
}

/// 测活请求：让模型用尽量少的字自报模型与知识截止时间，既能确认它真的在
/// 生成，也比无语义的「你好」更有诊断价值。
const DEFAULT_PROBE_MESSAGE: &str = "你是什么模型，知识截止时间是多少？用最少的字回复。";

/// 探测配置。持久化在 settings 表的 `model_probe_config` 键。
///
/// `default` 落到下面的 `impl Default`：新增字段时旧 JSON 仍能读出，
/// 缺的字段取默认值而不是让整次读取失败。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelProbeConfig {
    /// 单次探测超时（秒）。真实模型请求要等生成，故远大于可达性探测的 8s。
    pub timeout_secs: u64,
    /// 生成上限。够拿到可辨识的回复内容即可，避免浪费额度。
    pub max_tokens: u32,
    /// 探测用的提示词。
    pub message: String,
    /// 批量探测的最大并发。压得太高容易触发上游限流，反而测出假的慢。
    pub max_concurrency: usize,
}

impl Default for ModelProbeConfig {
    fn default() -> Self {
        Self {
            timeout_secs: 30,
            max_tokens: 64,
            message: DEFAULT_PROBE_MESSAGE.to_string(),
            max_concurrency: 4,
        }
    }
}

impl ModelProbeConfig {
    /// 收敛用户/历史配置里的越界值，避免 0 并发死锁或超长超时卡住批量任务。
    pub fn sanitized(&self) -> Self {
        Self {
            timeout_secs: self.timeout_secs.clamp(5, 120),
            max_tokens: self.max_tokens.clamp(1, 1024),
            message: if self.message.trim().is_empty() || self.message.trim() == "你好" {
                // 迁移旧版本写入数据库的默认探活词，避免升级后仍继续发送「你好」。
                DEFAULT_PROBE_MESSAGE.to_string()
            } else {
                self.message.clone()
            },
            max_concurrency: self.max_concurrency.clamp(1, 16),
        }
    }
}

/// 探测结果。**不落库**：结果只回传给前端内存，刷新即丢。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProbeResult {
    pub success: bool,
    /// 实际探测的模型 ID；未配置模型时为空串。
    pub model: String,
    /// 首字延迟（毫秒）：第一个非空文本增量到达的时刻。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_token_ms: Option<u64>,
    /// 总耗时（毫秒）：流结束的时刻。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// 回复内容（已截断），用于人工确认模型真的在回话。
    pub response_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    /// 失败原因；成功时为空串。
    pub message: String,
    pub tested_at: i64,
}

impl ModelProbeResult {
    /// 构造失败结果。`model` 允许为空（表示未配置模型）。
    pub fn failure(model: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            success: false,
            model: model.into(),
            first_token_ms: None,
            duration_ms: None,
            response_text: String::new(),
            http_status: None,
            message: message.into(),
            tested_at: chrono::Utc::now().timestamp(),
        }
    }
}

/// 流式读取的中间产物。
struct StreamOutcome {
    first_token_ms: Option<u64>,
    duration_ms: u64,
    text: String,
    /// 首个思维链增量的时刻与内容：整条流没有文本时用它证明模型确实在生成。
    first_reasoning_ms: Option<u64>,
    reasoning: String,
    /// 流内的错误事件（HTTP 200 + SSE `error`）。上游把错误塞进流里时，
    /// 这是唯一的失败原因来源。
    stream_error: Option<String>,
    /// 上游给出的结束原因（`max_tokens` / `stop` 等），用于解释「为什么没有文本」。
    stop_reason: Option<String>,
    /// 首批解析成功的 SSE 事件（最多 3 条），在未提取到文本时用于诊断上游实际返回了什么。
    raw_events: Vec<Value>,
}

pub struct ModelProbeService;

impl ModelProbeService {
    /// 探测单个供应商的指定模型。
    ///
    /// `base_url_override` 供 Copilot 等需要从 OAuth 管理器动态解析端点的供应商使用，
    /// 由命令层预先解析后传入；其余供应商传 `None`。
    ///
    /// 失败不返回 `Err`，而是回传 `success: false` 的结果——批量探测里单个供应商
    /// 的失败不应中断整批。仅参数级错误（供应商不存在等）由命令层返回 `Err`。
    pub async fn probe(
        app_type: &AppType,
        provider: &Provider,
        model: &str,
        config: &ModelProbeConfig,
        base_url_override: Option<String>,
    ) -> ModelProbeResult {
        let config = config.sanitized();

        if model.trim().is_empty() {
            return ModelProbeResult::failure("", "No model configured");
        }
        if provider.category.as_deref() == Some("official") {
            return ModelProbeResult::failure(
                model,
                "Official providers use client-side default endpoints and cannot be probed",
            );
        }

        let base_url = match base_url_override {
            Some(b) => b,
            None => match Self::resolve_base_url(app_type, provider) {
                Ok(b) => b,
                Err(e) => return ModelProbeResult::failure(model, e.to_string()),
            },
        };

        match Self::probe_once(app_type, provider, model, &base_url, &config).await {
            Ok(result) => result,
            Err(e) => ModelProbeResult::failure(model, e.to_string()),
        }
    }

    async fn probe_once(
        app_type: &AppType,
        provider: &Provider,
        model: &str,
        base_url: &str,
        config: &ModelProbeConfig,
    ) -> Result<ModelProbeResult, AppError> {
        let format = ApiFormat::resolve(app_type, provider);
        let is_full_url = provider
            .meta
            .as_ref()
            .and_then(|m| m.is_full_url)
            .unwrap_or(false);
        let url = build_probe_url(base_url, format, model, is_full_url)?;
        let body = build_probe_body(format, model, &config.message, config.max_tokens);

        let adapter = Self::adapter_for(app_type).ok_or_else(|| {
            AppError::Message(format!(
                "{} does not support model probing",
                app_type.as_str()
            ))
        })?;
        let auth = adapter.extract_auth(provider).ok_or_else(|| {
            AppError::Message("No API key configured for this provider".to_string())
        })?;
        let headers = adapter
            .get_auth_headers(&auth)
            .map_err(|e| AppError::Message(format!("Invalid credentials: {e}")))?
            .into_iter()
            .map(|(name, value)| {
                // HeaderValue 可能含非 UTF-8 字节（理论上），转不成字符串就丢弃该头，
                // 让请求以 401 失败而不是 panic。
                (
                    name.as_str().to_string(),
                    value.to_str().unwrap_or_default().to_string(),
                )
            })
            .collect::<Vec<_>>();

        Ok(probe_endpoint(
            &url,
            format,
            model,
            body,
            &headers,
            config.timeout_secs,
            Self::custom_user_agent(provider),
        )
        .await)
    }

    /// 与 `stream_check` 同口径地解析 base_url：累加模式应用的 `settings_config`
    /// 结构与 Claude/Codex/Gemini 不同，不走 adapter。
    fn resolve_base_url(app_type: &AppType, provider: &Provider) -> Result<String, AppError> {
        crate::services::stream_check::StreamCheckService::resolve_base_url(app_type, provider)
    }

    /// 取该应用的鉴权适配器。`None` 表示该应用不走 adapter 鉴权（如 Pi），
    /// 探测无法执行——由调用方回传一条失败结果，而不是 panic。
    fn adapter_for(app_type: &AppType) -> Option<Box<dyn ProviderAdapter>> {
        match app_type {
            AppType::ClaudeDesktop => Some(Box::new(ClaudeAdapter::new())),
            other => get_adapter(other),
        }
    }

    /// Provider 级自定义 User-Agent（`meta.customUserAgent`）：部分网关按 UA 白名单
    /// 放行，与转发 / 取模型路径共用同一口径，避免「代理能用但探测失败」。
    fn custom_user_agent(provider: &Provider) -> Option<HeaderValue> {
        provider
            .meta
            .as_ref()
            .and_then(|meta| meta.custom_user_agent_header().ok().flatten())
    }
}

/// 对一个已构造好的端点发起流式探测并计时。
///
/// 供应商探测与「默认 AI」测试共用此函数——两者的差别只在 URL / 鉴权头怎么来，
/// 发请求、读流、算首字这套逻辑必须一致，否则两处显示的秒数不可比。
///
/// 不返回 `Err`：所有失败都编码进 [`ModelProbeResult`]，便于批量场景逐条展示。
pub async fn probe_endpoint(
    url: &str,
    format: ApiFormat,
    model: &str,
    body: Value,
    auth_headers: &[(String, String)],
    timeout_secs: u64,
    custom_ua: Option<HeaderValue>,
) -> ModelProbeResult {
    let client = crate::proxy::http_client::get();
    let mut request = client
        .post(url)
        .timeout(Duration::from_secs(timeout_secs))
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
        // 探测请求不要压缩：压缩会让 SSE 事件在网关侧缓冲，首字延迟失真。
        .header("accept-encoding", "identity");

    for (name, value) in auth_headers {
        request = request.header(name.as_str(), value.as_str());
    }
    if format == ApiFormat::Anthropic {
        request = request.header("anthropic-version", ANTHROPIC_VERSION);
    }
    if let Some(ua) = custom_ua {
        request = request.header(USER_AGENT, ua);
    }

    let start = Instant::now();
    let response = match request.json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            return ModelProbeResult {
                duration_ms: Some(start.elapsed().as_millis() as u64),
                ..ModelProbeResult::failure(model, map_request_error(e).to_string())
            }
        }
    };
    let status = response.status();

    if !status.is_success() {
        let body = truncate_text(&response.text().await.unwrap_or_default());
        return ModelProbeResult {
            http_status: Some(status.as_u16()),
            duration_ms: Some(start.elapsed().as_millis() as u64),
            ..ModelProbeResult::failure(model, format!("HTTP {status}: {body}"))
        };
    }

    let outcome = match read_stream(response, format, start).await {
        Ok(o) => o,
        Err(e) => {
            return ModelProbeResult {
                http_status: Some(status.as_u16()),
                duration_ms: Some(start.elapsed().as_millis() as u64),
                ..ModelProbeResult::failure(model, e.to_string())
            }
        }
    };

    judge_outcome(model, status.as_u16(), outcome)
}

/// 把读流结果判成成功 / 失败。
///
/// 与网络分离，便于对「200 但没文本」的各种分支直接写单测——这些分支正是
/// 最容易踩坑的地方（思维链吃满额度、流内错误事件、非 SSE 的 JSON 错误体）。
fn judge_outcome(model: &str, http_status: u16, outcome: StreamOutcome) -> ModelProbeResult {
    // 流内错误事件优先于其它诊断：上游已经明说了原因，不必再猜。
    if let Some(err) = outcome.stream_error {
        return ModelProbeResult {
            http_status: Some(http_status),
            duration_ms: Some(outcome.duration_ms),
            ..ModelProbeResult::failure(model, truncate_text(&err))
        };
    }

    // 只有思维链、没有文本：开了思维链的模型把 max_tokens 全花在思考上时的常态。
    // 鉴权与模型都是通的，报失败会误导，故按成功回传并在回复里标注来源。
    if outcome.first_token_ms.is_none() && outcome.first_reasoning_ms.is_some() {
        return ModelProbeResult {
            success: true,
            model: model.to_string(),
            first_token_ms: outcome.first_reasoning_ms,
            duration_ms: Some(outcome.duration_ms),
            response_text: truncate_text(&format!("[思维链] {}", outcome.reasoning)),
            http_status: Some(http_status),
            message: String::new(),
            tested_at: chrono::Utc::now().timestamp(),
        };
    }

    // 200 但一个文本增量都没有：多数是网关返回了非 SSE 的 JSON 错误体，或模型
    // 被静默拒绝。当成失败更诚实——否则会显示「通」但首字为空。
    if outcome.first_token_ms.is_none() {
        let hint = if !outcome.text.is_empty() {
            // 非 SSE 的 JSON body（如 {"error": ...}）或缓冲区剩余内容。
            format!(
                "Stream returned no text content: {}",
                truncate_text(&outcome.text)
            )
        } else if !outcome.raw_events.is_empty() {
            // 收到了 SSE 事件但都不含文本增量（thinking / ping / tool_call 等）。
            // 把前几条原始事件序列化后展示，方便判断是 format 配错还是思维链耗尽 token。
            let sample = outcome
                .raw_events
                .iter()
                .map(|e| serde_json::to_string(e).unwrap_or_default())
                .collect::<Vec<_>>()
                .join(" | ");
            format!(
                "Stream returned no text content. Received: {}",
                truncate_text(&sample)
            )
        } else {
            "Stream returned no text content".to_string()
        };
        // 带上结束原因：`max_tokens` 说明是被上限截断（多为思维链吃满额度），
        // 与「上游静默拒绝」是两种完全不同的处置方式。
        let hint = match outcome.stop_reason.as_deref() {
            Some(reason) => format!("{hint} (stop_reason: {reason})"),
            None => hint,
        };
        return ModelProbeResult {
            http_status: Some(http_status),
            duration_ms: Some(outcome.duration_ms),
            ..ModelProbeResult::failure(model, hint)
        };
    }

    ModelProbeResult {
        success: true,
        model: model.to_string(),
        first_token_ms: outcome.first_token_ms,
        duration_ms: Some(outcome.duration_ms),
        response_text: truncate_text(&outcome.text),
        http_status: Some(http_status),
        message: String::new(),
        tested_at: chrono::Utc::now().timestamp(),
    }
}

/// 逐块读取 SSE 流，记录首个非空文本增量的时刻并累积回复文本。
async fn read_stream(
    response: reqwest::Response,
    format: ApiFormat,
    start: Instant,
) -> Result<StreamOutcome, AppError> {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut remainder: Vec<u8> = Vec::new();
    let mut text = String::new();
    let mut first_token_ms: Option<u64> = None;
    let mut reasoning = String::new();
    let mut first_reasoning_ms: Option<u64> = None;
    let mut stream_error: Option<String> = None;
    let mut stop_reason: Option<String> = None;
    // 诊断用：收集未找到文本增量前的原始事件（最多 3 条），
    // 用于在错误消息里展示上游实际发了什么（thinking/ping/错误体等）。
    let mut raw_events: Vec<Value> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(map_request_error)?;
        append_utf8_safe(&mut buffer, &mut remainder, &bytes);

        while let Some(block) = take_sse_block(&mut buffer) {
            for line in block.lines() {
                let Some(data) = strip_sse_field(line, "data") else {
                    continue;
                };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let Ok(event) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                // 在找到文本之前，留存样本供诊断。
                if first_token_ms.is_none() && raw_events.len() < 3 {
                    raw_events.push(event.clone());
                }
                // 错误事件可能出现在流的任意位置（含首个事件之后），必须全程盯着，
                // 否则只会看到「没有文本」这种无从下手的结论。
                if stream_error.is_none() {
                    stream_error = extract_stream_error(&event);
                }
                if stop_reason.is_none() {
                    stop_reason = extract_stop_reason(&event, format);
                }
                if let Some(delta) = extract_text_delta(&event, format) {
                    if !delta.is_empty() {
                        if first_token_ms.is_none() {
                            first_token_ms = Some(start.elapsed().as_millis() as u64);
                        }
                        text.push_str(&delta);
                        continue;
                    }
                }
                // 思维链增量：不算首字，但整条流没有文本时它是唯一的存活证据。
                if let Some(delta) = extract_reasoning_delta(&event, format) {
                    if delta.is_empty() {
                        continue;
                    }
                    if first_reasoning_ms.is_none() {
                        first_reasoning_ms = Some(start.elapsed().as_millis() as u64);
                    }
                    reasoning.push_str(&delta);
                }
            }
        }
    }

    // 非 SSE 响应（网关直接回 JSON）时缓冲区里留着整个 body，保留它做错误提示。
    if first_token_ms.is_none() && text.is_empty() && !buffer.trim().is_empty() {
        text = buffer.trim().to_string();
    }

    Ok(StreamOutcome {
        first_token_ms,
        duration_ms: start.elapsed().as_millis() as u64,
        text,
        first_reasoning_ms,
        reasoning,
        stream_error,
        stop_reason,
        raw_events,
    })
}

/// 构造探测端点 URL。
///
/// `is_full_url` 的供应商其 base_url 已是完整 API 端点（代理直接使用、不拼路径），
/// 故原样返回；Gemini Native 需要把模型 ID 嵌进路径。
pub fn build_probe_url(
    base_url: &str,
    format: ApiFormat,
    model: &str,
    is_full_url: bool,
) -> Result<String, AppError> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(AppError::Message("base_url is empty".to_string()));
    }
    if is_full_url {
        return Ok(base.to_string());
    }

    // base 已含版本段（`/v1`、智谱 `/api/coding/paas/v4`）时不能再补 `/v1`，
    // 与 `model_fetch::build_models_url_candidates` 的判断口径一致。
    let versioned = ends_with_version_segment(base);

    let url = match format {
        ApiFormat::Anthropic => {
            if versioned {
                format!("{base}/messages")
            } else {
                format!("{base}/v1/messages")
            }
        }
        ApiFormat::OpenAiChat => {
            if versioned {
                format!("{base}/chat/completions")
            } else {
                format!("{base}/v1/chat/completions")
            }
        }
        ApiFormat::OpenAiResponses => {
            if versioned {
                format!("{base}/responses")
            } else {
                format!("{base}/v1/responses")
            }
        }
        ApiFormat::GeminiNative => {
            // Gemini 的版本段是 `/v1beta`，不匹配 `/v{N}` 数字规则，故单独判断。
            let root = if base.ends_with("/v1beta") || base.ends_with("/v1") {
                base.to_string()
            } else {
                format!("{base}/v1beta")
            };
            format!("{root}/models/{model}:streamGenerateContent?alt=sse")
        }
    };
    Ok(url)
}

/// 构造探测请求体。一律 `stream: true`——不流式就测不出首字。
pub fn build_probe_body(format: ApiFormat, model: &str, message: &str, max_tokens: u32) -> Value {
    match format {
        ApiFormat::Anthropic => json!({
            "model": model,
            "max_tokens": max_tokens,
            "stream": true,
            "messages": [{ "role": "user", "content": message }],
        }),
        ApiFormat::OpenAiChat => json!({
            "model": model,
            "max_tokens": max_tokens,
            "stream": true,
            "messages": [{ "role": "user", "content": message }],
        }),
        ApiFormat::OpenAiResponses => json!({
            "model": model,
            "max_output_tokens": max_tokens,
            "stream": true,
            "input": [{
                "role": "user",
                "content": [{ "type": "input_text", "text": message }],
            }],
        }),
        ApiFormat::GeminiNative => json!({
            "contents": [{
                "role": "user",
                "parts": [{ "text": message }],
            }],
            "generationConfig": { "maxOutputTokens": max_tokens },
        }),
    }
}

/// 从一个 SSE 事件里提取文本增量。
///
/// 只认**文本**增量：thinking / reasoning / tool_call 增量不计入首字，否则开了
/// 思维链的模型会把「思考开始」当成首字，与未开思维链的供应商不可比。
pub fn extract_text_delta(event: &Value, format: ApiFormat) -> Option<String> {
    match format {
        ApiFormat::Anthropic => {
            // 部分网关把首段文本直接放在 content_block_start 里，之后才发 delta。
            // 与 `default_ai::stream_read_anthropic` 同口径，否则同一个上游在
            // 「测试」里不通、在助手对话里却能说话。
            if event.get("type").and_then(Value::as_str) == Some("content_block_start") {
                return event
                    .pointer("/content_block/text")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            // content_block_delta { delta: { type: "text_delta", text } }
            let delta = event.get("delta")?;
            let delta_type = delta.get("type").and_then(Value::as_str);
            if delta_type == Some("text_delta") {
                return delta
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            // 有明确的非文本增量类型（thinking_delta / input_json_delta / …）时
            // 不能落到下面的兜底：thinking_delta 也带 text 字段的网关存在，
            // 那会把思考当成首字。
            if delta_type.is_some() {
                return None;
            }
            // 部分网关直接给 { delta: { text } }
            delta
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_string)
        }
        ApiFormat::OpenAiChat => event
            .pointer("/choices/0/delta/content")
            .and_then(Value::as_str)
            .map(str::to_string),
        ApiFormat::OpenAiResponses => {
            // response.output_text.delta { delta: "..." }
            if let Some(d) = event.get("delta").and_then(Value::as_str) {
                return Some(d.to_string());
            }
            event
                .pointer("/response/output_text/delta")
                .and_then(Value::as_str)
                .map(str::to_string)
        }
        ApiFormat::GeminiNative => event
            .pointer("/candidates/0/content/parts/0/text")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

/// 从一个 SSE 事件里提取**思维链**增量。
///
/// 只在整条流没有任何文本增量时才用得上：开了思维链的模型撞上 `max_tokens`
/// 上限（探测默认只给 64）会把额度全花在思考上，一个字的正文都发不出来。
/// 那种情况下报「无文本」等于把一个能用的模型判死，故用它兜底。
pub fn extract_reasoning_delta(event: &Value, format: ApiFormat) -> Option<String> {
    match format {
        ApiFormat::Anthropic => {
            let delta = event.get("delta")?;
            if delta.get("type").and_then(Value::as_str) != Some("thinking_delta") {
                return None;
            }
            delta
                .get("thinking")
                .and_then(Value::as_str)
                .map(str::to_string)
        }
        // DeepSeek / 智谱 / Qwen 等 OpenAI 兼容端点各用一个字段名，全都认。
        ApiFormat::OpenAiChat => ["reasoning_content", "reasoning", "thinking"]
            .iter()
            .find_map(|field| {
                event
                    .pointer(&format!("/choices/0/delta/{field}"))
                    .and_then(Value::as_str)
            })
            .map(str::to_string),
        ApiFormat::OpenAiResponses => {
            if event
                .get("type")
                .and_then(Value::as_str)?
                .contains("reasoning")
            {
                return event
                    .get("delta")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            None
        }
        // Gemini 的思考摘要与正文同在 parts[].text，靠 `thought: true` 区分；
        // 该字段在 parts 内而非顶层，且 extract_text_delta 已把 parts[0] 当正文，
        // 这里不重复判断。
        ApiFormat::GeminiNative => None,
    }
}

/// 提取流内错误事件的描述。HTTP 200 + SSE `error` 是各家网关常见的错误传递方式。
///
/// 与 `default_ai::stream_read_anthropic` 的 `error` 分支同口径，另外兼容
/// OpenAI 兼容端点的 `{"error": {...}}` 与顶层 `{"type":"error", ...}`。
fn extract_stream_error(event: &Value) -> Option<String> {
    let is_error_type = event.get("type").and_then(Value::as_str) == Some("error");
    let error = event.get("error");
    if !is_error_type && error.is_none() {
        return None;
    }

    // 错误体既可能是 { error: { type, message } }，也可能是 { error: "..." }。
    let node = error.unwrap_or(event);
    if let Some(message) = node.as_str() {
        return Some(message.to_string());
    }
    let kind = node
        .get("type")
        .and_then(Value::as_str)
        .or_else(|| node.get("code").and_then(Value::as_str))
        .unwrap_or("error");
    let message = node
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Unknown error");
    Some(format!("{kind}: {message}"))
}

/// 提取上游给出的结束原因，用来解释「200 但没有文本」。
fn extract_stop_reason(event: &Value, format: ApiFormat) -> Option<String> {
    let reason = match format {
        ApiFormat::Anthropic => event
            .pointer("/delta/stop_reason")
            .or_else(|| event.pointer("/message/stop_reason"))
            .or_else(|| event.get("stop_reason")),
        ApiFormat::OpenAiChat => event.pointer("/choices/0/finish_reason"),
        ApiFormat::OpenAiResponses => event.pointer("/response/status"),
        ApiFormat::GeminiNative => event.pointer("/candidates/0/finishReason"),
    };
    reason
        .and_then(Value::as_str)
        .filter(|r| !r.is_empty() && *r != "null")
        .map(str::to_string)
}

/// 判断 URL 是否以 OpenAI 风格版本段 `/v{N}` 结尾（`/v1`、`.../paas/v4`）。
fn ends_with_version_segment(url: &str) -> bool {
    let last = url.rsplit('/').next().unwrap_or("");
    last.strip_prefix('v')
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

fn truncate_text(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= ERROR_BODY_MAX_CHARS {
        trimmed.to_string()
    } else {
        let mut s: String = trimmed.chars().take(ERROR_BODY_MAX_CHARS).collect();
        s.push('…');
        s
    }
}

fn map_request_error(e: reqwest::Error) -> AppError {
    if e.is_timeout() {
        AppError::Message("Request timeout".to_string())
    } else if e.is_connect() {
        AppError::Message(format!("Connection failed: {e}"))
    } else {
        AppError::Message(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_appends_version_when_missing() {
        let url =
            build_probe_url("https://api.example.com", ApiFormat::Anthropic, "m", false).unwrap();
        assert_eq!(url, "https://api.example.com/v1/messages");

        let url =
            build_probe_url("https://api.example.com", ApiFormat::OpenAiChat, "m", false).unwrap();
        assert_eq!(url, "https://api.example.com/v1/chat/completions");
    }

    #[test]
    fn url_does_not_double_version_segment() {
        // 已含 /v1 时再补 /v1 会 404。
        let url = build_probe_url(
            "https://api.example.com/v1",
            ApiFormat::OpenAiChat,
            "m",
            false,
        )
        .unwrap();
        assert_eq!(url, "https://api.example.com/v1/chat/completions");

        // 智谱 Coding Plan 以 /v4 结尾，同样已含版本段。
        let url = build_probe_url(
            "https://open.bigmodel.cn/api/coding/paas/v4",
            ApiFormat::OpenAiChat,
            "m",
            false,
        )
        .unwrap();
        assert_eq!(
            url,
            "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"
        );
    }

    #[test]
    fn url_trims_trailing_slash_and_rejects_empty() {
        let url =
            build_probe_url("https://api.example.com/", ApiFormat::Anthropic, "m", false).unwrap();
        assert_eq!(url, "https://api.example.com/v1/messages");
        assert!(build_probe_url("   ", ApiFormat::Anthropic, "m", false).is_err());
    }

    #[test]
    fn url_passes_through_full_url_untouched() {
        // is_full_url 的供应商 base_url 已是完整端点，拼路径会打错地方。
        let url = build_probe_url(
            "https://gw.example.com/relay/chat",
            ApiFormat::OpenAiChat,
            "m",
            true,
        )
        .unwrap();
        assert_eq!(url, "https://gw.example.com/relay/chat");
    }

    #[test]
    fn url_embeds_model_for_gemini_native() {
        let url = build_probe_url(
            "https://generativelanguage.googleapis.com",
            ApiFormat::GeminiNative,
            "gemini-3.6-flash",
            false,
        )
        .unwrap();
        assert_eq!(
            url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse"
        );

        // 已带 /v1beta 时不重复追加。
        let url = build_probe_url(
            "https://proxy.example.com/v1beta",
            ApiFormat::GeminiNative,
            "g",
            false,
        )
        .unwrap();
        assert_eq!(
            url,
            "https://proxy.example.com/v1beta/models/g:streamGenerateContent?alt=sse"
        );
    }

    #[test]
    fn body_always_requests_streaming() {
        for format in [
            ApiFormat::Anthropic,
            ApiFormat::OpenAiChat,
            ApiFormat::OpenAiResponses,
        ] {
            let body = build_probe_body(format, "m", "你好", 64);
            assert_eq!(
                body.get("stream").and_then(Value::as_bool),
                Some(true),
                "{format:?} must stream, otherwise TTFT is unmeasurable"
            );
        }
        // Gemini Native 通过 URL 的 :streamGenerateContent?alt=sse 表达流式，
        // 请求体里没有 stream 字段。
        let body = build_probe_body(ApiFormat::GeminiNative, "m", "你好", 64);
        assert!(body.get("stream").is_none());
        assert_eq!(
            body.pointer("/generationConfig/maxOutputTokens")
                .and_then(Value::as_u64),
            Some(64)
        );
    }

    #[test]
    fn body_carries_message_and_token_limit() {
        let body = build_probe_body(ApiFormat::Anthropic, "claude-x", "ping", 8);
        assert_eq!(body.get("model").and_then(Value::as_str), Some("claude-x"));
        assert_eq!(body.get("max_tokens").and_then(Value::as_u64), Some(8));
        assert_eq!(
            body.pointer("/messages/0/content").and_then(Value::as_str),
            Some("ping")
        );

        let body = build_probe_body(ApiFormat::OpenAiResponses, "gpt-x", "ping", 8);
        assert_eq!(
            body.get("max_output_tokens").and_then(Value::as_u64),
            Some(8)
        );
        assert_eq!(
            body.pointer("/input/0/content/0/text")
                .and_then(Value::as_str),
            Some("ping")
        );
    }

    #[test]
    fn delta_extraction_per_format() {
        let event = json!({ "type": "content_block_delta", "delta": { "type": "text_delta", "text": "你" } });
        assert_eq!(
            extract_text_delta(&event, ApiFormat::Anthropic).as_deref(),
            Some("你")
        );

        let event = json!({ "choices": [{ "delta": { "content": "好" } }] });
        assert_eq!(
            extract_text_delta(&event, ApiFormat::OpenAiChat).as_deref(),
            Some("好")
        );

        let event = json!({ "type": "response.output_text.delta", "delta": "hi" });
        assert_eq!(
            extract_text_delta(&event, ApiFormat::OpenAiResponses).as_deref(),
            Some("hi")
        );

        let event = json!({ "candidates": [{ "content": { "parts": [{ "text": "hey" }] } }] });
        assert_eq!(
            extract_text_delta(&event, ApiFormat::GeminiNative).as_deref(),
            Some("hey")
        );
    }

    #[test]
    fn delta_extraction_ignores_non_text_events() {
        // 思维链增量不能算首字，否则开思维链的模型与不开的不可比。
        let thinking = json!({ "type": "content_block_delta", "delta": { "type": "thinking_delta", "thinking": "..." } });
        assert!(extract_text_delta(&thinking, ApiFormat::Anthropic).is_none());

        let role_only = json!({ "choices": [{ "delta": { "role": "assistant" } }] });
        assert!(extract_text_delta(&role_only, ApiFormat::OpenAiChat).is_none());

        let tool_call = json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0 }] } }] });
        assert!(extract_text_delta(&tool_call, ApiFormat::OpenAiChat).is_none());

        let ping = json!({ "type": "ping" });
        assert!(extract_text_delta(&ping, ApiFormat::Anthropic).is_none());
    }

    /// 空白 outcome 模板，各分支只改自己关心的字段。
    fn outcome() -> StreamOutcome {
        StreamOutcome {
            first_token_ms: None,
            duration_ms: 100,
            text: String::new(),
            first_reasoning_ms: None,
            reasoning: String::new(),
            stream_error: None,
            stop_reason: None,
            raw_events: Vec::new(),
        }
    }

    #[test]
    fn reasoning_only_stream_counts_as_reachable() {
        // 开了思维链的模型 + max_tokens=64：额度全花在思考上，正文一个字都发不出。
        // 鉴权与模型都是通的，判失败等于把能用的供应商标成坏的。
        let r = judge_outcome(
            "claude-x",
            200,
            StreamOutcome {
                first_reasoning_ms: Some(700),
                reasoning: "用户在问我是什么模型".to_string(),
                stop_reason: Some("max_tokens".to_string()),
                ..outcome()
            },
        );
        assert!(r.success);
        assert_eq!(r.first_token_ms, Some(700));
        assert!(r.message.is_empty());
        // 回复里要标明这不是正文，否则用户会以为模型答了这些字。
        assert!(r.response_text.starts_with("[思维链]"));
    }

    #[test]
    fn text_wins_over_reasoning_for_first_token() {
        // 两者都有时，首字必须是文本的时刻，否则与不开思维链的供应商不可比。
        let r = judge_outcome(
            "claude-x",
            200,
            StreamOutcome {
                first_token_ms: Some(900),
                text: "我是 Claude".to_string(),
                first_reasoning_ms: Some(300),
                reasoning: "思考".to_string(),
                ..outcome()
            },
        );
        assert!(r.success);
        assert_eq!(r.first_token_ms, Some(900));
        assert_eq!(r.response_text, "我是 Claude");
    }

    #[test]
    fn stream_error_beats_no_text_hint() {
        // HTTP 200 + SSE error：上游已明说原因，不该再回「没有文本」这种废话。
        let r = judge_outcome(
            "claude-x",
            200,
            StreamOutcome {
                stream_error: Some("overloaded_error: Overloaded".to_string()),
                raw_events: vec![json!({ "type": "message_start" })],
                ..outcome()
            },
        );
        assert!(!r.success);
        assert_eq!(r.message, "overloaded_error: Overloaded");
        assert_eq!(r.http_status, Some(200));
    }

    #[test]
    fn no_text_failure_appends_stop_reason() {
        let r = judge_outcome(
            "claude-x",
            200,
            StreamOutcome {
                raw_events: vec![json!({ "type": "message_start" })],
                stop_reason: Some("max_tokens".to_string()),
                ..outcome()
            },
        );
        assert!(!r.success);
        assert!(r.message.contains("Received:"));
        assert!(
            r.message.contains("stop_reason: max_tokens"),
            "结束原因决定了下一步怎么处置，必须带上：{}",
            r.message
        );
    }

    #[test]
    fn anthropic_text_in_content_block_start_counts_as_text() {
        // 部分网关把首段文本塞进 start 事件；漏掉它会让能用的上游报「无文本」。
        let event = json!({
            "type": "content_block_start",
            "index": 0,
            "content_block": { "type": "text", "text": "我是" },
        });
        assert_eq!(
            extract_text_delta(&event, ApiFormat::Anthropic).as_deref(),
            Some("我是")
        );

        // tool_use 的 start 事件没有 text，不能误认。
        let tool = json!({
            "type": "content_block_start",
            "content_block": { "type": "tool_use", "id": "t1", "name": "x", "input": {} },
        });
        assert!(extract_text_delta(&tool, ApiFormat::Anthropic).is_none());
    }

    #[test]
    fn thinking_delta_carrying_text_field_is_not_first_token() {
        // 有网关给 thinking_delta 也带上 text；兜底分支必须让位于显式类型判断，
        // 否则思考会被当成首字，跟不开思维链的供应商不可比。
        let event = json!({
            "type": "content_block_delta",
            "delta": { "type": "thinking_delta", "thinking": "嗯", "text": "嗯" },
        });
        assert!(extract_text_delta(&event, ApiFormat::Anthropic).is_none());
        assert_eq!(
            extract_reasoning_delta(&event, ApiFormat::Anthropic).as_deref(),
            Some("嗯")
        );
    }

    #[test]
    fn reasoning_delta_recognized_per_format() {
        let ant = json!({
            "type": "content_block_delta",
            "delta": { "type": "thinking_delta", "thinking": "let me" },
        });
        assert_eq!(
            extract_reasoning_delta(&ant, ApiFormat::Anthropic).as_deref(),
            Some("let me")
        );
        // 文本增量不是思维链。
        let text = json!({ "delta": { "type": "text_delta", "text": "hi" } });
        assert!(extract_reasoning_delta(&text, ApiFormat::Anthropic).is_none());

        // OpenAI 兼容端点的三种字段名都要认。
        for field in ["reasoning_content", "reasoning", "thinking"] {
            let ev = json!({ "choices": [{ "delta": { field: "hmm" } }] });
            assert_eq!(
                extract_reasoning_delta(&ev, ApiFormat::OpenAiChat).as_deref(),
                Some("hmm"),
                "{field} should be recognized as reasoning"
            );
            // 且不能被当成正文。
            assert!(extract_text_delta(&ev, ApiFormat::OpenAiChat).is_none());
        }

        let resp = json!({ "type": "response.reasoning_summary_text.delta", "delta": "why" });
        assert_eq!(
            extract_reasoning_delta(&resp, ApiFormat::OpenAiResponses).as_deref(),
            Some("why")
        );
    }

    #[test]
    fn stream_error_events_are_extracted() {
        // Anthropic 风格：HTTP 200 + SSE error 事件。
        let ev = json!({
            "type": "error",
            "error": { "type": "overloaded_error", "message": "Overloaded" },
        });
        assert_eq!(
            extract_stream_error(&ev).as_deref(),
            Some("overloaded_error: Overloaded")
        );

        // OpenAI 兼容网关常见的 { error: { code, message } }。
        let ev = json!({ "error": { "code": "insufficient_quota", "message": "no balance" } });
        assert_eq!(
            extract_stream_error(&ev).as_deref(),
            Some("insufficient_quota: no balance")
        );

        // error 是裸字符串的网关。
        let ev = json!({ "error": "boom" });
        assert_eq!(extract_stream_error(&ev).as_deref(), Some("boom"));

        // 正常事件不能被误判成错误。
        let ev = json!({ "type": "content_block_delta", "delta": { "text": "hi" } });
        assert!(extract_stream_error(&ev).is_none());
    }

    #[test]
    fn stop_reason_extracted_per_format() {
        let ev = json!({ "type": "message_delta", "delta": { "stop_reason": "max_tokens" } });
        assert_eq!(
            extract_stop_reason(&ev, ApiFormat::Anthropic).as_deref(),
            Some("max_tokens")
        );

        // message_start 把 stop_reason 置为 null，不能当成结束原因。
        let ev = json!({ "type": "message_start", "message": { "stop_reason": null } });
        assert!(extract_stop_reason(&ev, ApiFormat::Anthropic).is_none());

        let ev = json!({ "choices": [{ "finish_reason": "length" }] });
        assert_eq!(
            extract_stop_reason(&ev, ApiFormat::OpenAiChat).as_deref(),
            Some("length")
        );

        let ev = json!({ "candidates": [{ "finishReason": "MAX_TOKENS" }] });
        assert_eq!(
            extract_stop_reason(&ev, ApiFormat::GeminiNative).as_deref(),
            Some("MAX_TOKENS")
        );
    }

    #[test]
    fn format_resolves_from_meta_then_falls_back_to_app_default() {
        assert_eq!(
            ApiFormat::from_meta_str("openai_responses"),
            Some(ApiFormat::OpenAiResponses)
        );
        assert_eq!(ApiFormat::from_meta_str("nonsense"), None);

        assert_eq!(
            ApiFormat::default_for_app(&AppType::Claude),
            ApiFormat::Anthropic
        );
        assert_eq!(
            ApiFormat::default_for_app(&AppType::ClaudeDesktop),
            ApiFormat::Anthropic
        );
        assert_eq!(
            ApiFormat::default_for_app(&AppType::Gemini),
            ApiFormat::GeminiNative
        );
        assert_eq!(
            ApiFormat::default_for_app(&AppType::Codex),
            ApiFormat::OpenAiChat
        );
    }

    #[test]
    fn config_sanitizes_out_of_range_values() {
        let config = ModelProbeConfig {
            timeout_secs: 0,
            max_tokens: 0,
            message: "   ".to_string(),
            max_concurrency: 0,
        };
        let s = config.sanitized();
        // 0 并发会让 buffer_unordered 永久挂住，必须收敛到至少 1。
        assert_eq!(s.max_concurrency, 1);
        assert_eq!(s.timeout_secs, 5);
        assert_eq!(s.max_tokens, 1);
        assert_eq!(s.message, DEFAULT_PROBE_MESSAGE);

        let legacy = ModelProbeConfig {
            message: "你好".to_string(),
            ..ModelProbeConfig::default()
        }
        .sanitized();
        assert_eq!(legacy.message, DEFAULT_PROBE_MESSAGE);

        let config = ModelProbeConfig {
            timeout_secs: 9999,
            max_tokens: 99999,
            message: "hi".to_string(),
            max_concurrency: 999,
        };
        let s = config.sanitized();
        assert_eq!(s.timeout_secs, 120);
        assert_eq!(s.max_tokens, 1024);
        assert_eq!(s.max_concurrency, 16);
        assert_eq!(s.message, "hi");
    }

    #[test]
    fn config_defaults_match_documented_values() {
        let d = ModelProbeConfig::default();
        assert_eq!(d.max_tokens, 64);
        assert_eq!(d.max_concurrency, 4);
        assert_eq!(d.timeout_secs, 30);
    }

    #[test]
    fn failure_result_has_no_timings() {
        let r = ModelProbeResult::failure("m", "boom");
        assert!(!r.success);
        assert_eq!(r.model, "m");
        assert_eq!(r.message, "boom");
        assert!(r.first_token_ms.is_none());
        assert!(r.duration_ms.is_none());
    }

    #[test]
    fn truncate_keeps_short_text_and_caps_long_text() {
        assert_eq!(truncate_text("  hi  "), "hi");
        let long: String = "x".repeat(ERROR_BODY_MAX_CHARS + 50);
        let out = truncate_text(&long);
        assert_eq!(out.chars().count(), ERROR_BODY_MAX_CHARS + 1);
        assert!(out.ends_with('…'));
    }
}
