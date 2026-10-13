import { chunkText, charCount, rankChunks } from "./core.js";
import { validateConfig, embeddingEndpoint, requestEmbeddings, embedInBatches } from "./api.js";
import { sample } from "./sample.js";

const $ = (id) => document.getElementById(id);
const labels = { fixed: "固定字符长度", sentence: "按句子聚合", recursive: "段落优先递归" };
const state = { text: sample, name: "校园图书馆使用指南.txt", chunks: [], vectors: null, results: [], splitConfig: null, indexModel: null, controller: null, busy: null, revision: 0, selected: null, lastQuery: null, searchMs: null };
let fileRevision = 0;

function notify(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
  $("notice").hidden = false;
}

function readConfig() {
  return { baseUrl: $("base-url").value.trim(), apiKey: $("api-key").value.trim(), model: $("model-id").value.trim() };
}

function updateConfigBadge() {
  let configured = false;
  try { validateConfig(readConfig()); configured = true; } catch { /* Not configured yet. */ }
  $("api-dot").classList.toggle("ready", configured);
}

function syncControls() {
  const busy = Boolean(state.busy);
  $("split-button").disabled = busy;
  $("index-button").disabled = busy || !state.chunks.length;
  $("index-button").textContent = state.busy === "index" ? "建立中…" : state.vectors ? "重新建立索引 ↗" : "建立索引 ↗";
  $("search-button").disabled = busy;
  $("search-button").textContent = state.busy === "search" ? "检索中…" : "检索 →";
  $("api-test").disabled = busy;
  $("api-test").textContent = state.busy === "test" ? "测试中…" : "测试连接";
  $("export-button").disabled = !state.chunks.length || busy;
}

function updateIndexStatus() {
  const indexed = Boolean(state.vectors);
  $("index-summary").textContent = indexed ? `${state.vectors[0].length} 维 · 已就绪` : "未建立";
  $("index-summary").classList.toggle("muted", !indexed);
  $("index-indicator").classList.toggle("ready", indexed);
  $("index-detail").textContent = indexed ? `${state.chunks.length} 个片段已建立索引，可以开始提问` : state.chunks.length ? "为这些片段生成向量，开始语义检索" : "请先生成切分结果";
  syncControls();
}

function clearResults() {
  state.results = [];
  state.lastQuery = null;
  state.searchMs = null;
  $("results-meta").hidden = true;
  $("results-list").replaceChildren();
  const empty = document.createElement("div");
  empty.className = "results-empty";
  empty.innerHTML = '<span class="empty-art" aria-hidden="true"><i></i><i></i><i></i><b>⌕</b></span><strong>你的第一次检索，从这里开始</strong><p>设置 API 并建立索引后，输入问题查看最相关的文本片段。</p><button class="text-button">配置 embedding API ↗</button>';
  empty.querySelector("button").addEventListener("click", openApi);
  $("results-list").append(empty);
}

function invalidate({ chunks = false } = {}) {
  state.revision++;
  state.controller?.abort();
  state.controller = null;
  state.busy = null;
  state.vectors = null;
  state.indexModel = null;
  if (chunks) {
    state.chunks = [];
    state.splitConfig = null;
    state.selected = null;
    renderChunks();
    renderSource();
  }
  clearResults();
  updateIndexStatus();
}

