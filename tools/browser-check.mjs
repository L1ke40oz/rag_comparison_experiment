import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const { chromium } = await import(
  process.env.RAG_LAB_PLAYWRIGHT_MODULE || "playwright"
);
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";

const artifacts = fileURLToPath(new URL("../artifacts/", import.meta.url));
await mkdir(artifacts, { recursive: true });
const edgePath = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await chromium.launch({
  executablePath: existsSync(edgePath) ? edgePath : undefined,
  headless: true,
  args: ["--disable-gpu"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1080 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const checks = [];
const check = (name) => {
  checks.push(name);
  console.log("PASS " + name);
};
await page.goto(process.env.RAG_LAB_URL || "http://127.0.0.1:4173/");
await page.waitForFunction(
  () => Number(document.getElementById("chunk-count").textContent) > 0,
);
check("sample document produces chunks on first load");
await page.screenshot({ path: artifacts + "/desktop.png", fullPage: true });
await page.locator(".chunk-foot button").first().click();
assert.ok(await page.locator("#source-content mark").count());
const marked = await page.locator("#source-content mark").innerText();
assert.ok(marked.includes("校园图书馆"));
check("chunk locates exact source span");
await page.locator("#chunks-tab").click();

await page.locator('input[value="fixed"]').check();
assert.equal(await page.locator("#chunk-count").innerText(), "0");
await page.locator("#chunk-size").fill("120");
await page.locator("#chunk-overlap").fill("30");
await page.locator("#split-button").click();
assert.ok(await page.locator(".overlap-text").count());
check(
  "fixed splitting displays overlap and configuration invalidates old chunks",
);
await page.locator('input[value="sentence"]').check();
await page.locator("#split-button").click();
assert.equal(await page.locator(".overlap-text").count(), 0);
check("sentence strategy has no overlap");

await page.locator("#paste-open").click();
await page
  .locator("#paste-text")
  .fill('<img src=x onerror="window.__xss=1">😀 A sentence. Another sentence!');
await page.locator("#paste-form button[type=submit]").click();
assert.equal(await page.evaluate(() => window.__xss), undefined);
assert.equal(await page.locator(".chunk-body img").count(), 0);
check("pasted HTML is rendered as text");
await page.locator("#file-input").setInputFiles({
  name: "invalid.txt",
  mimeType: "text/plain",
  buffer: Buffer.from([0xff, 0xff]),
});
await page.waitForFunction(() =>
  document.getElementById("notice").textContent.includes("UTF-8"),
);
check("non UTF-8 file is rejected");
await page.locator("#file-input").setInputFiles({
  name: "upload.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("上传的测试文本。\n\n第二段测试文字。😀"),
});
await page.waitForFunction(
  () => document.getElementById("document-name").textContent === "upload.txt",
);
check("UTF-8 upload works");

await page.locator("#sample-load").click();
await page.locator('input[value="recursive"]').check();
await page.locator("#chunk-size").fill("320");
await page.locator("#split-button").click();
await page.locator("#search-button").click();
assert.ok(
  (await page.locator("#notice").innerText()).includes(
    "先为当前切分结果建立索引",
  ),
);
check("retrieval without index is blocked clearly");

let mode = "ok";
let delay = false;
let requestCount = 0;
const requests = [];
await page.route("https://embedding.example/**", async (route) => {
  const request = route.request();
  if (request.method() === "OPTIONS") {
    await route.fulfill({
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization,content-type",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
      },
    });
    return;
  }
  requestCount++;
  const body = request.postDataJSON();
  requests.push({ url: request.url(), body });
  assert.equal(
    request.headers()["authorization"],
    "Bearer qa-secret-do-not-leak",
  );
  if (delay) await new Promise((resolve) => setTimeout(resolve, 500));
  if (mode === "401") {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: '{"error":"qa-secret-do-not-leak"}',
    });
    return;
  }
  if (body.documents) {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        results: body.documents.map((_, index) => ({
          index,
          relevance_score: 1 / (index + 1),
        })),
      }),
    });
    return;
  }
  const data = body.input
    .map((text, index) => ({
      index,
      embedding: /VPN|论文数据库/.test(text)
        ? [10, 0, 0]
        : /密码/.test(text)
          ? [0, 10, 0]
          : [0, 0, 10],
    }))
    .reverse();
  try {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ data }),
    });
  } catch {
    /* an intentionally cancelled request */
  }
});

