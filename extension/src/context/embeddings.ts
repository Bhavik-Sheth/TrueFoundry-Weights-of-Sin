/** Rerank a bounded retrieval shortlist with a local Ollama embedding model. */
export async function semanticOrder(model: string, query: string, documents: string[]): Promise<number[]> {
  if (!documents.length) return [];
  const response = await fetch('http://127.0.0.1:11434/api/embed', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: [query, ...documents].map(text => text.slice(0, 3000)) }),
  });
  if (!response.ok) throw new Error('Embedding service returned HTTP ' + response.status);
  const { embeddings } = await response.json() as { embeddings: number[][] };
  if (!Array.isArray(embeddings) || embeddings.length !== documents.length + 1) throw new Error('Incomplete embeddings');
  const dimensions = embeddings[0]?.length;
  const normalized = embeddings.map(vector => {
    if (!dimensions || vector.length !== dimensions || !vector.every(Number.isFinite)) throw new Error('Invalid embedding');
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!norm || !Number.isFinite(norm)) throw new Error('Invalid vector norm');
    return vector.map(value => value / norm);
  });
  return normalized.slice(1).map((vector, index) => ({
    index, score: vector.reduce((sum, value, i) => sum + value * normalized[0][i], 0),
  })).sort((a,b) => b.score - a.score).map(item => item.index);
}