function splitConfig() {
  const method = document.querySelector('input[name="method"]:checked').value;
  const size = Number($("chunk-size").value);
  const overlap = method === "fixed" ? Number($("chunk-overlap").value) : 0;
  if (!Number.isInteger(size) || size < 50 || size > 2000) throw new Error("块大小请输入 50–2000 的整数。");
  return { method, size, overlap };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderChunks() {
  $("chunk-count").textContent = state.chunks.length;
  $("total-chars").textContent = charCount(state.text).toLocaleString();
  $("average-chars").textContent = state.chunks.length ? `${Math.round(state.chunks.reduce((sum, chunk) => sum + chunk.chars, 0) / state.chunks.length)} 字符` : "—";
  $("method-summary").textContent = state.splitConfig ? labels[state.splitConfig.method] : "待重新切分";
  $("chunks-list").replaceChildren();
  if (!state.chunks.length) {
    $("chunks-list").append(element("div", "empty-chunks", "选择参数后，点击「生成切分结果」观察文本边界。"));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const chunk of state.chunks) {
    const card = element("article", "chunk-card");
    const heading = element("div", "chunk-heading");
    const title = element("div", "chunk-title");
    title.append(element("b", "", String(chunk.id).padStart(2, "0")), document.createTextNode(`CHUNK ${String(chunk.id).padStart(2, "0")}`));
    heading.append(title, element("span", "chunk-position", `UTF-16 [${chunk.start}, ${chunk.end})`));
    const body = element("div", "chunk-body");
    const previous = state.chunks[chunk.id - 2];
    const overlap = previous ? Math.max(0, previous.end - chunk.start) : 0;
    if (overlap) body.append(element("span", "overlap-text", chunk.text.slice(0, overlap)), document.createTextNode(chunk.text.slice(overlap)));
    else body.textContent = chunk.text;
    const foot = element("div", "chunk-foot");
    foot.append(element("span", "", `${chunk.chars} 字符${overlap ? " · 橙色为重叠上下文" : ""}`));
    const locate = element("button", "text-button", "定位原文 ↗");
    locate.addEventListener("click", () => locateChunk(chunk));
    foot.append(locate);
    card.append(heading, body, foot);
    fragment.append(card);
  }
  $("chunks-list").append(fragment);
}

function renderSource() {
  const source = $("source-content");
  source.replaceChildren();
  if (state.selected) {
    const { start, end, id } = state.selected;
    source.append(document.createTextNode(state.text.slice(0, start)), element("mark", "", state.text.slice(start, end)), document.createTextNode(state.text.slice(end)));
    $("source-caption").textContent = `已定位 CHUNK ${String(id).padStart(2, "0")} · UTF-16 [${start}, ${end})`;
  } else {
    source.textContent = state.text;
    $("source-caption").textContent = "点击 chunk 可在原文中定位";
  }
}

function switchTab(source) {
  $("source-view").hidden = !source;
  $("chunks-view").hidden = source;
  $("source-tab").setAttribute("aria-selected", String(source));
  $("chunks-tab").setAttribute("aria-selected", String(!source));
  $("source-tab").classList.toggle("active", source);
  $("chunks-tab").classList.toggle("active", !source);
}

function locateChunk(chunk) {
  state.selected = chunk;
  renderSource();
  switchTab(true);
  requestAnimationFrame(() => {
    const mark = $("source-content").querySelector("mark");
    if (mark) $("source-view").scrollTop += mark.getBoundingClientRect().top - $("source-view").getBoundingClientRect().top - 60;
  });
  $("source-tab").focus({ preventScroll: true });
  $("source-view").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function generateChunks(showNotice = true) {
  try {
    const config = splitConfig();
    if (charCount(state.text) > 50000) throw new Error("第一版支持最多 50,000 字符，请缩短文本。");
    const chunks = chunkText(state.text, config);
    if (!chunks.length) throw new Error("请先导入非空文本。");
    if (chunks.length > 1000) throw new Error("片段数量超过 1000，请增加块大小或减少重叠。");
    invalidate();
    state.chunks = chunks;
    state.splitConfig = config;
    state.selected = null;
    renderChunks();
    renderSource();
    updateIndexStatus();
    switchTab(false);
    if (showNotice) notify(`已生成 ${chunks.length} 个片段。点击「定位原文」查看边界，再建立索引开始检索。`);
  } catch (error) { notify(error.message, true); }
}

function useText(text, name) {
  if (!text.trim()) throw new Error("文本为空，请选择包含文字的文件。");
  if (charCount(text) > 50000) throw new Error("第一版支持最多 50,000 字符，请缩短文本。");
  if (text.includes("\u0000")) throw new Error("文件可能不是 UTF-8 文本，请转换编码后重试。");
  fileRevision++;
  invalidate({ chunks: true });
  state.text = text;
  state.name = name;
  $("document-name").textContent = name;
  $("document-meta").textContent = `${charCount(text).toLocaleString()} 字符 · 当前页面`;
  generateChunks();
}

function openApi() { $("api-dialog").showModal(); }

async function operation(kind, action) {
  if (state.busy) return;
  const controller = new AbortController();
  const revision = state.revision;
  state.controller = controller;
  state.busy = kind;
  syncControls();
  try { await action(controller.signal, () => revision === state.revision && !controller.signal.aborted); }
  catch (error) {
    if (revision !== state.revision || controller.signal.aborted) return;
    if (kind === "test") {
      $("api-test-status").textContent = error.message;
      $("api-test-status").classList.add("error");
    } else notify(error.message, true);
  } finally {
    if (state.controller === controller) {
      state.controller = null;
      state.busy = null;
      updateIndexStatus();
    }
  }
}

function ensureConfig() {
  const config = readConfig();
  try { validateConfig(config); } catch (error) { openApi(); throw error; }
  return config;
}

$("index-button").addEventListener("click", () => {
  let config;
  try { config = ensureConfig(); } catch (error) { notify(error.message, true); return; }
  const batchSize = Number($("batch-size").value);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 32) { notify("批次大小请输入 1–32 的整数。", true); return; }
  // A failed rebuild must not leave the old index looking current.
  state.vectors = null;
  state.indexModel = null;
  clearResults();
  updateIndexStatus();
  operation("index", async (signal, current) => {
    const started = performance.now();
    notify(`正在建立索引：0 / ${state.chunks.length} 个片段。`);
    const chunks = state.chunks.filter((chunk) => chunk.text.trim());
    if (chunks.length !== state.chunks.length) throw new Error("存在仅含空白的片段，请增加块大小或清理文本后重新切分。");
    const vectors = await embedInBatches(config, chunks.map((chunk) => chunk.text), {
      signal, batchSize,
      onProgress: (done, total) => { if (current()) notify(`正在建立索引：${done} / ${total} 个片段。`); },
    });
    if (!current()) return;
    state.vectors = vectors;
    state.indexModel = { baseUrl: embeddingEndpoint(config.baseUrl), model: config.model };
    notify(`索引已就绪：${vectors.length} 个片段，${vectors[0].length} 维向量，耗时 ${((performance.now() - started) / 1000).toFixed(1)} 秒。现在可以输入问题检索。`);
  });
});

function renderResults() {
  $("results-list").replaceChildren();
  $("results-meta").hidden = false;
  $("results-meta").replaceChildren(element("span", "", `找到 ${state.results.length} 个片段 · ${state.indexModel.model}`), element("span", "", `请求与排序耗时 ${(state.searchMs / 1000).toFixed(2)} 秒`));
  for (const [index, result] of state.results.entries()) {
    const card = element("article", "result-card");
    const content = element("div", "");
    const title = element("div", "result-title");
    const locate = element("button", "text-button", "定位原文 ↗");
    locate.addEventListener("click", () => locateChunk(result));
    title.append(document.createTextNode(`CHUNK ${String(result.id).padStart(2, "0")} · ${result.chars} 字符`), locate);
    content.append(title, element("div", "result-text", result.text));
    const score = element("div", "result-score", result.score.toFixed(4));
    score.append(element("span", "", "余弦相似度"));
    const meter = element("div", "score-meter");
    const fill = element("i", "");
    fill.style.width = `${Math.max(0, result.score) * 100}%`;
    meter.append(fill);
    score.append(meter);
    card.append(element("div", "result-rank", String(index + 1).padStart(2, "0")), content, score);
    $("results-list").append(card);
  }
}

$("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state.vectors) { notify("请先为当前切分结果建立索引，再开始检索。", true); return; }
  const query = $("query").value.trim();
  if (!query) { notify("请输入问题。", true); return; }
  let config;
  try { config = ensureConfig(); } catch (error) { notify(error.message, true); return; }
  const topK = Number($("top-k").value);
  clearResults();
  operation("search", async (signal, current) => {
    const started = performance.now();
    const [vector] = await requestEmbeddings(config, [query], { signal });
    if (!current()) return;
    state.results = rankChunks(state.chunks, state.vectors, vector, topK);
    state.lastQuery = query;
    state.searchMs = performance.now() - started;
    renderResults();
    notify(`检索完成，按余弦相似度展示前 ${state.results.length} 个片段。`);
  });
});

