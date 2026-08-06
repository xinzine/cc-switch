//! 默认 AI 服务
//!
//! 「默认 AI」是驱动内置聊天助手的模型，凭据**独立于站点列表存储**（settings 表的
//! `default_ai_config` 键）。这样删掉某个站点不会顺手把助手自己删掉，助手也不会
//! 因为你切换当前供应商而换脑子。
//!
//! 本服务做三件事：验证配置可用（复用 [`crate::services::model_probe`] 的探测）、
//! 以流式 SSE 发带 function calling 的对话（文本增量通过 callback 实时推出）、
//! 以及把前端存的 OpenAI 形状历史转换为 Anthropic 协议（tool_calls / tool 消息）。
//!
//! 工具的实际执行在前端，后端不代为执行。新增 / 修改由前端直接调用既有命令，
//! 不可撤销的删除必须经用户在 UI 上确认。

use futures::StreamExt;
use reqwest::header::USER_AGENT;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Duration;

use crate::error::AppError;
use crate::proxy::sse::{append_utf8_safe, strip_sse_field, take_sse_block};
use crate::services::model_probe::{
    build_probe_body, build_probe_url, ApiFormat, ModelProbeConfig, ModelProbeResult,
};

/// 对话请求超时（秒）。助手可能要生成较长回复，故比探测宽松。
const CHAT_TIMEOUT_SECS: u64 = 120;

/// 错误响应体截断长度。
const ERROR_BODY_MAX_CHARS: usize = 512;

const ANTHROPIC_VERSION: &str = "2023-06-01";

/// 默认 AI 配置。
///
/// 注意 `api_key` 以明文存于本地 SQLite，与项目既有的供应商凭据同级别；
/// 它会随配置备份 / 导出一起走，与现有行为一致。
/// 全字段 `default`：缺字段的历史/异常 JSON 也能读出来。否则 DAO 的
/// `from_str` 会硬失败，让整个「读默认 AI 配置」报错而不是回退到空配置。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DefaultAiConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// `"openai_chat"`（默认）或 `"anthropic"`。
    pub api_format: String,
}

impl DefaultAiConfig {
    /// 解析协议格式。仅支持 OpenAI Chat 与 Anthropic 两种——助手需要 function
    /// calling，而 Responses / Gemini Native 的工具协议差异较大，暂不纳入。
    pub fn format(&self) -> ApiFormat {
        match self.api_format.trim() {
            "anthropic" => ApiFormat::Anthropic,
            _ => ApiFormat::OpenAiChat,
        }
    }

    /// 校验必填项齐备。空配置时给出可操作的提示而不是让请求打到空 URL。
    pub fn validate(&self) -> Result<(), AppError> {
        if self.base_url.trim().is_empty() {
            return Err(AppError::Message(
                "Default AI base URL is not configured".to_string(),
            ));
        }
        if self.api_key.trim().is_empty() {
            return Err(AppError::Message(
                "Default AI API key is not configured".to_string(),
            ));
        }
        if self.model.trim().is_empty() {
            return Err(AppError::Message(
                "Default AI model is not configured".to_string(),
            ));
        }
        Ok(())
    }
}

/// 一轮对话的返回。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    /// 助手的文本回复（可能为空——模型只发起工具调用时）。
    pub content: String,
    /// 模型请求的工具调用。前端据此渲染确认卡或直接执行只读工具。
    pub tool_calls: Vec<ToolCall>,
    /// 上游给出的结束原因，便于前端判断是否需要继续下一轮。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// 工具参数的 JSON 字符串。两家协议都可能给出不完整/非法 JSON，故不在后端
    /// 解析成结构体，原样交前端处理并容错。
    pub arguments: String,
}

pub struct DefaultAiService;

impl DefaultAiService {
    /// 验证默认 AI 是否可用：发一次真实流式请求，回传首字 / 总耗时。
    pub async fn test(config: &DefaultAiConfig) -> ModelProbeResult {
        if let Err(e) = config.validate() {
            return ModelProbeResult::failure(config.model.clone(), e.to_string());
        }

        let probe = ModelProbeConfig::default().sanitized();
        let format = config.format();
        let url = match build_probe_url(&config.base_url, format, &config.model, false) {
            Ok(u) => u,
            Err(e) => return ModelProbeResult::failure(config.model.clone(), e.to_string()),
        };
        let body = build_probe_body(format, &config.model, &probe.message, probe.max_tokens);

        crate::services::model_probe::probe_endpoint(
            &url,
            format,
            &config.model,
            body,
            &auth_headers(config),
            probe.timeout_secs,
            None,
        )
        .await
    }

