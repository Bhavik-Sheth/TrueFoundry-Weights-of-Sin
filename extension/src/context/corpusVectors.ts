import { tokenize } from './search';
import type { SymbolEntry } from '../types';

// Distributional retrieval in the local symbol corpus. A query term is represented
// by the normalized TF-IDF centroids of excerpts containing it. Neighbouring
// excerpts can therefore rank even when they do not contain the query itself.
type Vector = Map<string, number>;
function normalize(vector: Vector) {
  let sum = 0;
  for (const weight of vector.values()) sum += weight * weight;
  const length = Math.sqrt(sum);
  if (length) for (const [term, weight] of vector) vector.set(term, weight / length);
  return vector;
}
const cache = new WeakMap<SymbolEntry[], { vectors: Vector[]; postings: Map<string, number[]> }>();

export function corpusNeighbors(symbols: SymbolEntry[], terms: string[], limit: number) {
  let index = cache.get(symbols);
  if (!index) {
    const postings = new Map<string, number[]>();
    const vectors = symbols.map((s, i) => {
      const v: Vector = new Map();
      for (const t of tokenize(s.qualifiedName + ' ' + s.text)) v.set(t, (v.get(t) ?? 0) + 1);
      for (const t of v.keys()) {
        const ids = postings.get(t);
        if (ids) ids.push(i); else postings.set(t, [i]);
      }
      return v;
    });
    for (const v of vectors) {
      for (const [t, n] of v) v.set(t, (1 + Math.log(n)) * Math.log((1 + symbols.length) / postings.get(t)!.length));
      normalize(v);
    }
    index = { vectors, postings };
    cache.set(symbols, index);
  }
  const query: Vector = new Map();
  for (const term of new Set(terms.flatMap(tokenize))) {
    const docs = index.postings.get(term);
    if (!docs || docs.length > Math.max(3, symbols.length * 0.25)) continue;
    for (const id of docs) for (const [t, weight] of index.vectors[id]) query.set(t, (query.get(t) ?? 0) + weight / docs.length);
  }
  if (!query.size) return [];
  normalize(query);
  const scores = new Map<number, number>();
  for (const [term, weight] of query) {
    for (const id of index.postings.get(term) ?? []) {
      scores.set(id, (scores.get(id) ?? 0) + weight * (index.vectors[id].get(term) ?? 0));
    }
  }
  return [...scores].filter(([, score]) => score > 0.12)
    .map(([id, score]) => ({ symbol: symbols[id], score }))
    .sort((a, b) => b.score - a.score || a.symbol.id.localeCompare(b.symbol.id)).slice(0, limit);
}