$("api-test").addEventListener("click", () => operation("test", async (signal, current) => {
  $("api-test-status").textContent = "正在发送测试文本…";
  $("api-test-status").classList.remove("error");
  const [vector] = await requestEmbeddings(readConfig(), ["这是一条用于测试连接的示例文本。"], { signal });
  if (current()) $("api-test-status").textContent = `连接成功，已收到 ${vector.length} 维向量。`;
}));

$("api-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    validateConfig(readConfig());
    const batch = Number($("batch-size").value);
    if (!Number.isInteger(batch) || batch < 1 || batch > 32) throw new Error("批次大小请输入 1–32 的整数。");
    updateConfigBadge();
    $("api-dialog").close();
    notify("API 配置已填写。密钥仅保留在当前页面；可以测试连接或建立索引。");
  } catch (error) { $("api-test-status").textContent = error.message; $("api-test-status").classList.add("error"); }
});

for (const id of ["base-url", "api-key", "model-id"]) $(id).addEventListener("input", () => {
  invalidate();
  updateConfigBadge();
  $("api-test-status").textContent = "";
  $("notice").hidden = true;
});
$("provider").addEventListener("change", () => {
  invalidate();
  $("api-key").value = "";
  if ($("provider").value === "openrouter") {
    $("base-url").value = "https://openrouter.ai/api/v1";
    $("model-id").value = "liquid/lfm-2.5-embedding-350m:free";
  } else {
    $("base-url").value = "";
    $("model-id").value = "";
  }
  $("api-test-status").textContent = "";
  updateConfigBadge();
});
$("clear-key").addEventListener("click", () => {
  $("api-key").value = "";
  invalidate();
  updateConfigBadge();
  $("api-test-status").textContent = "密钥已清除，旧索引已失效。";
  $("api-test-status").classList.remove("error");
});
$("key-toggle").addEventListener("click", () => {
  const show = $("api-key").type === "password";
  $("api-key").type = show ? "text" : "password";
  $("key-toggle").textContent = show ? "隐藏" : "显示";
  $("key-toggle").setAttribute("aria-label", show ? "隐藏 API Key" : "显示 API Key");
});