await page.locator("#api-open").click();
await page.locator("#provider").selectOption("custom");
await page.locator("#base-url").fill("https://embedding.example/v1");
await page.locator("#api-key").fill("qa-secret-do-not-leak");
await page.locator("#model-id").fill("qa-model");
await page.locator("#batch-size").fill("2");
await page.locator("#api-test").click();
await page.waitForFunction(() =>
  document.getElementById("api-test-status").textContent.includes("连接成功"),
);
check("connection test validates actual vector response");
await page.locator("#api-form button[type=submit]").click();
await page.locator("#index-button").click();
await page.waitForFunction(() =>
  document.getElementById("index-summary").textContent.includes("已就绪"),
);
assert.ok(requests.some((request) => request.body.input.length === 2));
check("batched indexing accepts out-of-order API response");
await page.locator("#search-button").click();
await page.waitForSelector(".result-card");
assert.equal(await page.locator(".result-card").count(), 3);
assert.ok(
  (await page.locator(".result-card").first().innerText()).includes("VPN"),
);
assert.ok(
  (await page.locator(".result-score").first().innerText()).includes("1.0000"),
);
check("query calls API and cosine ranking returns expected evidence");

const downloadPromise = page.waitForEvent("download");
await page.locator("#export-button").click();
const download = await downloadPromise;
const content = await readFile(await download.path(), "utf8");
assert.ok(!content.includes("qa-secret-do-not-leak"));
const exported = JSON.parse(content);
assert.equal(exported.retrieval.results.length, 3);
assert.equal(exported.embedding.model, "qa-model");
assert.equal(
  await page.evaluate(() => localStorage.length + sessionStorage.length),
  0,
);
check(
  "export contains experiment results but no key; browser storage remains empty",
);
await page.screenshot({ path: artifacts + "/retrieval.png", fullPage: true });

const before = requestCount;
await page.locator(".example-query").first().click();
await page.locator("#search-button").click();
await page.waitForSelector(".result-card");
assert.equal(requestCount, before + 1);
check("subsequent query reuses chunk index");

let rerankMode = "ok",
  rerankDelay = false,
  rerankRequests = 0;
await page.route("https://rerank.example/**", async (route) => {
  const request = route.request();
  if (request.method() === "OPTIONS") {
    await route.fulfill({
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization,content-type",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
      },
    });
    return;
  }
  rerankRequests++;
  const body = request.postDataJSON();
  assert.equal(request.headers().authorization, "Bearer qa-rerank-secret");
  assert.equal(body.top_n, body.documents.length);
  assert.equal(body.return_documents, false);
  if (rerankDelay) await new Promise((resolve) => setTimeout(resolve, 500));
  let results = body.documents.map((_, index) => ({
    index,
    relevance_score:
      index === body.documents.length - 1 ? 0.99 : 0.1 + index / 100,
  }));
  if (rerankMode === "malformed")
    results = results.map((result) => ({ ...result, index: 0 }));
  try {
    await route.fulfill({
      status: rerankMode === "401" ? 401 : 200,
      contentType: "application/json",
      body:
        rerankMode === "401"
          ? '{"error":"qa-rerank-secret"}'
          : JSON.stringify({ results }),
    });
  } catch {
    /* intentionally cancelled request */
  }
});
await page.locator("#rerank-open").click();
await page.locator("#rerank-provider").selectOption("custom");
await page.locator("#rerank-base-url").fill("https://rerank.example/v1");
await page.locator("#rerank-key").fill("qa-rerank-secret");
await page.locator("#rerank-model").fill("qa-reranker");
await page.locator("#rerank-test").click();
await page.waitForFunction(() =>
  document
    .getElementById("rerank-test-status")
    .textContent.includes("连接成功"),
);
assert.ok(
  (await page.locator("#index-summary").innerText()).includes("已就绪"),
);
await page.locator("#rerank-form button[type=submit]").click();
check(
  "independent rerank connection test validates scores without clearing index",
);