    /// 拉取默认 AI 可用的模型列表。
    pub async fn fetch_models(
        config: &DefaultAiConfig,
    ) -> Result<Vec<crate::services::model_fetch::FetchedModel>, String> {
        if config.base_url.trim().is_empty() {
            return Err("Default AI base URL is not configured".to_string());
        }
        if config.api_key.trim().is_empty() {
            return Err("Default AI API key is not configured".to_string());
        }
        crate::services::model_fetch::fetch_models(
            &config.base_url,
            &config.api_key,
            false,
            None,
            None,
            config.format() == ApiFormat::Anthropic,
        )
        .await
    }

    /// 发一轮带工具的**流式**对话。
    ///
    /// `messages` 按 OpenAI 的 `{role, content, tool_calls?, tool_call_id?}` 组装；
    /// Anthropic 格式在此转换（历史消息中的 tool_calls / tool 消息）。
    /// 每个文本增量通过 `on_text_delta` 回调实时推出；最终返回完整 `ChatReply`
    /// （tool calls 在流结束后才一次性交出，保证参数已闭合）。
    pub async fn chat<F>(
        config: &DefaultAiConfig,
        messages: Vec<Value>,
        tools: Vec<Value>,
        mut on_text_delta: F,
    ) -> Result<ChatReply, AppError>
    where
        F: FnMut(String) -> Result<(), AppError> + Send,
    {
        config.validate()?;

        let format = config.format();
        let url = chat_url(&config.base_url, format)?;
        let body = build_chat_body(format, &config.model, &messages, &tools);

        let client = crate::proxy::http_client::get();
        let mut request = client
            .post(&url)
            .timeout(Duration::from_secs(CHAT_TIMEOUT_SECS))
            .header("content-type", "application/json")
            .header("accept", "text/event-stream")
            .header("accept-encoding", "identity");
        for (name, value) in auth_headers(config) {
            request = request.header(name, value);
        }
        if format == ApiFormat::Anthropic {
            request = request.header("anthropic-version", ANTHROPIC_VERSION);
        }
        request = request.header(USER_AGENT, "cc-switch-assistant");

        let response = request.json(&body).send().await.map_err(|e| {
            if e.is_timeout() {
                AppError::Message("Request timeout".to_string())
            } else if e.is_connect() {
                AppError::Message(format!("Connection failed: {e}"))
            } else {
                AppError::Message(e.to_string())
            }
        })?;

        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(AppError::Message(format!(
                "HTTP {status}: {}",
                truncate(&text)
            )));
        }

        // Content-Type 不是 SSE 时降级为完整 JSON（兼容不支持流式的网关）。
        let is_sse = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(|ct| ct.contains("text/event-stream"))
            .unwrap_or(false);

        if !is_sse {
            let text = response.text().await.unwrap_or_default();
            let value: Value = serde_json::from_str(&text)
                .map_err(|e| AppError::Message(format!("Invalid JSON response: {e}")))?;
            return Ok(parse_chat_reply(&value, format));
        }

        match format {
            ApiFormat::Anthropic => stream_read_anthropic(response, &mut on_text_delta).await,
            _ => stream_read_openai(response, &mut on_text_delta).await,
        }
    }
}

/// 构造鉴权头。Anthropic 用 `x-api-key`，OpenAI 兼容端点用 `Authorization: Bearer`。
fn auth_headers(config: &DefaultAiConfig) -> Vec<(String, String)> {
    let key = config.api_key.trim().to_string();
    match config.format() {
        ApiFormat::Anthropic => vec![("x-api-key".to_string(), key)],
        _ => vec![("authorization".to_string(), format!("Bearer {key}"))],
    }
}

fn chat_url(base_url: &str, format: ApiFormat) -> Result<String, AppError> {
    // 复用探测的 URL 构造：对话与探测打的是同一个端点。
    build_probe_url(base_url, format, "", false)
}

