import type { Hunk } from '../types';

export function normalizeReviewPath(uri: string): string | undefined {
  try {
    const decoded = decodeURIComponent(uri).replace(/\\/g, '/').replace(/^\.\//, '');
    if (!decoded || decoded.includes('\0') || /^(\/|[a-z][a-z0-9+.-]*:)/i.test(decoded)) return undefined;
    if (decoded.split('/').some(part => part === '..' || part === '.')) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

export function matchingHunks(
  hunks: Hunk[], location: { path: string; startLine: number; endLine: number; side: 'base' | 'candidate' },
): string[] {
  return hunks.filter(hunk => {
    if (hunk.path !== location.path) return false;
    let line = location.side === 'base' ? hunk.oldStart : hunk.newStart;
    const changed = location.side === 'base' ? '-' : '+';
    const opposite = changed === '-' ? '+' : '-';
    for (const entry of hunk.lines) {
      if (entry.startsWith(opposite) || entry.startsWith('\\')) continue;
      if (entry.startsWith(changed) && line >= location.startLine && line <= location.endLine) return true;
      line++;
    }
    return false;
  }).map(hunk => hunk.id);
}

/** Translate full-proposal diff coordinates onto the accepted-only candidate. */
export function reviewCoordinates(hunks: Hunk[], path: string, side: 'base' | 'candidate'): Hunk[] {
  const fileHunks = hunks.filter(hunk => hunk.path === path).sort((a, b) => a.newStart - b.newStart);
  if (side === 'base') return fileHunks;
  let omittedDelta = 0;
  return fileHunks.flatMap(hunk => {
    if (hunk.decision === 'accepted') return [{ ...hunk, newStart: hunk.newStart - omittedDelta }];
    omittedDelta += hunk.newLines - hunk.oldLines;
    return [];
  });
}