await page.locator("#rerank-enabled").check();
await page.locator("#query").fill("在校外怎么访问图书馆的论文数据库？");
const vectorRequestsBeforeRerank = requestCount;
await page.locator("#search-button").click();
await page.waitForSelector("#rank-comparison:not([hidden])");
const candidateCount = Number(await page.locator("#chunk-count").innerText());
assert.equal(await page.locator("#comparison-body tr").count(), candidateCount);
assert.equal(await page.locator(".result-card").count(), 3);
assert.ok(
  (await page.locator(".rank-change").first().innerText()).includes(
    `向量 #${candidateCount} → 重排 #1`,
  ),
);
assert.ok(
  (await page.locator(".result-score").first().innerText()).includes("0.9900"),
);
assert.equal(requestCount, vectorRequestsBeforeRerank + 1);
check(
  "rerank recalls larger candidate set and displays before/after ranks and separate scores",
);
const rerankDownloadPromise = page.waitForEvent("download");
await page.locator("#export-button").click();
const rerankDownload = await rerankDownloadPromise;
const rerankContent = await readFile(await rerankDownload.path(), "utf8");
assert.ok(
  !rerankContent.includes("qa-rerank-secret") &&
    !rerankContent.includes("qa-secret-do-not-leak"),
);
const rerankExport = JSON.parse(rerankContent);
assert.equal(rerankExport.retrieval.status, "reranked");
assert.equal(rerankExport.retrieval.metric, "rerank_relevance_score");
assert.equal(
  rerankExport.retrieval.rerank.rankedCandidates.length,
  candidateCount,
);
assert.equal(
  rerankExport.retrieval.results[0].id,
  rerankExport.retrieval.candidates.at(-1).id,
);
check(
  "rerank export preserves candidate mapping and both score types without either key",
);
await page.screenshot({ path: artifacts + "/rerank.png", fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
assert.ok(
  await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  ),
);
await page.locator("#rerank-open").click();
await page.screenshot({
  path: artifacts + "/mobile-rerank-settings.png",
  fullPage: true,
});
assert.ok(
  await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  ),
);
await page.locator("#rerank-dialog .close-dialog").click();
check("mobile rerank settings and comparison do not overflow the page");
await page.setViewportSize({ width: 1440, height: 1080 });

rerankMode = "401";
await page.locator("#rerank-open").click();
await page.locator("#rerank-test").click();
await page.waitForFunction(() =>
  document
    .getElementById("rerank-test-status")
    .textContent.includes("HTTP 401"),
);
assert.ok(
  !(await page.locator("#rerank-test-status").innerText()).includes(
    "qa-rerank-secret",
  ),
);
await page.locator("#rerank-dialog .close-dialog").click();
await page.locator("#search-button").click();
await page.waitForFunction(() =>
  document
    .getElementById("rerank-outcome")
    .textContent.includes("未完成重排序"),
);
assert.ok(await page.locator("#rank-comparison").isHidden());
assert.equal(await page.locator(".rank-change").count(), 0);
assert.ok(
  (await page.locator(".result-score").first().innerText()).includes(
    "余弦相似度",
  ),
);
check(
  "failed rerank test and search report error and label the preserved vector fallback",
);
rerankMode = "malformed";
await page.locator("#search-button").click();
await page.waitForFunction(() =>
  document.getElementById("rerank-outcome").textContent.includes("重复或无效"),
);
check("malformed rerank results are not displayed as successful reranking");
rerankMode = "ok";

await page.locator("#candidate-count").fill("2");
const requestCountBeforeInvalid = requestCount;
await page.locator("#search-button").click();
assert.ok(
  (await page.locator("#notice").innerText()).includes("不少于最终 Top-K"),
);
assert.equal(requestCount, requestCountBeforeInvalid);
await page.locator("#candidate-count").fill("10");
check("candidate count below final Top-K is rejected before making API calls");

