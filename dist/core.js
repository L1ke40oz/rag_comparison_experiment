// All positions use JavaScript UTF-16 offsets, so text.slice(start, end)
// always recovers the exact source. Sizes count Unicode code points.
export const charCount = (text) => Array.from(text).length;

function boundaries(text) {
  const offsets = [0];
  for (const char of text) offsets.push(offsets.at(-1) + char.length);
  return offsets;
}

function splitSpans(text, start, end, limit, separators) {
  const section = text.slice(start, end);
  if (charCount(section) <= limit) return [{ start, end }];
  if (!separators.length) {
    const offsets = boundaries(section);
    const pieces = [];
    for (let i = 0; i < offsets.length - 1; i += limit) {
      pieces.push({ start: start + offsets[i], end: start + offsets[Math.min(i + limit, offsets.length - 1)] });
    }
    return pieces;
  }
  const [separator, ...rest] = separators;
  const cuts = [...section.matchAll(separator)].map((match) => match.index + match[0].length).filter((cut) => cut > 0 && cut < section.length);
  if (!cuts.length) return splitSpans(text, start, end, limit, rest);
  const result = [];
  let previous = start;
  for (const cut of [...cuts.map((value) => start + value), end]) {
    result.push(...splitSpans(text, previous, cut, limit, rest));
    previous = cut;
  }
  return result;
}

function pack(text, atoms, size) {
  const result = [];
  let current = null;
  let length = 0;
  for (const atom of atoms) {
    const atomLength = charCount(text.slice(atom.start, atom.end));
    if (current && length + atomLength > size) {
      result.push(current);
      current = null;
      length = 0;
    }
    current = current ? { start: current.start, end: atom.end } : { ...atom };
    length += atomLength;
  }
  if (current) result.push(current);
  return result;
}

export function chunkText(text, { method = "recursive", size = 320, overlap = 60 } = {}) {
  if (typeof text !== "string") throw new Error("请输入文本。");
  if (!Number.isInteger(size) || size < 1 || size > 5000) throw new Error("块大小必须是 1–5000 的整数。");
  if (!["fixed", "sentence", "recursive"].includes(method)) throw new Error("未知的切分方法。");
  if (method === "fixed" && (!Number.isInteger(overlap) || overlap < 0 || overlap >= size)) throw new Error("重叠长度必须是非负整数，且小于块大小。");
  if (!text.trim()) return [];
  let spans;
  if (method === "fixed") {
    spans = [];
    const offsets = boundaries(text);
    const total = offsets.length - 1;
    for (let i = 0; i < total; i += size - overlap) {
      const end = Math.min(i + size, total);
      spans.push({ start: offsets[i], end: offsets[end] });
      if (end === total) break;
    }
  } else {
    const sentences = /[。！？!?]+[”’"']?[ \t\r\n]*|\.(?=\s|$)[ \t\r\n]*/g;
    const separators = method === "sentence" ? [sentences] : [/(?:\r?\n[ \t]*){2,}/g, /\r?\n/g, sentences];
    spans = pack(text, splitSpans(text, 0, text.length, size, separators), size);
  }
  return spans.map((span, index) => ({ id: index + 1, ...span, text: text.slice(span.start, span.end), chars: charCount(text.slice(span.start, span.end)) }));
}

export function normalizeVector(vector) {
  if (!Array.isArray(vector) || !vector.length || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) throw new Error("API 返回的向量格式无效。");
  let norm = 0;
  for (const value of vector) norm = Math.hypot(norm, value);
  if (!Number.isFinite(norm) || norm === 0) throw new Error("API 返回了无效或全零向量。");
  return vector.map((value) => value / norm);
}

export function rankChunks(chunks, embeddings, queryEmbedding, topK = 3) {
  if (!Number.isInteger(topK) || topK < 1) throw new Error("Top-K 必须为正整数。");
  if (!chunks.length || chunks.length !== embeddings.length) throw new Error("请先为当前切分结果建立索引。");
  const query = normalizeVector(queryEmbedding);
  return chunks.map((chunk, index) => {
    const vector = normalizeVector(embeddings[index]);
    if (vector.length !== query.length) throw new Error("向量维度不一致，请用同一个模型重新建立索引。");
    const score = Math.max(-1, Math.min(1, vector.reduce((sum, value, i) => sum + value * query[i], 0)));
    return { ...chunk, score };
  }).sort((a, b) => b.score - a.score || a.id - b.id).slice(0, topK);
}