/// 构造对话请求体（流式）。
///
/// `chat()` 与单测共用这一份，避免测试断言一个不上线的副本——这个坑踩过一次：
/// 曾有一份 `#[cfg(test)]` 的旧副本，改断言时以为改的是生产路径。
fn build_chat_body(format: ApiFormat, model: &str, messages: &[Value], tools: &[Value]) -> Value {
    match format {
        ApiFormat::Anthropic => {
            // Anthropic 把 system 提到顶层，工具 schema 形状不同，
            // 且历史里的 tool_calls / tool 消息要改写成 tool_use / tool_result。
            let (system, msgs) = to_anthropic_messages(messages);
            let mut body = json!({
                "model": model,
                "max_tokens": 4096,
                "stream": true,
                "messages": msgs,
            });
            if let Some(system) = system {
                body["system"] = json!(system);
            }
            if !tools.is_empty() {
                body["tools"] = json!(tools.iter().map(to_anthropic_tool).collect::<Vec<Value>>());
            }
            body
        }
        _ => {
            let mut body = json!({
                "model": model,
                "stream": true,
                "messages": messages,
            });
            if !tools.is_empty() {
                body["tools"] = json!(tools);
                body["tool_choice"] = json!("auto");
            }
            body
        }
    }
}

/// OpenAI 工具 schema → Anthropic 工具 schema。
///
/// OpenAI: `{ type: "function", function: { name, description, parameters } }`
/// Anthropic: `{ name, description, input_schema }`
fn to_anthropic_tool(tool: &Value) -> Value {
    let f = tool.get("function").unwrap_or(tool);
    json!({
        "name": f.get("name").and_then(Value::as_str).unwrap_or_default(),
        "description": f.get("description").and_then(Value::as_str).unwrap_or_default(),
        "input_schema": f.get("parameters").cloned().unwrap_or_else(|| json!({
            "type": "object",
            "properties": {},
        })),
    })
}