for (const id of ["api-open", "empty-api-open"]) $(id).addEventListener("click", openApi);
$("help-open").addEventListener("click", () => $("help-dialog").showModal());
document.querySelectorAll(".close-dialog").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
$("api-dialog").addEventListener("close", () => { $("api-key").type = "password"; $("key-toggle").textContent = "显示"; $("key-toggle").setAttribute("aria-label", "显示 API Key"); });
$("split-button").addEventListener("click", () => generateChunks());
$("chunks-tab").addEventListener("click", () => switchTab(false));
$("source-tab").addEventListener("click", () => switchTab(true));
document.querySelectorAll('[role="tab"]').forEach((tab) => tab.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const source = event.key === "End" || (event.key !== "Home" && tab.id === "chunks-tab");
  switchTab(source);
  $(source ? "source-tab" : "chunks-tab").focus();
}));
$("source-clear").addEventListener("click", () => { state.selected = null; renderSource(); });

function parametersChanged() {
  const method = document.querySelector('input[name="method"]:checked').value;
  $("chunk-overlap").disabled = method !== "fixed";
  $("overlap-hint").textContent = method === "fixed" ? "橙色高亮表示与前一块重叠的上下文。" : "此方法不重叠；超长片段按字符兜底。";
  invalidate({ chunks: true });
  notify("切分配置已改变，请重新生成切分结果并建立索引。");
}
document.querySelectorAll('input[name="method"]').forEach((input) => input.addEventListener("change", parametersChanged));
$("chunk-size").addEventListener("input", () => { $("size-range").value = $("chunk-size").value; parametersChanged(); });
$("size-range").addEventListener("input", () => { $("chunk-size").value = $("size-range").value; parametersChanged(); });
$("chunk-overlap").addEventListener("input", parametersChanged);
$("query").addEventListener("input", () => {
  if (state.busy === "search") { state.revision++; state.controller?.abort(); state.controller = null; state.busy = null; syncControls(); }
  clearResults();
});
$("top-k").addEventListener("change", () => { $("query").dispatchEvent(new Event("input")); });
document.querySelectorAll(".example-query").forEach((button) => button.addEventListener("click", () => {
  $("query").value = button.dataset.query;
  $("query").dispatchEvent(new Event("input"));
  $("query").focus();
}));

