import test from "node:test";
import assert from "node:assert/strict";
import {
  rerankEndpoint,
  validateRerankConfig,
  decodeRerank,
  requestRerank,
} from "../dist/api.js";
import { rerankCandidates } from "../dist/core.js";

const config = {
  baseUrl: "https://rerank.example/v1",
  apiKey: "test-rerank-key",
  model: "test-reranker",
};
const reply = (results) => new Response(JSON.stringify({ results }));

test("rerank supports a base URL or full endpoint with the same URL protections", () => {
  assert.equal(
    rerankEndpoint("https://rerank.example/v1/"),
    "https://rerank.example/v1/rerank",
  );
  assert.equal(
    rerankEndpoint("https://rerank.example/v1/rerank/"),
    "https://rerank.example/v1/rerank",
  );
  for (const baseUrl of [
    "https://user:secret@rerank.example",
    "https://rerank.example?key=secret",
    "http://rerank.example",
    "invalid",
  ])
    assert.throws(() => rerankEndpoint(baseUrl));
  assert.throws(
    () => validateRerankConfig({ ...config, apiKey: "" }),
    /Rerank 设置/,
  );
  assert.throws(
    () => validateRerankConfig({ ...config, model: "" }),
    /Rerank 模型/,
  );
  assert.throws(() =>
    validateRerankConfig({ ...config, apiKey: "line\nbreak" }),
  );
});

test("rerank requests send only candidates and ask for all scores for comparison", async () => {
  const results = await requestRerank(
    config,
    "which?",
    ["first", "second", "third"],
    {
      fetchFn: async (url, options) => {
        assert.equal(url, "https://rerank.example/v1/rerank");
        assert.equal(options.headers.Authorization, "Bearer test-rerank-key");
        assert.equal(options.credentials, "omit");
        assert.equal(options.redirect, "error");
        assert.deepEqual(JSON.parse(options.body), {
          model: "test-reranker",
          query: "which?",
          documents: ["first", "second", "third"],
          top_n: 3,
          return_documents: false,
        });
        return reply([
          { index: 0, relevance_score: 0.1 },
          { index: 2, relevance_score: 0.9 },
          { index: 1, relevance_score: 0 },
        ]);
      },
    },
  );
  assert.deepEqual(results, [
    { index: 2, relevanceScore: 0.9 },
    { index: 0, relevanceScore: 0.1 },
    { index: 1, relevanceScore: 0 },
  ]);
});

test("rerank maps candidate positions to chunk IDs and preserves cosine scores", () => {
  const candidates = [
    { id: 9, score: 0.95, text: "a" },
    { id: 2, score: 0.8, text: "b" },
    { id: 17, score: 0.7, text: "c" },
  ];
  const scores = decodeRerank(
    {
      results: [
        { index: 1, relevance_score: 4.5 },
        { index: 2, relevance_score: 10 },
        { index: 0, relevance_score: -1 },
      ],
    },
    3,
  );
  const results = rerankCandidates(candidates, scores);
  assert.deepEqual(
    results.map((r) => r.id),
    [17, 2, 9],
  );
  assert.deepEqual(
    results.map((r) => r.vectorRank),
    [3, 2, 1],
  );
  assert.deepEqual(
    results.map((r) => r.rerankRank),
    [1, 2, 3],
  );
  assert.deepEqual(
    results.map((r) => r.score),
    [0.7, 0.8, 0.95],
  );
  assert.deepEqual(
    results.map((r) => r.rerankScore),
    [10, 4.5, -1],
  );
  assert.ok(candidates.every((candidate) => !("rerankScore" in candidate)));
});

test("rerank refuses partial results, duplicate positions and invalid scores", () => {
  for (const results of [
    [],
    [{ index: 0, relevance_score: 1 }],
    [
      { index: 0, relevance_score: 1 },
      { index: 0, relevance_score: 0 },
    ],
    [
      { index: 0, relevance_score: 1 },
      { index: 2, relevance_score: 0 },
    ],
    [
      { index: 0, relevance_score: "1" },
      { index: 1, relevance_score: 0 },
    ],
    [
      { index: 0, relevance_score: Infinity },
      { index: 1, relevance_score: 0 },
    ],
  ])
    assert.throws(() => decodeRerank({ results }, 2));
  assert.throws(() => decodeRerank({ data: [] }, 2));
});

test("rerank handles tied and zero scores without dropping candidates", () => {
  assert.deepEqual(
    decodeRerank(
      {
        results: [
          { index: 1, relevance_score: 0 },
          { index: 0, relevance_score: 0 },
        ],
      },
      2,
    ),
    [
      { index: 0, relevanceScore: 0 },
      { index: 1, relevanceScore: 0 },
    ],
  );
});

test("rerank input validation, errors and cancellation do not expose provider text", async () => {
  await assert.rejects(requestRerank(config, "", ["doc"]), /问题/);
  await assert.rejects(requestRerank(config, "query", [""]), /非空候选/);
  await assert.rejects(
    requestRerank(config, "query", Array(101).fill("doc")),
    /1–100/,
  );
  await assert.rejects(
    requestRerank(config, "query", ["doc"], {
      fetchFn: async () => new Response("test-rerank-key", { status: 401 }),
    }),
    /HTTP 401.*认证失败/,
  );
  await assert.rejects(
    requestRerank(config, "query", ["doc"], {
      fetchFn: async () => {
        throw new TypeError("test-rerank-key");
      },
    }),
    /网络、CORS/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    requestRerank(config, "query", ["doc"], {
      signal: controller.signal,
      fetchFn: async (_, options) => {
        options.signal.throwIfAborted();
      },
    }),
    /已取消/,
  );
});