rerankDelay = true;
const beforeDelayedRerank = rerankRequests;
await page.locator("#search-button").click();
await page.waitForFunction(() =>
  document.getElementById("notice").textContent.includes("正在调用 Rerank"),
);
while (rerankRequests === beforeDelayedRerank) await page.waitForTimeout(20);
await page.locator("#rerank-enabled").uncheck();
await page.waitForTimeout(650);
assert.equal(await page.locator(".result-card").count(), 0);
assert.ok(
  (await page.locator("#index-summary").innerText()).includes("已就绪"),
);
rerankDelay = false;
check("turning rerank off cancels an in-flight response and preserves vectors");

await page.locator("#rerank-open").click();
await page.locator("#rerank-share").check();
await page.locator("#rerank-model").fill("qa-shared-reranker");
assert.ok(await page.locator("#rerank-independent").isHidden());
await page.locator("#rerank-test").click();
await page.waitForFunction(() =>
  document
    .getElementById("rerank-test-status")
    .textContent.includes("连接成功"),
);
assert.ok(requests.at(-1).url.endsWith("/rerank"));
await page.locator("#rerank-form button[type=submit]").click();
check(
  "shared connection uses embedding address and key with a separate rerank model",
);

await page.locator("#rerank-open").click();
await page.locator("#rerank-provider").selectOption("jina");
assert.equal(await page.locator("#rerank-key").inputValue(), "");
assert.equal(await page.locator("#rerank-share").isChecked(), false);
await page.locator("#rerank-dialog .close-dialog").click();
check("changing rerank provider clears its independent key and shared mode");

delay = true;
await page.locator("#index-button").click();
await page.locator("#rerank-open").click();
await page.locator("#rerank-model").fill("another-reranker");
await page.locator("#rerank-dialog .close-dialog").click();
await page.waitForFunction(() =>
  document.getElementById("index-summary").textContent.includes("已就绪"),
);
delay = false;
check(
  "editing rerank settings does not cancel unrelated in-flight embedding indexing",
);

await page.locator("#api-open").click();
await page.locator("#model-id").fill("qa-model-2");
assert.equal(await page.locator("#index-summary").innerText(), "未建立");
assert.equal(await page.locator(".result-card").count(), 0);
await page.locator("#api-form button[type=submit]").click();
check("API model change invalidates vectors and results");

delay = true;
await page.locator("#index-button").click();
await page.locator('input[value="fixed"]').check();
await page.waitForTimeout(650);
assert.equal(await page.locator("#index-summary").innerText(), "未建立");
assert.equal(await page.locator("#chunk-count").innerText(), "0");
delay = false;
check("in-flight index response cannot overwrite a newer configuration");

await page.locator("#chunk-size").fill("320");
await page.locator("#split-button").click();
mode = "401";
await page.locator("#index-button").click();
await page.waitForFunction(() =>
  document.getElementById("notice").textContent.includes("HTTP 401"),
);
assert.ok(
  !(await page.locator("#notice").innerText()).includes(
    "qa-secret-do-not-leak",
  ),
);
assert.equal(await page.locator("#index-summary").innerText(), "未建立");
check("API auth error is readable and does not reflect secret");

await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: artifacts + "/mobile.png", fullPage: true });
assert.ok(
  await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  ),
);
await page.locator("#api-open").click();
assert.ok(
  await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  ),
);
await page.screenshot({
  path: artifacts + "/mobile-settings.png",
  fullPage: true,
});
check("mobile page and settings have no horizontal overflow");
await page.locator("#api-dialog .close-dialog").click();
await page.reload();
await page.waitForFunction(
  () => Number(document.getElementById("chunk-count").textContent) > 0,
);
assert.equal(await page.locator("#api-key").inputValue(), "");
assert.equal(await page.locator("#rerank-key").inputValue(), "");
check("refresh clears user key");
assert.deepEqual(errors, []);
check("no browser JavaScript errors");
console.log(
  `Browser verification: ${checks.length} checks passed, ${requestCount} mock API requests.`,
);
await browser.close();
