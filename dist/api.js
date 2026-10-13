import { normalizeVector } from "./core.js";

function apiEndpoint(baseUrl, resource) {
  let url;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new Error("请输入完整的 Base URL。");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Base URL 不能包含用户名、密码、查询参数或片段。");
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback))
    throw new Error("API 地址必须使用 HTTPS；本机开发地址可使用 HTTP。");
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith(`/${resource}`)) url.pathname += `/${resource}`;
  return url.toString();
}

export const embeddingEndpoint = (baseUrl) =>
  apiEndpoint(baseUrl, "embeddings");
export const rerankEndpoint = (baseUrl) => apiEndpoint(baseUrl, "rerank");

export function validateConfig(config) {
  const endpoint = embeddingEndpoint(config.baseUrl);
  if (!config.apiKey?.trim())
    throw new Error("请在 API 设置中填写自己的 API Key。");
  if (!config.model?.trim()) throw new Error("请填写 Embedding 模型 ID。");
  if (/[\r\n]/.test(config.apiKey) || /[\r\n]/.test(config.model))
    throw new Error("API Key 和模型 ID 不能包含换行。");
  return endpoint;
}

export function validateRerankConfig(config) {
  const endpoint = rerankEndpoint(config.baseUrl);
  if (!config.apiKey?.trim())
    throw new Error(
      "请在 Rerank 设置中填写 API Key，或选择复用 embedding 配置。",
    );
  if (!config.model?.trim()) throw new Error("请填写 Rerank 模型 ID。");
  if (/[\r\n]/.test(config.apiKey) || /[\r\n]/.test(config.model))
    throw new Error("API Key 和模型 ID 不能包含换行。");
  return endpoint;
}

// Ask for all candidates, so the UI can compare complete before/after ranks.
export function decodeRerank(body, count) {
  if (!Array.isArray(body?.results) || body.results.length !== count)
    throw new Error("Rerank 返回的结果数量与候选片段数量不一致。");
  const seen = new Set();
  const results = body.results.map((item) => {
    if (
      !Number.isInteger(item.index) ||
      item.index < 0 ||
      item.index >= count ||
      seen.has(item.index)
    )
      throw new Error("Rerank 返回了重复或无效的候选编号。");
    if (
      typeof item.relevance_score !== "number" ||
      !Number.isFinite(item.relevance_score)
    )
      throw new Error("Rerank 返回的相关性分数无效。");
    seen.add(item.index);
    return { index: item.index, relevanceScore: item.relevance_score };
  });
  return results.sort(
    (a, b) => b.relevanceScore - a.relevanceScore || a.index - b.index,
  );
}

// Index fields are checked and reordered: response order is not guaranteed.
export function decodeEmbeddings(body, count) {
  if (!Array.isArray(body?.data) || body.data.length !== count)
    throw new Error("API 返回的向量数量与输入数量不一致。");
  const ordered = Array(count);
  let dimension;
  for (const item of body.data) {
    if (
      !Number.isInteger(item.index) ||
      item.index < 0 ||
      item.index >= count ||
      ordered[item.index]
    )
      throw new Error("API 返回了缺失、重复或无效的向量编号。");
    const vector = normalizeVector(item.embedding);
    dimension ??= vector.length;
    if (vector.length !== dimension)
      throw new Error("API 返回的向量维度不一致。");
    ordered[item.index] = vector;
  }
  return ordered;
}

const statusMessages = {
  400: "请求参数不被接受，请检查模型 ID、文本长度和接口兼容性。",
  401: "认证失败，请检查 API Key。",
  403: "访问被拒绝，请检查模型权限和账号状态。",
  402: "额度不足，或当前模型需要付费。",
  404: "接口或模型不存在，请检查 Base URL 和模型 ID。",
  413: "请求过大，请减小块大小或批次大小。",
  429: "请求被限流，请稍后再试，或减小批次大小。",
};

export async function requestEmbeddings(
  config,
  input,
  { signal, fetchFn = globalThis.fetch, timeoutMs = 45000 } = {},
) {
  const endpoint = validateConfig(config);
  if (
    !Array.isArray(input) ||
    !input.length ||
    !input.every((text) => typeof text === "string" && text.trim())
  )
    throw new Error("不能对空文本建立向量。");
  const body = await requestJson(
    config,
    endpoint,
    {
      model: config.model.trim(),
      input,
      encoding_format: "float",
    },
    { signal, fetchFn, timeoutMs },
  );
  return decodeEmbeddings(body, input.length);
}

async function requestJson(
  config,
  endpoint,
  payload,
  { signal, fetchFn = globalThis.fetch, timeoutMs = 45000 } = {},
) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: combined,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    if (signal?.aborted) throw new DOMException("操作已取消。", "AbortError");
    if (timeout.aborted) throw new Error("请求超时，请检查网络或稍后再试。");
    throw new Error(
      "无法连接 API：可能是网络、CORS 或接口重定向问题。请检查地址，并确认服务允许浏览器跨域调用。",
    );
  }
  if (!response.ok)
    throw new Error(
      `HTTP ${response.status}：${statusMessages[response.status] || "服务暂时不可用，请稍后再试。"}`,
    );
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("API 没有返回有效的 JSON，请检查接口地址。");
  }
  return body;
}

export async function requestRerank(config, query, documents, options = {}) {
  const endpoint = validateRerankConfig(config);
  if (typeof query !== "string" || !query.trim())
    throw new Error("请输入重排序问题。");
  if (
    !Array.isArray(documents) ||
    !documents.length ||
    documents.length > 100 ||
    !documents.every((text) => typeof text === "string" && text.trim())
  )
    throw new Error("Rerank 需要 1–100 个非空候选片段。");
  const body = await requestJson(
    config,
    endpoint,
    {
      model: config.model.trim(),
      query: query.trim(),
      documents,
      top_n: documents.length,
      return_documents: false,
    },
    options,
  );
  return decodeRerank(body, documents.length);
}

export async function embedInBatches(
  config,
  texts,
  { signal, batchSize = 8, onProgress = () => {}, fetchFn } = {},
) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 32)
    throw new Error("批次大小必须为 1–32 的整数。");
  const vectors = [];
  for (let index = 0; index < texts.length; index += batchSize) {
    signal?.throwIfAborted();
    const batch = await requestEmbeddings(
      config,
      texts.slice(index, index + batchSize),
      { signal, fetchFn },
    );
    if (vectors.length && batch[0].length !== vectors[0].length)
      throw new Error("不同批次的向量维度不一致，请重新建立索引。");
    vectors.push(...batch);
    onProgress(vectors.length, texts.length);
  }
  return vectors;
}
