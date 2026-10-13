import test from "node:test";
import assert from "node:assert/strict";
import { chunkText, charCount, rankChunks, normalizeVector } from "../dist/core.js";

test("fixed chunks preserve exact source positions and Unicode characters", () => {
  const text = "甲😀乙😀丙丁戊己庚辛";
  const chunks = chunkText(text, { method: "fixed", size: 4, overlap: 1 });
  assert.deepEqual(chunks.map((c) => c.text), ["甲😀乙😀", "😀丙丁戊", "戊己庚辛"]);
  for (const chunk of chunks) assert.equal(chunk.text, text.slice(chunk.start, chunk.end));
  assert.equal(chunks.at(-1).end, text.length);
  assert.equal(charCount(text), 10);
});

test("sentence chunks preserve punctuation, whitespace and unpunctuated tails", () => {
  const text = "甲乙。\n丙丁！戊己\n尾巴";
  const chunks = chunkText(text, { method: "sentence", size: 7 });
  assert.equal(chunks.map((c) => c.text).join(""), text);
  assert.equal(chunks[0].text, "甲乙。\n丙丁！");
  assert.ok(chunks.every((c) => c.chars <= 7));
});

test("recursive splits oversized paragraphs and sentences without losing source", () => {
  const text = "第一段。\r\n\r\n第二段有😀和很长的一句话需要继续拆开。\n第三行。\n\n末尾";
  const chunks = chunkText(text, { method: "recursive", size: 8 });
  assert.equal(chunks.map((c) => c.text).join(""), text);
  assert.ok(chunks.every((c) => c.chars <= 8 && c.chars > 0));
  for (const chunk of chunks) assert.equal(chunk.text, text.slice(chunk.start, chunk.end));
});

test("all splitting methods maintain coverage for many sizes", () => {
  const text = "甲😀乙。\n\n第二段！ Hello world.\nThird line? 无标点末尾";
  for (const method of ["fixed", "sentence", "recursive"]) {
    for (let size = 1; size < 30; size++) {
      const chunks = chunkText(text, { method, size, overlap: 0 });
      assert.equal(chunks.map((c) => c.text).join(""), text);
      assert.ok(chunks.every((c) => c.chars <= size));
      assert.equal(chunks[0].start, 0);
      assert.equal(chunks.at(-1).end, text.length);
    }
  }
});

test("invalid parameters fail and whitespace text produces no chunks", () => {
  assert.throws(() => chunkText("abc", { method: "fixed", size: 3, overlap: 3 }));
  assert.throws(() => chunkText("abc", { size: NaN }));
  assert.throws(() => chunkText("abc", { method: "fake" }));
  assert.deepEqual(chunkText(" \n\t"), []);
});

test("cosine ranking handles non-unit vectors, negative scores and deterministic ties", () => {
  const chunks = [1, 2, 3, 4].map((id) => ({ id }));
  const results = rankChunks(chunks, [[0, 9], [20, 0], [-3, 0], [5, 0]], [8, 0], 4);
  assert.deepEqual(results.map((r) => r.id), [2, 4, 1, 3]);
  assert.deepEqual(results.map((r) => r.score), [1, 1, 0, -1]);
});

test("ranking refuses mixed dimensions, zero vectors and invalid values", () => {
  assert.throws(() => rankChunks([{ id: 1 }], [[1, 2]], [1]));
  assert.throws(() => normalizeVector([0, 0]));
  assert.throws(() => normalizeVector([NaN]));
  assert.throws(() => normalizeVector(["1"]));
  assert.throws(() => rankChunks([{ id: 1 }], [], [1]));
});