/// 解析上游回复为统一的 [`ChatReply`]。
fn parse_chat_reply(value: &Value, format: ApiFormat) -> ChatReply {
    match format {
        ApiFormat::Anthropic => {
            let mut content = String::new();
            let mut tool_calls = Vec::new();
            if let Some(blocks) = value.get("content").and_then(Value::as_array) {
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(t) = block.get("text").and_then(Value::as_str) {
                                content.push_str(t);
                            }
                        }
                        Some("tool_use") => {
                            tool_calls.push(ToolCall {
                                id: block
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                name: block
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                arguments: block
                                    .get("input")
                                    .map(|v| v.to_string())
                                    .unwrap_or_else(|| "{}".to_string()),
                            });
                        }
                        _ => {}
                    }
                }
            }
            ChatReply {
                content,
                tool_calls,
                finish_reason: value
                    .get("stop_reason")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            }
        }
        _ => {
            let message = value.pointer("/choices/0/message");
            let content = message
                .and_then(|m| m.get("content"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let tool_calls = message
                .and_then(|m| m.get("tool_calls"))
                .and_then(Value::as_array)
                .map(|calls| {
                    calls
                        .iter()
                        .map(|c| ToolCall {
                            id: c
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            name: c
                                .pointer("/function/name")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            arguments: c
                                .pointer("/function/arguments")
                                .and_then(Value::as_str)
                                .unwrap_or("{}")
                                .to_string(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            ChatReply {
                content,
                tool_calls,
                finish_reason: value
                    .pointer("/choices/0/finish_reason")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            }
        }
    }
}

fn truncate(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= ERROR_BODY_MAX_CHARS {
        trimmed.to_string()
    } else {
        let mut s: String = trimmed.chars().take(ERROR_BODY_MAX_CHARS).collect();
        s.push('…');
        s
    }
}

// ──────────────────────────────────────────────────────────────────────────
// 流式 SSE 读取
// ──────────────────────────────────────────────────────────────────────────

/// 内部：OpenAI Chat 工具调用累积器（按 index 存放）。
struct OaiToolAcc {
    id: String,
    name: String,
    arguments: String,
}

/// 内部：Anthropic content block 工具调用累积器（按 index 存放）。
struct AntToolAcc {
    id: String,
    name: String,
    arguments: String,
    /// 部分网关把完整 input 放在 content_block_start，之后不再发 input_json_delta。
    input_fallback: String,
}

/// 读取 OpenAI Chat 流式响应，每个文本增量调用 `on_text_delta`；
/// 流结束后返回完整 `ChatReply`（tool calls 此时才可安全执行）。
async fn stream_read_openai<F>(
    response: reqwest::Response,
    on_text_delta: &mut F,
) -> Result<ChatReply, AppError>
where
    F: FnMut(String) -> Result<(), AppError>,
{
    let mut stream = response.bytes_stream();
    let mut sse_buf = String::new();
    let mut remainder: Vec<u8> = Vec::new();
    let mut content = String::new();
    let mut tool_map: BTreeMap<usize, OaiToolAcc> = BTreeMap::new();
    let mut finish_reason: Option<String> = None;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| AppError::Message(e.to_string()))?;
        append_utf8_safe(&mut sse_buf, &mut remainder, &bytes);

        while let Some(block) = take_sse_block(&mut sse_buf) {
            for line in block.lines() {
                let Some(data) = strip_sse_field(line, "data") else {
                    continue;
                };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let Ok(ev) = serde_json::from_str::<Value>(data) else {
                    continue;
                };

                // 文本增量
                if let Some(delta) = ev
                    .pointer("/choices/0/delta/content")
                    .and_then(Value::as_str)
                {
                    if !delta.is_empty() {
                        content.push_str(delta);
                        on_text_delta(delta.to_string())?;
                    }
                }

                // 工具调用增量
                if let Some(tcs) = ev
                    .pointer("/choices/0/delta/tool_calls")
                    .and_then(Value::as_array)
                {
                    for tc in tcs {
                        let idx = tc.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                        let acc = tool_map.entry(idx).or_insert_with(|| OaiToolAcc {
                            id: String::new(),
                            name: String::new(),
                            arguments: String::new(),
                        });
                        if let Some(id) = tc.get("id").and_then(Value::as_str) {
                            if !id.is_empty() {
                                acc.id = id.to_string();
                            }
                        }
                        if let Some(n) = tc.pointer("/function/name").and_then(Value::as_str) {
                            if !n.is_empty() {
                                acc.name = n.to_string();
                            }
                        }
                        if let Some(a) = tc.pointer("/function/arguments").and_then(Value::as_str) {
                            acc.arguments.push_str(a);
                        }
                    }
                }

                // finish_reason
                if let Some(fr) = ev
                    .pointer("/choices/0/finish_reason")
                    .and_then(Value::as_str)
                {
                    if !fr.is_empty() && fr != "null" {
                        finish_reason = Some(fr.to_string());
                    }
                }
            }
        }
    }

    let tool_calls = tool_map
        .into_values()
        .map(|acc| ToolCall {
            id: acc.id,
            name: acc.name,
            arguments: acc.arguments,
        })
        .collect();

    Ok(ChatReply {
        content,
        tool_calls,
        finish_reason,
    })
}

/// 读取 Anthropic 流式响应，每个文本增量调用 `on_text_delta`；
/// 流结束后返回完整 `ChatReply`。
async fn stream_read_anthropic<F>(
    response: reqwest::Response,
    on_text_delta: &mut F,
) -> Result<ChatReply, AppError>
where
    F: FnMut(String) -> Result<(), AppError>,
{
    let mut stream = response.bytes_stream();
    let mut sse_buf = String::new();
    let mut remainder: Vec<u8> = Vec::new();
    let mut content = String::new();
    let mut tool_blocks: BTreeMap<usize, AntToolAcc> = BTreeMap::new();
    let mut finish_reason: Option<String> = None;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| AppError::Message(e.to_string()))?;
        append_utf8_safe(&mut sse_buf, &mut remainder, &bytes);

        while let Some(block) = take_sse_block(&mut sse_buf) {
            // Anthropic 用 "event:" 行标明类型，data 行含 JSON
            let ev_type = block
                .lines()
                .find_map(|l| strip_sse_field(l, "event"))
                .unwrap_or("");
            let data = block
                .lines()
                .find_map(|l| strip_sse_field(l, "data"))
                .unwrap_or("")
                .trim();

            if data.is_empty() {
                continue;
            }
            let Ok(ev) = serde_json::from_str::<Value>(data) else {
                continue;
            };

            // JSON "type" 优先于 SSE "event:" 字段
            let json_type = ev.get("type").and_then(Value::as_str).unwrap_or(ev_type);

            match json_type {
                "content_block_start" => {
                    let idx = ev.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                    let block_type = ev
                        .pointer("/content_block/type")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if block_type == "tool_use" {
                        tool_blocks.insert(
                            idx,
                            AntToolAcc {
                                id: ev
                                    .pointer("/content_block/id")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                name: ev
                                    .pointer("/content_block/name")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                arguments: String::new(),
                                input_fallback: ev
                                    .pointer("/content_block/input")
                                    .map(|v| v.to_string())
                                    .unwrap_or_default(),
                            },
                        );
                    } else if block_type == "text" {
                        // 部分网关把初始文本放在 start 事件
                        if let Some(t) = ev.pointer("/content_block/text").and_then(Value::as_str) {
                            if !t.is_empty() {
                                content.push_str(t);
                                on_text_delta(t.to_string())?;
                            }
                        }
                    }
                }
                "content_block_delta" => {
                    let idx = ev.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                    let delta_type = ev
                        .pointer("/delta/type")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    match delta_type {
                        "text_delta" => {
                            if let Some(t) = ev.pointer("/delta/text").and_then(Value::as_str) {
                                if !t.is_empty() {
                                    content.push_str(t);
                                    on_text_delta(t.to_string())?;
                                }
                            }
                        }
                        "input_json_delta" => {
                            if let Some(partial) =
                                ev.pointer("/delta/partial_json").and_then(Value::as_str)
                            {
                                if let Some(acc) = tool_blocks.get_mut(&idx) {
                                    acc.arguments.push_str(partial);
                                }
                            }
                        }
                        _ => {}
                    }
                }
                "message_delta" => {
                    if let Some(fr) = ev.pointer("/delta/stop_reason").and_then(Value::as_str) {
                        finish_reason = Some(fr.to_string());
                    }
                }
                "error" => {
                    let et = ev
                        .pointer("/error/type")
                        .and_then(Value::as_str)
                        .unwrap_or("error");
                    let em = ev
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("Unknown error");
                    return Err(AppError::Message(format!("{et}: {em}")));
                }
                _ => {}
            }
        }
    }

    let tool_calls = tool_blocks
        .into_values()
        .map(|acc| ToolCall {
            id: acc.id,
            name: acc.name,
            arguments: if !acc.arguments.is_empty() {
                acc.arguments
            } else if !acc.input_fallback.is_empty() {
                acc.input_fallback
            } else {
                "{}".to_string()
            },
        })
        .collect();

    Ok(ChatReply {
        content,
        tool_calls,
        finish_reason,
    })
}

/// 把 OpenAI 形状的历史消息转换为 Anthropic 协议。
///
/// - system 消息提取到顶层。
/// - assistant `tool_calls` → content array 里的 `tool_use` block。
/// - `role:"tool"` → user 消息里的 `tool_result` block；
///   连续多条 tool result 合并进同一个 user 消息（并行 tool calls 必须）。
/// - user content 数组里的 `image_url` block → Anthropic 的 `image` block。
///
/// OpenAI 单个 content block → Anthropic content block。
///
/// 图片形状差异较大：
/// - OpenAI: `{type:"image_url", image_url:{url:"data:image/png;base64,XXX"}}`
/// - Anthropic: `{type:"image", source:{type:"base64", media_type, data}}`
///
/// 只处理 data URL：Anthropic 的 base64 source 不接受远程 URL，而本应用的图片
/// 都来自本地文件读取，不会出现 http(s) 形式。无法识别的 block 原样透传，让
/// 上游给出明确报错，而不是在这里静默丢内容。
fn to_anthropic_block(block: &Value) -> Value {
    if block.get("type").and_then(Value::as_str) != Some("image_url") {
        return block.clone();
    }
    let url = block
        .pointer("/image_url/url")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match parse_data_url(url) {
        Some((media_type, data)) => json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type,
                "data": data,
            },
        }),
        None => block.clone(),
    }
}

