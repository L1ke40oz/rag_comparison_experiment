import test from "node:test";
import assert from "node:assert/strict";
import {
  embeddingEndpoint,
  decodeEmbeddings,
  requestEmbeddings,
  embedInBatches,
} from "../dist/api.js";

const config = {
  baseUrl: "https://provider.example/v1",
  apiKey: "test-only-key",
  model: "test-model",
};
const reply = (data) => new Response(JSON.stringify({ data }), { status: 200 });

test("endpoint accepts bases or full endpoints without double-appending", () => {
  assert.equal(
    embeddingEndpoint("https://provider.example/v1/"),
    "https://provider.example/v1/embeddings",
  );
  assert.equal(
    embeddingEndpoint("https://provider.example/v1/embeddings"),
    "https://provider.example/v1/embeddings",
  );
  assert.equal(
    embeddingEndpoint("http://127.0.0.1:8000/v1"),
    "http://127.0.0.1:8000/v1/embeddings",
  );
  for (const url of [
    "http://provider.example",
    "https://user:pass@provider.example",
    "https://provider.example?key=secret",
    "invalid",
    "file:///v1",
  ])
    assert.throws(() => embeddingEndpoint(url));
});

test("vectors are reordered by index and malformed responses are rejected", () => {
  assert.deepEqual(
    decodeEmbeddings(
      {
        data: [
          { index: 1, embedding: [0, 2] },
          { index: 0, embedding: [3, 0] },
        ],
      },
      2,
    ),
    [
      [1, 0],
      [0, 1],
    ],
  );
  for (const data of [
    [],
    [
      { index: 0, embedding: [1] },
      { index: 0, embedding: [1] },
    ],
    [
      { index: 0, embedding: [1] },
      { index: 1, embedding: [1, 2] },
    ],
    [
      { index: -1, embedding: [1] },
      { index: 1, embedding: [1] },
    ],
  ])
    assert.throws(() => decodeEmbeddings({ data }, 2));
});

test("requests use bearer auth, array input and avoid credentials in the URL", async () => {
  const vectors = await requestEmbeddings(config, ["hello"], {
    fetchFn: async (url, options) => {
      assert.equal(url, "https://provider.example/v1/embeddings");
      assert.equal(options.headers.Authorization, "Bearer test-only-key");
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      assert.deepEqual(JSON.parse(options.body), {
        model: "test-model",
        input: ["hello"],
        encoding_format: "float",
      });
      return reply([{ index: 0, embedding: [3, 4] }]);
    },
  });
  assert.deepEqual(vectors, [[0.6, 0.8]]);
});

test("HTTP and network errors are readable without echoing provider secrets", async () => {
  await assert.rejects(
    requestEmbeddings(config, ["x"], {
      fetchFn: async () =>
        new Response("reflected test-only-key", { status: 401 }),
    }),
    /HTTP 401.*认证失败/,
  );
  await assert.rejects(
    requestEmbeddings(config, ["x"], {
      fetchFn: async () => {
        throw new TypeError("reflected secret");
      },
    }),
    /网络、CORS/,
  );
  await assert.rejects(
    requestEmbeddings(config, ["x"], {
      fetchFn: async () => new Response("not json"),
    }),
    /有效的 JSON/,
  );
});

test("batches preserve input order and report only completed work", async () => {
  const sizes = [],
    progress = [];
  const vectors = await embedInBatches(config, ["a", "b", "c", "d", "e"], {
    batchSize: 2,
    onProgress: (done) => progress.push(done),
    fetchFn: async (_, options) => {
      const input = JSON.parse(options.body).input;
      sizes.push(input.length);
      return reply(
        input
          .map((text, index) => ({ index, embedding: [text.charCodeAt(0), 1] }))
          .reverse(),
      );
    },
  });
  assert.deepEqual(sizes, [2, 2, 1]);
  assert.deepEqual(progress, [2, 4, 5]);
  assert.equal(vectors.length, 5);
  assert.ok(vectors[0][1] > vectors[4][1]);
});

test("cancellation stops later batches and inconsistent dimensions fail", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    embedInBatches(config, ["x"], { signal: controller.signal }),
    /abort/i,
  );
  let call = 0;
  await assert.rejects(
    embedInBatches(config, ["a", "b"], {
      batchSize: 1,
      fetchFn: async () =>
        reply([{ index: 0, embedding: ++call === 1 ? [1] : [1, 2] }]),
    }),
    /不同批次/,
  );
});
