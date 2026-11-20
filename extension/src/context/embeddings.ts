import { createHash } from 'node:crypto';

async function embed(model: string, documents: string[]): Promise<number[][]> {
  if (!documents.length) return [];
  const response = await fetch('http://127.0.0.1:11434/api/embed', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: documents.map(text => text.slice(0, 3000)) }),
  });
  if (!response.ok) throw new Error('Embedding service returned HTTP ' + response.status);
  const { embeddings } = await response.json() as { embeddings: number[][] };
  if (!Array.isArray(embeddings) || embeddings.length !== documents.length) throw new Error('Incomplete embeddings');
  const dimensions = embeddings[0]?.length;
  return embeddings.map(vector => {
    if (!dimensions || vector.length !== dimensions || !vector.every(Number.isFinite)) throw new Error('Invalid embedding');
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!norm || !Number.isFinite(norm)) throw new Error('Invalid vector norm');
    return vector.map(value => value / norm);
  });
}

// Cache by model and embedded content. Changed symbols receive fresh vectors.
const cache = new Map<string, number[]>();
const capacity = 4096;

export async function semanticOrder(model: string, query: string, documents: string[]): Promise<number[]> {
  if (!documents.length) return [];
  const [needle] = await embed(model, [query]);
  const scores: Array<{ index: number; score: number }> = [];
  for (let start = 0; start < documents.length; start += 32) {
    const batch = documents.slice(start, start + 32);
    const keys = batch.map(text => createHash('sha256').update(JSON.stringify([model, text.slice(0, 3000)])).digest('hex'));
    const vectors = keys.map(key => cache.get(key));
    const missing = batch.flatMap((text, i) => vectors[i] ? [] : [{ text, i }]);
    const fresh = await embed(model, missing.map(item => item.text));
    missing.forEach(({ i }, j) => {
      vectors[i] = fresh[j];
      cache.set(keys[i], fresh[j]);
      if (cache.size > capacity) cache.delete(cache.keys().next().value!);
    });
    vectors.forEach((vector, i) => {
      if (!vector || vector.length !== needle.length) throw new Error('Embedding dimensions changed');
      scores.push({ index: start + i, score: vector.reduce((sum, value, j) => sum + value * needle[j], 0) });
    });
  }
  return scores.sort((a, b) => b.score - a.score).slice(0, 32).map(item => item.index);
}
