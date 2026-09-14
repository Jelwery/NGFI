/**
 * Local source fork of @ad/dsh-llm-trae-plugin 0.1.3 with native DSH image
 * attachment support for TRAE raw-chat.
 */
import z from "@deepseek-ai/schemastery";
import { CONTEXT_WINDOW_EXCEEDED_CODE, CallId, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, ReasoningEffortId, RetryPolicySchema, attributionHeaders, contentHasImage, isContextWindowExceededError, isQuotaExceededError, offloadRequestImagesWithPolicy, requestImageHandleText, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
//#region lib/types/serialize.js
/** Serialize provider-neutral harness messages into TRAE raw-chat requests. @module dsh-llm-trae-plugin/serialize */
/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks) {
	if (contentHasImage(blocks)) throw new LlmError("The TRAE raw-chat adapter does not support image content.", "UNSUPPORTED_CONTENT");
}
function textContent(text) {
	return [{
		type: "text",
		text
	}];
}
const TRAE_REQUEST_IMAGE_POLICY = {
	maxPixels: 4 * 1024 * 1024,
	maxBytes: 4 * 1024 * 1024
};
const TRAE_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;
const TRAE_MAX_IMAGES_PER_REQUEST = 20;
function assertSupportedImageRoles(messages) {
	for (const message of messages) if (message.role !== "user" && contentHasImage(message.content)) throw new LlmError(`The TRAE raw-chat adapter cannot represent image content in a ${message.role} message.`, "UNSUPPORTED_CONTENT");
}
function collectImageRefs(content, refs) {
	for (const block of content) if (block.type === "image") refs.set(block.attachment.attachmentId, block.attachment);
	else if (block.type === "tool-result") collectImageRefs(block.content, refs);
}
async function prepareRequestImages(messages, attachments, signal) {
	const refs = /* @__PURE__ */ new Map();
	for (const message of messages) collectImageRefs(message.content, refs);
	const ordered = [...refs.values()];
	const projected = await Promise.all(ordered.map((ref) => attachments.readImageRequest(ref, TRAE_REQUEST_IMAGE_POLICY, signal)));
	return new Map(ordered.map((ref, index) => [ref.attachmentId, projected[index]]));
}
function imageParts(block, requestImages, precededByContent) {
	const version = requestImages.get(block.attachment.attachmentId);
	if (version === void 0) throw new LlmError(`TRAE request image ${block.attachment.attachmentId} was not prepared.`, "INVALID_REQUEST");
	return [{
		type: "text",
		text: `${precededByContent ? "\n" : ""}${requestImageHandleText(version)}`
	}, {
		type: "image_url",
		image_url: { url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString("base64")}` }
	}];
}
function contentParts(blocks, requestImages) {
	const parts = [];
	for (const block of blocks) switch (block.type) {
		case "text":
			if (block.text.length > 0) parts.push({
				type: "text",
				text: block.text
			});
			break;
		case "image":
			parts.push(...imageParts(block, requestImages, parts.length > 0));
			break;
		case "tool-result":
			parts.push(...contentParts(block.content, requestImages));
			break;
		default: break;
	}
	return parts;
}
async function serializeMessagesWithImages(messages, attachments, signal) {
	assertSupportedImageRoles(messages);
	const requestImages = await prepareRequestImages(messages, attachments, signal);
	const requestMessages = offloadRequestImagesWithPolicy(messages, {
		representation: "base64",
		byteLength: (ref) => {
			const version = requestImages.get(ref.attachmentId);
			if (version === void 0) throw new LlmError(`TRAE request image ${ref.attachmentId} was not prepared.`, "INVALID_REQUEST");
			return version.bytes;
		},
		maxBytes: TRAE_MAX_REQUEST_IMAGE_BYTES,
		maxImages: TRAE_MAX_IMAGES_PER_REQUEST,
		byteQuantum: 10 * 1024 * 1024,
		countQuantum: 5
	});
	const wire = [];
	const toolNames = /* @__PURE__ */ new Map();
	let pendingToolImages = [];
	const flushToolImages = () => {
		if (pendingToolImages.length === 0) return;
		wire.push({
			role: "user",
			content: [{
				type: "text",
				text: "Attached image(s) from tool result:"
			}, ...pendingToolImages]
		});
		pendingToolImages = [];
	};
	for (const message of requestMessages) {
		if (message.role === "system") {
			flushToolImages();
			wire.push({
				role: "system",
				content: textContent(flattenText(message.content))
			});
			continue;
		}
		if (message.role === "assistant") {
			flushToolImages();
			wire.push(serializeAssistant(message));
			for (const block of message.content) if (block.type === "tool-call") toolNames.set(block.id, block.name);
			continue;
		}
		const regular = message.content.filter((block) => block.type !== "tool-result");
		const toolResults = message.content.filter((block) => block.type === "tool-result");
		const content = contentParts(regular, requestImages);
		if (content.length > 0 || toolResults.length === 0) {
			flushToolImages();
			wire.push({
				role: "user",
				content
			});
		}
		for (const result of toolResults) {
			const parts = contentParts(result.content, requestImages);
			const imageParts = parts.filter((part) => part.type === "image_url");
			const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("");
			wire.push({
				role: "tool",
				content: textContent(text || "(no output)"),
				tool_call_id: result.toolCallId,
				...toolNames.get(result.toolCallId) === void 0 ? {} : { name: toolNames.get(result.toolCallId) }
			});
			pendingToolImages.push(...imageParts);
		}
	}
	flushToolImages();
	return wire;
}
function serializeAssistant(message) {
	const toolCalls = message.content.filter((block) => block.type === "tool-call").map((block, index) => ({
		index,
		id: block.id,
		type: "function",
		function_call: {
			name: block.name,
			arguments: block.arguments
		}
	}));
	return {
		role: "assistant",
		content: textContent(flattenText(message.content)),
		...toolCalls.length === 0 ? {} : { tool_calls: toolCalls }
	};
}
/**
* Serialize the conversation. Tool results become standalone `tool` messages;
* a mixed user message contributes its visible text before those results.
* @param messages - provider-neutral history in order.
* @returns TRAE raw-chat history in provider order.
*/
function serializeMessages(messages) {
	const wire = [];
	const toolNames = /* @__PURE__ */ new Map();
	for (const message of messages) {
		assertTextOnly(message.content);
		if (message.role === "system") {
			wire.push({
				role: "system",
				content: textContent(flattenText(message.content))
			});
			continue;
		}
		if (message.role === "assistant") {
			wire.push(serializeAssistant(message));
			for (const block of message.content) if (block.type === "tool-call") toolNames.set(block.id, block.name);
			continue;
		}
		const toolResults = message.content.filter((block) => block.type === "tool-result");
		const text = flattenText(message.content);
		if (text.length > 0 || toolResults.length === 0) wire.push({
			role: "user",
			content: textContent(text)
		});
		for (const result of toolResults) wire.push({
			role: "tool",
			content: textContent(flattenText(result.content) || "(no output)"),
			tool_call_id: result.toolCallId,
			...toolNames.get(result.toolCallId) === void 0 ? {} : { name: toolNames.get(result.toolCallId) }
		});
	}
	return wire;
}
function reasoningEffort(value) {
	if (value === void 0) return void 0;
	switch (String(value)) {
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
		case "max": return String(value);
		default: throw new LlmError(`TRAE does not support reasoning effort "${value}"`, "UNSUPPORTED_REASONING_EFFORT");
	}
}
function latestUserInput(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		return message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
	}
}
/**
* Build one TRAE raw-chat request.
* @param options - provider-neutral request assembled by the harness.
* @param model - TRAE display/config name and backend variant.
* @param identity - operation-local request and conversation ids.
* @returns the raw-chat JSON body.
*/
function serializeRequest(options, model, identity) {
	if (options.temperature !== void 0) throw new LlmError("TRAE raw chat does not support GenerateOptions.temperature", "UNSUPPORTED_OPTION");
	if (options.stop !== void 0) throw new LlmError("TRAE raw chat does not support GenerateOptions.stop", "UNSUPPORTED_OPTION");
	const messages = [];
	if (options.system !== void 0) messages.push({
		role: "system",
		content: textContent(options.system)
	});
	messages.push(...serializeMessages(options.messages));
	const tools = options.tools?.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: JSON.stringify(tool.parameters)
		}
	}));
	const effort = options.purpose === "session-title" ? void 0 : reasoningEffort(options.reasoningEffort);
	const userInput = latestUserInput(messages);
	return {
		config_name: model.configName,
		model_name: model.backendModel,
		...userInput === void 0 ? {} : { user_input: userInput },
		messages,
		session_id: identity.requestId,
		conversation_id: identity.conversationId,
		is_preset: true,
		...tools !== void 0 && tools.length > 0 ? {
			tools,
			parallel_tool_calls: true
		} : {},
		...options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens },
		...effort === void 0 ? {} : { reasoning_effort: effort }
	};
}
async function serializeRequestWithImages(options, model, identity, attachments, signal) {
	const messages = [];
	if (options.system !== void 0) messages.push({
		role: "system",
		content: textContent(options.system)
	});
	messages.push(...await serializeMessagesWithImages(options.messages, attachments, signal));
	const base = serializeRequest({
		...options,
		messages: []
	}, model, identity);
	const userInput = latestUserInput(messages);
	return {
		...base,
		...userInput === void 0 ? {} : { user_input: userInput },
		messages
	};
}
//#endregion
//#region lib/types/sse.js
/** Decode TRAE named SSE events while preserving strict terminal framing. @module dsh-llm-trae-plugin/sse */
/**
* Parse a byte stream into named TRAE events. The terminal `done` event is
* yielded and ends iteration; EOF before it is a truncated model response.
* @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
* @param onActivity - callback for every comment or dispatched event.
* @returns named events in arrival order, with `done` last.
*/
async function* parseSse(stream, onActivity) {
	const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment: () => {
		onActivity?.();
	} }));
	for await (const event of events) {
		onActivity?.();
		const named = {
			event: event.event ?? "message",
			data: event.data
		};
		yield named;
		if (named.event === "done") return;
	}
	throw new LlmError("TRAE SSE stream ended without a done event", "STREAM_CLOSED");
}
//#endregion
//#region lib/types/translate.js
/** Translate TRAE named SSE events into the harness `StreamChunk` protocol. @module dsh-llm-trae-plugin/translate */
/**
* Map the wire finish_reason vocabulary to the harness FinishReason.
* @param reason - the wire `finish_reason` string.
* @returns the mapped reason; unrecognized values (content_filter, …) become `{kind: 'error'}` with the uppercased value as `code`.
*/
function mapFinishReason(reason) {
	switch (reason) {
		case "": return { kind: "stop" };
		case "stop": return { kind: "stop" };
		case "tool_calls": return { kind: "tool-calls" };
		case "length": return { kind: "max-tokens" };
		default: return {
			kind: "error",
			failure: {
				message: `model stopped: ${reason}`,
				code: reason.toUpperCase()
			}
		};
	}
}
/**
* Map TRAE usage into disjoint harness counts.
* @param usage - `token_usage` SSE payload.
* @returns disjoint cache, input, output, and reasoning counts.
*/
function mapUsage(usage) {
	const cacheRead = usage.cache_read_input_tokens;
	const cacheWrite = usage.cache_creation_input_tokens;
	return {
		inputTokens: Math.max(0, usage.prompt_tokens - (cacheRead ?? 0) - (cacheWrite ?? 0)),
		outputTokens: usage.completion_tokens,
		...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
		...cacheWrite !== void 0 ? { cacheWriteTokens: cacheWrite } : {},
		...usage.reasoning_tokens === void 0 ? {} : { reasoningTokens: usage.reasoning_tokens }
	};
}
/** Assemble the final ContentBlock for one open block. */
function closeBlock(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: CallId(block.callId ?? ""),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/**
* Consume named TRAE events through the terminal `done` event.
* @param events - named events from the TRAE raw-chat stream.
* @returns deltas as they arrive, followed by block ends, usage, and finish.
*/
async function* translate(events) {
	let nextIndex = 0;
	let textBlock;
	let reasoningBlock;
	const toolBlocks = /* @__PURE__ */ new Map();
	const order = [];
	let pendingUsage;
	function open(kind) {
		const block = {
			index: nextIndex++,
			kind,
			text: ""
		};
		order.push(block);
		return block;
	}
	for await (const event of events) {
		if (event.event === "done") {
			const done = parseEvent(event);
			for (const block of order) yield {
				type: "block-end",
				index: block.index,
				block: closeBlock(block)
			};
			if (pendingUsage) yield {
				type: "usage",
				usage: pendingUsage
			};
			const reason = mapFinishReason(done.finish_reason ?? "");
			yield {
				type: "finish",
				reason: reason.kind === "stop" && order.length === 0 ? {
					kind: "error",
					failure: {
						message: "model returned a completed response with no content",
						code: EMPTY_RESPONSE_CODE
					}
				} : reason
			};
			return;
		}
		if (event.event === "error") {
			const failure = parseEvent(event);
			const detail = failure.message ?? failure.error ?? "TRAE raw chat failed";
			throw new LlmError(detail, failure.code === 1001 ? "AUTH" : `TRAE_${failure.code ?? "ERROR"}`);
		}
		if (event.event === "output") {
			const output = parseEvent(event);
			const reasoning = output.reasoning_content;
			if (typeof reasoning === "string" && reasoning.length > 0) {
				if (!reasoningBlock) {
					reasoningBlock = open("reasoning");
					yield {
						type: "block-start",
						index: reasoningBlock.index,
						blockType: "reasoning"
					};
				}
				reasoningBlock.text += reasoning;
				yield {
					type: "reasoning-delta",
					index: reasoningBlock.index,
					text: reasoning
				};
			}
			const content = output.response;
			if (typeof content === "string" && content.length > 0) {
				if (!textBlock) {
					textBlock = open("text");
					yield {
						type: "block-start",
						index: textBlock.index,
						blockType: "text"
					};
				}
				textBlock.text += content;
				yield {
					type: "text-delta",
					index: textBlock.index,
					text: content
				};
			}
			for (const call of output.tool_calls ?? []) {
				let block = toolBlocks.get(call.index);
				if (!block) {
					block = open("tool-call");
					toolBlocks.set(call.index, block);
					yield {
						type: "block-start",
						index: block.index,
						blockType: "tool-call"
					};
				}
				if (call.id !== void 0 && call.id.length > 0) block.callId = call.id;
				if (call.function_call?.name !== void 0 && call.function_call.name.length > 0) block.name = call.function_call.name;
				const fragment = call.function_call?.arguments ?? "";
				block.text += fragment;
				yield {
					type: "tool-call-delta",
					index: block.index,
					id: CallId(block.callId ?? ""),
					...block.name !== void 0 ? { name: block.name } : {},
					argumentsDelta: fragment
				};
			}
			continue;
		}
		if (event.event === "token_usage") pendingUsage = mapUsage(parseEvent(event));
	}
	throw new LlmError("TRAE SSE event stream ended without a done event", "STREAM_CLOSED");
}
function parseEvent(event) {
	try {
		return JSON.parse(event.data);
	} catch (cause) {
		throw new LlmError(`malformed TRAE ${event.event} event: ${event.data.slice(0, 120)}`, "MALFORMED_RESPONSE", { cause });
	}
}
//#endregion
//#region lib/types/adapter.js
/**
* TRAE raw-chat transport adapter over credential-kind-aware local authentication.
* @module dsh-llm-trae-plugin/adapter
*/
var __addDisposableResource = function(env, value, async) {
	if (value !== null && value !== void 0) {
		if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
		var dispose, inner;
		if (async) {
			if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
			dispose = value[Symbol.asyncDispose];
		}
		if (dispose === void 0) {
			if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
			dispose = value[Symbol.dispose];
			if (async) inner = dispose;
		}
		if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
		if (inner) dispose = function() {
			try {
				inner.call(this);
			} catch (e) {
				return Promise.reject(e);
			}
		};
		env.stack.push({
			value,
			dispose,
			async
		});
	} else if (async) env.stack.push({ async: true });
	return value;
};
var __disposeResources = (function(SuppressedError) {
	return function(env) {
		function fail(e) {
			env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
			env.hasError = true;
		}
		var r, s = 0;
		function next() {
			while (r = env.stack.pop()) try {
				if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
				if (r.dispose) {
					var result = r.dispose.call(r.value);
					if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
						fail(e);
						return next();
					});
				} else s |= 1;
			} catch (e) {
				fail(e);
			}
			if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
			if (env.hasError) throw env.error;
		}
		return next();
	};
})(typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
	var e = new Error(message);
	return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
/** Default maximum idle interval while one TRAE stream read is outstanding. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
/** Default combined request and response context capacity. */
const DEFAULT_CONTEXT_WINDOW = 2e5;
/** Default per-request output-token cap. */
const DEFAULT_MAX_TOKENS = 32768;
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
function modelInfo(provider, model) {
	return {
		provider,
		id: model.id,
		name: model.name ?? model.id,
		...model.description === void 0 ? {} : { description: model.description },
		inputModalities: ["text", "image"]
	};
}
function wireModel(model, configured) {
	const configName = configured?.configName ?? configured?.id ?? model;
	return {
		configName,
		backendModel: configured?.backendModel ?? `${configName}__dev`
	};
}
function providerRetryAfterMs(value) {
	if (value === null) return void 0;
	if (/^\d+$/.test(value)) {
		const delay = Number(value) * 1e3;
		return Number.isFinite(delay) && delay > 0 ? delay : void 0;
	}
	const delay = Date.parse(value) - Date.now();
	return Number.isFinite(delay) && delay > 0 ? delay : void 0;
}
function requestId(headers) {
	const value = headers.get("x-tt-logid") ?? headers.get("x-request-id");
	return value === null || value.length === 0 ? void 0 : ProviderRequestId(value);
}
function errorDetail(error) {
	if (typeof error?.error === "string") return error.error;
	return [
		error?.error?.code,
		error?.error?.type,
		error?.error?.message,
		error?.message,
		error?.detail
	].filter((value) => typeof value === "string" && value.length > 0).join(" ");
}
/**
* Map a non-success TRAE HTTP response to a stable harness code.
* @param status - HTTP status returned by the TRAE gateway.
* @param error - parsed JSON body when available.
* @returns the provider-neutral failure code.
*/
function httpErrorCode(status, error) {
	if (status === 401 || status === 403) return "AUTH";
	const detail = errorDetail(error);
	if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
	if (status === 429) return "RATE_LIMIT";
	if (status === 400) {
		if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
		return "INVALID_REQUEST";
	}
	if (status >= 500) return "SERVER";
	return `HTTP_${status}`;
}
function reasoningInfo(model) {
	const efforts = model?.reasoningEfforts;
	if (efforts === void 0 || efforts.length === 0) return void 0;
	const defaultEffort = model?.defaultReasoningEffort;
	return {
		efforts: efforts.map((effort) => ({
			id: ReasoningEffortId(effort),
			name: effort === "xhigh" ? "Extra High" : effort.slice(0, 1).toUpperCase() + effort.slice(1)
		})),
		...defaultEffort === void 0 ? {} : { defaultEffort: ReasoningEffortId(defaultEffort) }
	};
}
function flowTraceparent(id) {
	const compact = id.replaceAll("-", "").padEnd(32, "0").slice(0, 32);
	return `00-${compact}-${compact.slice(0, 16)}-01`;
}
/** Direct TRAE raw-chat adapter. */
var TraeAdapter = class extends LlmAdapter {
	config;
	constructor(config) {
		super();
		this.config = config;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "TRAE CLI"
		};
	}
	providerRetryPolicy(_provider) {
		return this.config.options().retryPolicy;
	}
	listModels(provider) {
		return Promise.resolve(this.config.options().models.map((model) => modelInfo(provider, model)));
	}
	resolveModel(provider, model, _signal) {
		const connection = this.config.options();
		const configured = connection.models.find((entry) => entry.id === model);
		const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow;
		const reasoning = reasoningInfo(configured);
		return Promise.resolve({
			...configured === void 0 ? {
				provider,
				id: model,
				name: model,
				inputModalities: ["text", "image"]
			} : modelInfo(provider, configured),
			context: { contextWindow },
			defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
			...reasoning === void 0 ? {} : { reasoning }
		});
	}
	async *stream(options) {
		const env_1 = {
			stack: [],
			error: void 0,
			hasError: false
		};
		try {
			const connection = this.config.options();
			const hasImages = options.messages.some((message) => contentHasImage(message.content));
			let attachments;
			if (hasImages) {
				attachments = this.config.resolveAttachments?.();
				if (attachments === void 0) throw new LlmError("TRAE image conversion requires the durable attachment service.", "UNSUPPORTED_CONTENT");
			}
			const auth = await this.config.resolveAuth(connection);
			const requestId = randomUUID();
			const conversationId = options.sessionId === void 0 ? randomUUID() : String(options.sessionId);
			const consumer = new AbortController();
			const upstream = options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
			const watchdog = __addDisposableResource(env_1, idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE), false);
			const iterator = this.request(options, watchdog.signal, connection, auth, requestId, conversationId, attachments, () => {
				watchdog.pulse();
			})[Symbol.asyncIterator]();
			let exhausted = false;
			try {
				while (true) {
					const result = await watchdog.next(iterator);
					if (result.done) {
						exhausted = true;
						return;
					}
					yield result.value;
				}
			} catch (error) {
				if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== void 0) throw new LlmError(`TRAE stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
				if (options.signal?.aborted) throw new LlmError("TRAE request aborted by caller", "ABORTED", { cause: error });
				if (error instanceof LlmError) throw error;
				throw new LlmError(`TRAE raw-chat stream from ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
			} finally {
				consumer.abort("TRAE stream consumer stopped");
				if (!exhausted && iterator.return !== void 0) try {
					await iterator.return();
				} catch (_abortedTransportTeardown) {}
			}
		} catch (e_1) {
			env_1.error = e_1;
			env_1.hasError = true;
		} finally {
			__disposeResources(env_1);
		}
	}
	async *request(options, signal, connection, auth, operationId, conversationId, attachments, onActivity) {
		const configured = connection.models.find((entry) => entry.id === options.model);
		const identity = {
			requestId: operationId,
			conversationId
		};
		const model = wireModel(options.model, configured);
		const body = attachments === void 0 ? serializeRequest(options, model, identity) : await serializeRequestWithImages(options, model, identity, attachments, signal);
		const url = new URL("/api/ide/v2/llm_raw_chat", connection.baseURL).toString();
		let response;
		try {
			response = await fetch(url, {
				method: "POST",
				headers: {
					...attributionHeaders(),
					[auth.name]: auth.value,
					"accept": "text/event-stream",
					"content-type": "application/json",
					"version": connection.clientVersion,
					"x-app-id": connection.appId,
					"x-ide-function": connection.functionName,
					"x-ide-version-code": connection.versionCode,
					"x-flow-traceparent": flowTraceparent(operationId)
				},
				body: JSON.stringify(body),
				signal
			});
		} catch (cause) {
			throw new LlmError(`TRAE raw-chat request to ${connection.baseURL} failed`, "TRANSPORT", { cause });
		}
		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			let wireError;
			try {
				wireError = JSON.parse(errorText);
			} catch (_nonJsonErrorBody) {}
			const errorOptions = { status: response.status };
			const providerId = requestId(response.headers);
			if (providerId !== void 0) errorOptions.requestId = providerId;
			const retryAfter = providerRetryAfterMs(response.headers.get("retry-after"));
			if (retryAfter !== void 0) errorOptions.providerRetryAfterMs = retryAfter;
			const detail = errorDetail(wireError) || errorText.slice(0, 200) || response.statusText;
			throw new LlmError(`TRAE raw-chat returned HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : ""}`, httpErrorCode(response.status, wireError), errorOptions);
		}
		if (response.body === null) throw new LlmError("TRAE raw-chat returned no response body", "EMPTY_RESPONSE");
		yield* translate(parseSse(response.body, onActivity));
	}
};
//#endregion
//#region lib/types/auth.js
/**
* Read TRAE CLI authentication and derive its credential-kind-specific HTTP header.
* @module dsh-llm-trae-plugin/auth
*/
function credentialKind(value) {
	if (value === void 0) return "cloud_ide_jwt";
	switch (value) {
		case "cloud_ide_jwt":
		case "byte_cloud_jwt":
		case "cloud_cli_jwt":
		case "codebase_user_jwt":
		case "proxy_bearer":
		case "trae_oauth": return value;
		default: throw new LlmError(`llm-trae: TRAE auth file has unsupported credential_kind ${JSON.stringify(value)}`, "UNSUPPORTED_CREDENTIAL");
	}
}
function headerFor(kind, token) {
	switch (kind) {
		case "cloud_ide_jwt":
		case "trae_oauth": return {
			name: "x-ide-token",
			value: token
		};
		case "byte_cloud_jwt": return {
			name: "authorization",
			value: `Byte-Cloud-JWT ${token}`
		};
		case "cloud_cli_jwt": return {
			name: "authorization",
			value: `Cloud-CLI-JWT ${token}`
		};
		case "codebase_user_jwt": return {
			name: "authorization",
			value: `Codebase-User-JWT ${token}`
		};
		case "proxy_bearer": return {
			name: "authorization",
			value: `Bearer ${token}`
		};
	}
}
function assertHeaderValue(header, kind) {
	try {
		new Headers({ [header.name]: header.value });
	} catch (cause) {
		throw new LlmError(`llm-trae: the ${kind} credential cannot be represented as an HTTP header`, "INVALID_CREDENTIAL", { cause });
	}
	return header;
}
/**
* Resolve one request's authentication header from the current TRAE CLI auth file.
* @param path - absolute or process-relative path to the TRAE CLI `auth.json`.
* @param now - current time used for expiry validation.
* @returns the header name and credential-kind-specific value.
*/
async function readTraeAuthHeader(path, now = /* @__PURE__ */ new Date()) {
	let document;
	try {
		document = JSON.parse(await readFile(path, "utf8"));
	} catch (cause) {
		throw new LlmError(`llm-trae: failed to read TRAE authentication from ${path}`, "MISSING_CREDENTIAL", { cause });
	}
	if (document.auth_mode !== void 0 && document.auth_mode !== "trae") throw new LlmError(`llm-trae: ${path} is not configured for TRAE authentication`, "MISSING_CREDENTIAL");
	const token = document.trae?.access_token;
	if (typeof token !== "string" || token.length === 0) throw new LlmError(`llm-trae: ${path} contains no non-empty trae.access_token`, "MISSING_CREDENTIAL");
	const expiresAt = document.trae?.expires_at;
	if (expiresAt !== void 0) {
		if (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) throw new LlmError(`llm-trae: ${path} contains an invalid trae.expires_at`, "INVALID_CREDENTIAL");
		if (Date.parse(expiresAt) <= now.getTime()) throw new LlmError(`llm-trae: TRAE authentication in ${path} has expired; run traecli login`, "AUTH_EXPIRED");
	}
	const kind = credentialKind(document.trae?.credential_kind);
	return assertHeaderValue(headerFor(kind, token), kind);
}
//#endregion
//#region lib/types/catalog.js
/** Discover the current TraeX account model directory and map it to DSH routes. @module dsh-llm-trae-plugin/catalog */
const MAX_COMMAND_OUTPUT_BYTES = 33554432;
const DEFAULT_MAX_TOKENS$1 = 32768;
const REASONING_EFFORTS = /* @__PURE__ */ new Set([
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
]);
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requiredString(value, field) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`dsh-trae: model directory field ${field} must be a non-empty string`);
	return value;
}
function optionalString(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function positiveInteger(value, field) {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`dsh-trae: model directory field ${field} must be a positive integer`);
	return value;
}
function reasoningEfforts(value) {
	if (!Array.isArray(value)) return [];
	const efforts = [];
	for (const item of value) {
		const effort = isRecord(item) ? item.effort : item;
		if (typeof effort !== "string" || !REASONING_EFFORTS.has(effort)) continue;
		if (!efforts.includes(effort)) efforts.push(effort);
	}
	return efforts;
}
function modelRoute(id, configName, backendModel, contextWindow, description, efforts, defaultEffort, max) {
	const selectedDefault = typeof defaultEffort === "string" && efforts.includes(defaultEffort) ? defaultEffort : void 0;
	return {
		id,
		configName,
		backendModel,
		name: max ? `${id.slice(0, -4)} MAX` : id,
		...description === void 0 ? {} : { description: max ? `MAX variant. ${description}` : description },
		contextWindow,
		maxTokens: DEFAULT_MAX_TOKENS$1,
		...efforts.length === 0 ? {} : { reasoningEfforts: efforts },
		...selectedDefault === void 0 ? {} : { defaultReasoningEffort: selectedDefault }
	};
}
/**
* Convert one TraeX `debug models`/`models_cache.json` document to DSH routes.
* @param value - parsed external JSON document.
* @param includeMax - whether advertised MAX variants become separate selectors.
* @returns standard and optional MAX routes in TraeX priority order.
*/
function catalogFromTraeDocument(value, includeMax = true) {
	if (!isRecord(value) || !Array.isArray(value.models)) throw new Error("dsh-trae: model directory must contain a models array");
	const result = [];
	const seen = /* @__PURE__ */ new Set();
	for (const raw of value.models) {
		if (!isRecord(raw)) throw new Error("dsh-trae: every model directory entry must be an object");
		const model = raw;
		if (model.supported_in_api === false || model.visibility !== void 0 && model.visibility !== "list") continue;
		const id = requiredString(model.slug, "slug");
		const configName = requiredString(model.config_name, `${id}.config_name`);
		const metadata = isRecord(model.business_metadata) ? model.business_metadata : {};
		const variants = isRecord(metadata.variants) ? metadata.variants : {};
		const contextWindow = positiveInteger(variants.standard_context_window ?? model.context_window, `${id}.context_window`);
		const standardBackend = optionalString(variants.standard_key) ?? `${configName}__dev`;
		const standardEfforts = reasoningEfforts(variants.standard_supported_reasoning_levels ?? model.supported_reasoning_levels);
		const standard = modelRoute(id, configName, standardBackend, contextWindow, optionalString(model.description), standardEfforts, variants.standard_default_reasoning_level ?? model.default_reasoning_level, false);
		if (seen.has(standard.id)) throw new Error(`dsh-trae: duplicate model selector ${JSON.stringify(standard.id)}`);
		seen.add(standard.id);
		result.push(standard);
		const maxBackend = optionalString(variants.max_key);
		if (!includeMax || maxBackend === void 0) continue;
		const maxId = `${id}-max`;
		if (seen.has(maxId)) throw new Error(`dsh-trae: duplicate model selector ${JSON.stringify(maxId)}`);
		const maxContextWindow = positiveInteger(variants.max_context_window, `${id}.max_context_window`);
		const maxEfforts = reasoningEfforts(variants.max_supported_reasoning_levels);
		seen.add(maxId);
		result.push(modelRoute(maxId, configName, maxBackend, maxContextWindow, optionalString(model.description), maxEfforts, variants.max_default_reasoning_level, true));
	}
	if (result.length === 0) throw new Error("dsh-trae: model directory contains no API-visible models");
	return result;
}
const nodeCommandRunner = (command, args, environment) => {
	const result = spawnSync(command, [...args], {
		encoding: "utf8",
		env: environment,
		maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
		stdio: [
			"ignore",
			"pipe",
			"ignore"
		]
	});
	return {
		status: result.status,
		stdout: result.stdout,
		...result.error === void 0 ? {} : { error: result.error }
	};
};
function commandCatalog(command, environment, runCommand) {
	const result = runCommand(command, [
		"-c",
		"cli_auth_credentials_store=file",
		"debug",
		"models"
	], environment);
	if (result.error !== void 0 || result.status !== 0 || result.stdout.trim().length === 0) return void 0;
	try {
		return {
			source: `${command} -c cli_auth_credentials_store=file debug models`,
			models: catalogFromTraeDocument(JSON.parse(result.stdout))
		};
	} catch {
		return;
	}
}
function cacheCandidates(environment) {
	const candidates = [];
	const traeCliHome = environment.TRAECLI_HOME?.trim();
	const traeHome = environment.TRAE_HOME?.trim();
	const home = environment.HOME?.trim() || homedir();
	if (traeCliHome) candidates.push(join(traeCliHome, "models_cache.json"));
	if (traeHome) {
		candidates.push(join(traeHome, "cli", "models_cache.json"));
		candidates.push(join(traeHome, "model-provider", "trae", "models_cache.json"));
	}
	candidates.push(join(home, ".trae", "cli", "models_cache.json"));
	candidates.push(join(home, ".trae", "model-provider", "trae", "models_cache.json"));
	return [...new Set(candidates)];
}
/**
* Discover the current account catalog from TraeX, falling back to local caches.
* @param options - command, cache, environment, and MAX-variant controls.
* @returns source description and mapped DSH routes.
*/
async function discoverTraeCatalog(options = {}) {
	const environment = options.environment ?? process.env;
	const includeMax = options.includeMax ?? true;
	const runCommand = options.runCommand ?? nodeCommandRunner;
	const commands = options.traexBin === void 0 ? ["traex", "traecli"] : [options.traexBin];
	if (options.cachePath === void 0) for (const command of commands) {
		const discovered = commandCatalog(command, environment, runCommand);
		if (discovered !== void 0) return {
			source: discovered.source,
			models: includeMax ? discovered.models : discovered.models.filter((model) => !model.id.endsWith("-max"))
		};
	}
	const candidates = options.cachePath === void 0 ? cacheCandidates(environment) : [options.cachePath];
	for (const path of candidates) try {
		return {
			source: path,
			models: catalogFromTraeDocument(JSON.parse(await readFile(path, "utf8")), includeMax)
		};
	} catch (error) {
		if (options.cachePath !== void 0) throw new Error(`dsh-trae: failed to read model cache ${path}`, { cause: error });
	}
	throw new Error("dsh-trae: no TraeX model directory found; run \"traex debug models\" or pass --models-cache");
}
//#endregion
//#region lib/types/index.js
/**
* Register a {@link TraeAdapter} for the `trae-official` provider route on
* `ctx.llm`. Connection facts resolve per operation, and authentication is
* reread from the TRAE CLI auth file for every model request.
* @module @ad/dsh-llm-trae-plugin
*/
const name = "llm-trae";
const inject = ["llm"];
const NS = settingsNamespace("llm-trae");
const PROVIDER = "trae-official";
const DEFAULT_MODELS = [
	{
		id: "Doubao-Seed-2.1-Pro",
		name: "Doubao Seed 2.1 Pro",
		description: "TRAE preset with a 184K context window.",
		contextWindow: 184e3,
		maxTokens: DEFAULT_MAX_TOKENS
	},
	{
		id: "Doubao-Seed-2.1-Turbo",
		name: "Doubao Seed 2.1 Turbo",
		description: "Faster TRAE preset with a 184K context window.",
		contextWindow: 184e3,
		maxTokens: DEFAULT_MAX_TOKENS
	},
	{
		id: "DeepSeek-V4-Flash",
		name: "DeepSeek V4 Flash",
		description: "TRAE DeepSeek preset with reasoning and a 200K context window.",
		contextWindow: 2e5,
		maxTokens: DEFAULT_MAX_TOKENS,
		reasoningEfforts: [
			"low",
			"medium",
			"high"
		],
		defaultReasoningEffort: "high"
	},
	{
		id: "DeepSeek-V4-Pro",
		name: "DeepSeek V4 Pro",
		description: "TRAE DeepSeek Pro preset with reasoning and a 200K context window.",
		contextWindow: 2e5,
		maxTokens: DEFAULT_MAX_TOKENS,
		reasoningEfforts: [
			"low",
			"medium",
			"high"
		],
		defaultReasoningEffort: "high"
	}
];
const catalogModel = z.object({
	id: z.string().required(),
	configName: z.string(),
	backendModel: z.string(),
	name: z.string(),
	description: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
	reasoningEfforts: z.array(z.union([
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	])),
	defaultReasoningEffort: z.union([
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	])
});
const Config = z.object({
	baseURL: z.string(),
	authPath: z.string(),
	appId: z.string().default("6eefa01c-1036-4c7e-9ca5-d891f63bfcd8"),
	functionName: z.string().default("traecli_next"),
	versionCode: z.string(),
	clientVersion: z.string().default("dsh-llm-trae-plugin/0.1"),
	maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
	defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
	models: z.array(catalogModel).default(DEFAULT_MODELS),
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	retryPolicy: RetryPolicySchema
});
/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models) {
	const seen = /* @__PURE__ */ new Set();
	return (models ?? DEFAULT_MODELS).map((model) => {
		if (model.id.length === 0) throw new Error("llm-trae: catalog model ids must be non-empty");
		if (model.name !== void 0 && model.name.length === 0) throw new Error(`llm-trae: catalog model "${model.id}" has an empty name`);
		if (model.configName !== void 0 && model.configName.length === 0) throw new Error(`llm-trae: catalog model "${model.id}" has an empty configName`);
		if (model.backendModel !== void 0 && model.backendModel.length === 0) throw new Error(`llm-trae: catalog model "${model.id}" has an empty backendModel`);
		if (model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) throw new Error(`llm-trae: catalog model "${model.id}" contextWindow must be a positive integer`);
		if (model.maxTokens !== void 0 && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) throw new Error(`llm-trae: catalog model "${model.id}" maxTokens must be a positive integer`);
		if (seen.has(model.id)) throw new Error(`llm-trae: duplicate catalog model "${model.id}"`);
		seen.add(model.id);
		const efforts = model.reasoningEfforts;
		if (efforts !== void 0 && new Set(efforts).size !== efforts.length) throw new Error(`llm-trae: catalog model "${model.id}" has duplicate reasoning efforts`);
		if (model.defaultReasoningEffort !== void 0 && !efforts?.includes(model.defaultReasoningEffort)) throw new Error(`llm-trae: catalog model "${model.id}" defaultReasoningEffort must appear in reasoningEfforts`);
		return {
			id: model.id,
			...model.configName === void 0 ? {} : { configName: model.configName },
			...model.backendModel === void 0 ? {} : { backendModel: model.backendModel },
			...model.name === void 0 ? {} : { name: model.name },
			...model.description === void 0 ? {} : { description: model.description },
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
			...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
			...efforts === void 0 ? {} : { reasoningEfforts: [...efforts] },
			...model.defaultReasoningEffort === void 0 ? {} : { defaultReasoningEffort: model.defaultReasoningEffort }
		};
	});
}
const BASE_URL_ENV = "TRAE_API_BASE_URL";
const AUTH_PATH_ENV = "TRAE_AUTH_PATH";
function environmentValue(environment, name) {
	const value = environment?.get(name)?.value.trim();
	return value === void 0 || value.length === 0 ? void 0 : value;
}
function defaultAuthPath(environment) {
	const explicit = environmentValue(environment, AUTH_PATH_ENV);
	if (explicit !== void 0) return explicit;
	const traeCliHome = environmentValue(environment, "TRAECLI_HOME");
	if (traeCliHome !== void 0) return join(traeCliHome, "auth.json");
	const traeHome = environmentValue(environment, "TRAE_HOME");
	return join(traeHome ?? join(homedir(), ".trae"), "cli", "auth.json");
}
function localVersionCode(now = /* @__PURE__ */ new Date()) {
	return `${String(now.getFullYear()).padStart(4, "0")}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
}
function nonEmpty(value, field) {
	if (value === void 0) return void 0;
	if (value.trim().length === 0) throw new Error(`llm-trae: ${field} must be non-empty`);
	return value.trim();
}
function baseURL(value) {
	let parsed;
	try {
		parsed = new URL(value);
	} catch (cause) {
		throw new Error("llm-trae: baseURL must be an absolute URL", { cause });
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("llm-trae: baseURL must use http or https");
	if (parsed.username.length > 0 || parsed.password.length > 0) throw new Error("llm-trae: baseURL must not contain credentials");
	const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
	if (parsed.protocol === "http:" && !loopback) throw new Error("llm-trae: baseURL must use https unless it targets loopback");
	return value.replace(/\/+$/, "");
}
/**
* Resolve and validate one operation's complete TRAE connection facts.
* @param config - Cordis entry config or current settings snapshot.
* @param environment - trusted launch environment used for endpoint and path fallbacks.
* @returns detached connection, model, surface, timeout, and retry facts.
*/
function resolveAdapterOptions(config, environment) {
	if (config.defaultContextWindow !== void 0 && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) throw new Error("llm-trae: defaultContextWindow must be a positive integer");
	if (config.maxTokens !== void 0 && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) throw new Error("llm-trae: maxTokens must be a positive safe integer");
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 3e5;
	if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`llm-trae: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	return {
		baseURL: baseURL(nonEmpty(config.baseURL, "baseURL") ?? environmentValue(environment, BASE_URL_ENV) ?? "https://copilot-cn.bytedance.net"),
		authPath: nonEmpty(config.authPath, "authPath") ?? defaultAuthPath(environment),
		appId: nonEmpty(config.appId, "appId") ?? "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
		functionName: nonEmpty(config.functionName, "functionName") ?? "traecli_next",
		versionCode: nonEmpty(config.versionCode, "versionCode") ?? localVersionCode(),
		clientVersion: nonEmpty(config.clientVersion, "clientVersion") ?? "dsh-llm-trae-plugin/0.1",
		maxTokens: config.maxTokens ?? 32768,
		defaultContextWindow: config.defaultContextWindow ?? 2e5,
		models: resolveModels(config.models),
		streamIdleTimeoutMs,
		retryPolicy: resolveRetryPolicy(config.retryPolicy, "llm-trae: retryPolicy")
	};
}
function apply(ctx, config) {
	let current = () => config;
	let lastRaw;
	let lastGood;
	const options = () => {
		const raw = current();
		if (raw === lastRaw && lastGood !== void 0) return lastGood;
		try {
			const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx));
			lastRaw = raw;
			lastGood = next;
			return next;
		} catch (error) {
			if (lastGood === void 0) throw error;
			lastRaw = raw;
			ctx.logger.error("llm-trae: keeping the last good configuration after an invalid settings section");
			ctx.logger.error(error);
			return lastGood;
		}
	};
	options();
	const adapter = new TraeAdapter({
		options,
		resolveAuth: (connection) => readTraeAuthHeader(connection.authPath),
		resolveAttachments: () => ctx.get?.("attachments")
	});
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: "TRAE",
		settingsNs: NS,
		settingsPath: []
	}]);
	const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
	let registeredPolicy = options().retryPolicy;
	const ensureRegistrationFacts = () => {
		const policy = options().retryPolicy;
		if (deepEqualJson(policy, registeredPolicy)) return;
		registration.replace([PROVIDER]);
		registeredPolicy = policy;
	};
	installSettingsSection(ctx, NS, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: ensureRegistrationFacts
	});
}
//#endregion
export { Config, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS, TraeAdapter, apply, catalogFromTraeDocument, discoverTraeCatalog, inject, name, readTraeAuthHeader, resolveAdapterOptions };