$("sample-load").addEventListener("click", () => useText(sample, "校园图书馆使用指南.txt"));
$("paste-open").addEventListener("click", () => { $("paste-text").value = state.text; $("paste-dialog").showModal(); });
$("paste-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try { useText($("paste-text").value, "粘贴的实验文本.txt"); $("paste-dialog").close(); }
  catch (error) { $("paste-text").setCustomValidity(error.message); $("paste-text").reportValidity(); }
});
$("paste-text").addEventListener("input", () => $("paste-text").setCustomValidity(""));
$("file-input").addEventListener("change", async () => {
  const file = $("file-input").files[0];
  const revision = ++fileRevision;
  if (!file) return;
  try {
    if (!file.name.toLowerCase().endsWith(".txt")) throw new Error("请选择 .txt 文件；其他格式可先复制文字后粘贴。");
    if (file.size > 200 * 1024) throw new Error("文件超过 200 KB，请使用更小的文本。");
    const buffer = await file.arrayBuffer();
    if (revision !== fileRevision) return;
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { throw new Error("文件不是有效的 UTF-8 编码，请转换编码后重新上传。"); }
    useText(text, file.name);
  } catch (error) { notify(error.message, true); }
  finally { $("file-input").value = ""; }
});

$("export-button").addEventListener("click", () => {
  const config = readConfig();
  const snapshot = {
    format: "rag-lab-experiment-v1", createdAt: new Date().toISOString(),
    document: { name: state.name, text: state.text, chars: charCount(state.text) },
    chunking: state.splitConfig, chunks: state.chunks,
    embedding: state.indexModel ? { endpoint: state.indexModel.baseUrl, model: state.indexModel.model, dimension: state.vectors[0].length } : { model: config.model, indexed: false },
    retrieval: state.lastQuery ? { query: state.lastQuery, topK: state.results.length, durationMs: Math.round(state.searchMs), metric: "cosine_similarity", results: state.results } : null,
    positionUnit: "UTF-16 code units; end is exclusive", sizeUnit: "Unicode code points",
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }));
  const link = element("a", "");
  link.href = url;
  link.download = `rag-lab-${Date.now()}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify("实验已导出为 JSON，包含原文、切分配置和检索结果，不包含 API Key。");
});

$("document-meta").textContent = `${charCount(state.text).toLocaleString()} 字符 · 当前页面`;
generateChunks(false);
renderSource();
updateConfigBadge();