/// 拆 `data:<media-type>;base64,<data>`，返回 `(media_type, data)`。
fn parse_data_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let media_type = meta.strip_suffix(";base64")?;
    if media_type.is_empty() || data.is_empty() {
        return None;
    }
    Some((media_type.to_string(), data.to_string()))
}

fn to_anthropic_messages(messages: &[Value]) -> (Option<String>, Vec<Value>) {
    let mut system: Option<String> = None;
    let mut result: Vec<Value> = Vec::new();

    for msg in messages {
        let role = msg.get("role").and_then(Value::as_str).unwrap_or("");
        match role {
            // 只取第一条 system：Anthropic 顶层 system 是单值，后续的直接丢弃。
            "system" if system.is_none() => {
                system = msg
                    .get("content")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            "system" => {}
            "assistant" => {
                let mut blocks: Vec<Value> = Vec::new();
                if let Some(text) = msg.get("content").and_then(Value::as_str) {
                    if !text.is_empty() {
                        blocks.push(json!({ "type": "text", "text": text }));
                    }
                }
                if let Some(calls) = msg.get("tool_calls").and_then(Value::as_array) {
                    for c in calls {
                        let id = c.get("id").and_then(Value::as_str).unwrap_or_default();
                        let name = c
                            .pointer("/function/name")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let args_str = c
                            .pointer("/function/arguments")
                            .and_then(Value::as_str)
                            .unwrap_or("{}");
                        let input: Value =
                            serde_json::from_str(args_str).unwrap_or_else(|_| json!({}));
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": id,
                            "name": name,
                            "input": input,
                        }));
                    }
                }
                if blocks.is_empty() {
                    blocks.push(json!({ "type": "text", "text": "" }));
                }
                result.push(json!({ "role": "assistant", "content": blocks }));
            }
            "tool" => {
                let tool_use_id = msg
                    .get("tool_call_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let tool_content = msg
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let tr_block = json!({
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": tool_content,
                });
                // 如果上一条已是 user 消息且包含 tool_result，合并进去（并行调用）
                let merged = if let Some(last) = result.last_mut() {
                    if last.get("role").and_then(Value::as_str) == Some("user") {
                        if let Some(arr) = last.get_mut("content").and_then(Value::as_array_mut) {
                            if arr.iter().any(|b| {
                                b.get("type").and_then(Value::as_str) == Some("tool_result")
                            }) {
                                arr.push(tr_block.clone());
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    false
                };
                if !merged {
                    result.push(json!({
                        "role": "user",
                        "content": [tr_block],
                    }));
                }
            }
            "user" => {
                // 已经是字符串时包进 text block；数组形式逐块转换（图片形状两家不同）
                let content = match msg.get("content") {
                    Some(Value::String(s)) => {
                        json!([{ "type": "text", "text": s }])
                    }
                    Some(Value::Array(blocks)) => {
                        json!(blocks
                            .iter()
                            .map(to_anthropic_block)
                            .collect::<Vec<Value>>())
                    }
                    Some(v) => v.clone(),
                    None => json!([{ "type": "text", "text": "" }]),
                };
                result.push(json!({ "role": "user", "content": content }));
            }
            _ => {}
        }
    }

    (system, result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_defaults_to_openai_chat() {
        let mut c = DefaultAiConfig::default();
        assert_eq!(c.format(), ApiFormat::OpenAiChat);
        c.api_format = "anthropic".to_string();
        assert_eq!(c.format(), ApiFormat::Anthropic);
        c.api_format = "garbage".to_string();
        assert_eq!(c.format(), ApiFormat::OpenAiChat);
    }

    #[test]
    fn validate_reports_each_missing_field() {
        let mut c = DefaultAiConfig::default();
        assert!(c.validate().is_err());
        c.base_url = "https://api.example.com".to_string();
        assert!(c.validate().is_err());
        c.api_key = "sk-x".to_string();
        assert!(c.validate().is_err());
        c.model = "gpt-x".to_string();
        assert!(c.validate().is_ok());
    }

    #[test]
    fn auth_header_differs_per_format() {
        let c = DefaultAiConfig {
            base_url: "https://api.example.com".to_string(),
            api_key: " sk-x ".to_string(),
            model: "m".to_string(),
            api_format: "anthropic".to_string(),
        };
        assert_eq!(
            auth_headers(&c),
            vec![("x-api-key".to_string(), "sk-x".to_string())]
        );

        let c = DefaultAiConfig {
            api_format: "openai_chat".to_string(),
            ..c
        };
        assert_eq!(
            auth_headers(&c),
            vec![("authorization".to_string(), "Bearer sk-x".to_string())]
        );
    }

    #[test]
    fn chat_body_openai_includes_tools_and_auto_choice() {
        let messages = vec![json!({ "role": "user", "content": "hi" })];
        let tools = vec![json!({
            "type": "function",
            "function": { "name": "listProviders", "description": "d", "parameters": { "type": "object" } }
        })];
        let body = build_chat_body(ApiFormat::OpenAiChat, "gpt-x", &messages, &tools);
        assert_eq!(body.get("model").and_then(Value::as_str), Some("gpt-x"));
        assert_eq!(
            body.get("tool_choice").and_then(Value::as_str),
            Some("auto")
        );
        assert_eq!(
            body.get("stream").and_then(Value::as_bool),
            Some(true),
            "chat turn must be streaming"
        );
        assert_eq!(
            body.pointer("/tools/0/function/name")
                .and_then(Value::as_str),
            Some("listProviders")
        );
    }

    #[test]
    fn chat_body_anthropic_hoists_system_and_rewrites_tools() {
        let messages = vec![
            json!({ "role": "system", "content": "you are x" }),
            json!({ "role": "user", "content": "hi" }),
        ];
        let tools = vec![json!({
            "type": "function",
            "function": { "name": "listProviders", "description": "d", "parameters": { "type": "object" } }
        })];
        let body = build_chat_body(ApiFormat::Anthropic, "claude-x", &messages, &tools);

        // system 必须提到顶层，且不能留在 messages 里（Anthropic 会 400）。
        assert_eq!(
            body.get("system").and_then(Value::as_str),
            Some("you are x")
        );
        let msgs = body.get("messages").and_then(Value::as_array).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].get("role").and_then(Value::as_str), Some("user"));

        // 工具要转成 input_schema 形状。
        assert_eq!(
            body.pointer("/tools/0/name").and_then(Value::as_str),
            Some("listProviders")
        );
        assert!(body.pointer("/tools/0/input_schema").is_some());
        assert!(body.pointer("/tools/0/function").is_none());
    }

    #[test]
    fn chat_body_omits_tools_when_none() {
        let messages = vec![json!({ "role": "user", "content": "hi" })];
        let body = build_chat_body(ApiFormat::OpenAiChat, "gpt-x", &messages, &[]);
        assert!(body.get("tools").is_none());
        assert!(body.get("tool_choice").is_none());
    }

    #[test]
    fn openai_body_passes_image_blocks_through_unchanged() {
        // OpenAI 兼容端点原生吃 image_url，不该被改写。
        let messages = vec![json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "看这张图" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAA" } },
            ],
        })];
        let body = build_chat_body(ApiFormat::OpenAiChat, "gpt-x", &messages, &[]);
        assert_eq!(
            body.pointer("/messages/0/content/1/image_url/url")
                .and_then(Value::as_str),
            Some("data:image/png;base64,AAA")
        );
    }

    #[test]
    fn anthropic_body_rewrites_image_url_to_base64_source() {
        let messages = vec![json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "看这张图" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAA" } },
            ],
        })];
        let body = build_chat_body(ApiFormat::Anthropic, "claude-x", &messages, &[]);

        // 文本块保持原样。
        assert_eq!(
            body.pointer("/messages/0/content/0/type")
                .and_then(Value::as_str),
            Some("text")
        );
        // 图片块要转成 Anthropic 的 base64 source 形状。
        assert_eq!(
            body.pointer("/messages/0/content/1/type")
                .and_then(Value::as_str),
            Some("image")
        );
        assert_eq!(
            body.pointer("/messages/0/content/1/source/media_type")
                .and_then(Value::as_str),
            Some("image/png")
        );
        assert_eq!(
            body.pointer("/messages/0/content/1/source/data")
                .and_then(Value::as_str),
            Some("AAA")
        );
        // 不能残留 OpenAI 形状，否则 Anthropic 会 400。
        assert!(body.pointer("/messages/0/content/1/image_url").is_none());
    }

    #[test]
    fn non_data_url_image_is_left_alone() {
        // Anthropic 的 base64 source 不接受远程 URL；原样透传让上游给出明确报错，
        // 而不是在这里静默丢掉用户的图。
        let block = json!({
            "type": "image_url",
            "image_url": { "url": "https://example.com/a.png" },
        });
        assert_eq!(to_anthropic_block(&block), block);
    }

    #[test]
    fn parse_data_url_rejects_malformed_input() {
        assert_eq!(
            parse_data_url("data:image/jpeg;base64,ZZZ"),
            Some(("image/jpeg".to_string(), "ZZZ".to_string()))
        );
        // 缺 base64 标记、缺逗号、缺数据、非 data URL：一律不认。
        assert_eq!(parse_data_url("data:image/png,AAA"), None);
        assert_eq!(parse_data_url("data:image/png;base64"), None);
        assert_eq!(parse_data_url("data:image/png;base64,"), None);
        assert_eq!(parse_data_url("data:;base64,AAA"), None);
        assert_eq!(parse_data_url("https://example.com/a.png"), None);
    }

    #[test]
    fn anthropic_messages_rewrite_tool_call_round() {
        // 前端历史是 OpenAI 形状：assistant.tool_calls + role:"tool"。
        // Anthropic 要 tool_use block + user 消息里的 tool_result。
        let messages = vec![
            json!({ "role": "user", "content": "删掉 p1" }),
            json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": { "name": "deleteProvider", "arguments": "{\"id\":\"p1\"}" }
                }],
            }),
            json!({ "role": "tool", "tool_call_id": "call_1", "content": "{\"ok\":true}" }),
        ];
        let (system, msgs) = to_anthropic_messages(&messages);
        assert!(system.is_none());
        assert_eq!(msgs.len(), 3);

        assert_eq!(
            msgs[1].pointer("/content/0/type").and_then(Value::as_str),
            Some("tool_use")
        );
        // arguments 是 JSON 字符串，Anthropic 的 input 要求对象。
        assert_eq!(
            msgs[1]
                .pointer("/content/0/input/id")
                .and_then(Value::as_str),
            Some("p1")
        );

        // tool 结果必须变成 user 角色，否则 Anthropic 会 400。
        assert_eq!(msgs[2].get("role").and_then(Value::as_str), Some("user"));
        assert_eq!(
            msgs[2]
                .pointer("/content/0/tool_use_id")
                .and_then(Value::as_str),
            Some("call_1")
        );
    }

    #[test]
    fn parallel_tool_results_merge_into_one_user_message() {
        // 并行 tool calls 的多条结果必须合并进同一个 user 消息。
        let messages = vec![
            json!({ "role": "tool", "tool_call_id": "c1", "content": "r1" }),
            json!({ "role": "tool", "tool_call_id": "c2", "content": "r2" }),
        ];
        let (_, msgs) = to_anthropic_messages(&messages);
        assert_eq!(msgs.len(), 1, "两条 tool result 应合并为一条 user 消息");
        let blocks = msgs[0].get("content").and_then(Value::as_array).unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(
            blocks[1].get("tool_use_id").and_then(Value::as_str),
            Some("c2")
        );
    }

    #[test]
    fn parse_openai_reply_with_tool_calls() {
        let value = json!({
            "choices": [{
                "message": {
                    "content": "let me check",
                    "tool_calls": [{
                        "id": "call_1",
                        "function": { "name": "deleteProvider", "arguments": "{\"id\":\"p1\"}" }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        });
        let reply = parse_chat_reply(&value, ApiFormat::OpenAiChat);
        assert_eq!(reply.content, "let me check");
        assert_eq!(reply.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!(reply.tool_calls.len(), 1);
        assert_eq!(reply.tool_calls[0].name, "deleteProvider");
        assert_eq!(reply.tool_calls[0].arguments, "{\"id\":\"p1\"}");
    }

    #[test]
    fn parse_openai_reply_with_null_content() {
        // 纯工具调用轮次 content 是 null，不能 panic。
        let value = json!({
            "choices": [{ "message": { "content": null, "tool_calls": [] }, "finish_reason": "stop" }]
        });
        let reply = parse_chat_reply(&value, ApiFormat::OpenAiChat);
        assert_eq!(reply.content, "");
        assert!(reply.tool_calls.is_empty());
    }

    #[test]
    fn parse_anthropic_reply_merges_text_and_tool_use() {
        let value = json!({
            "content": [
                { "type": "text", "text": "checking " },
                { "type": "text", "text": "now" },
                { "type": "tool_use", "id": "tu_1", "name": "listProviders", "input": { "appId": "claude" } }
            ],
            "stop_reason": "tool_use"
        });
        let reply = parse_chat_reply(&value, ApiFormat::Anthropic);
        assert_eq!(reply.content, "checking now");
        assert_eq!(reply.finish_reason.as_deref(), Some("tool_use"));
        assert_eq!(reply.tool_calls.len(), 1);
        assert_eq!(reply.tool_calls[0].id, "tu_1");
        assert_eq!(reply.tool_calls[0].arguments, r#"{"appId":"claude"}"#);
    }

    #[test]
    fn parse_anthropic_reply_ignores_unknown_blocks() {
        let value = json!({
            "content": [{ "type": "thinking", "thinking": "hmm" }, { "type": "text", "text": "ok" }],
        });
        let reply = parse_chat_reply(&value, ApiFormat::Anthropic);
        assert_eq!(reply.content, "ok");
        assert!(reply.tool_calls.is_empty());
        assert!(reply.finish_reason.is_none());
    }

    #[test]
    fn chat_url_matches_probe_endpoint() {
        assert_eq!(
            chat_url("https://api.example.com", ApiFormat::OpenAiChat).unwrap(),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            chat_url("https://api.example.com/v1", ApiFormat::Anthropic).unwrap(),
            "https://api.example.com/v1/messages"
        );
    }
}
