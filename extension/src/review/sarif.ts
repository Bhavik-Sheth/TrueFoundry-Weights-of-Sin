import { z } from 'zod';
import { normalizeReviewPath } from './matching';

const artifactLocation = z.object({
  uri: z.string().optional(),
  uriBaseId: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
});

const region = z.object({
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  startColumn: z.number().int().positive().optional(),
  endColumn: z.number().int().positive().optional(),
});

const report = z.object({
  version: z.literal('2.1.0'),
  runs: z.array(z.object({
    tool: z.object({ driver: z.object({ name: z.string() }) }),
    originalUriBaseIds: z.record(z.string(), artifactLocation).optional(),
    artifacts: z.array(z.object({ location: artifactLocation.optional() })).optional(),
    results: z.array(z.object({
      ruleId: z.string().optional(),
      level: z.string().optional(),
      message: z.object({ text: z.string().optional() }),
      partialFingerprints: z.record(z.string(), z.string()).optional(),
      properties: z.object({
        contexoSha256: z.string().optional(),
        contexoSide: z.enum(['base', 'candidate']).optional(),
      }).optional(),
      locations: z.array(z.object({
        physicalLocation: z.object({ artifactLocation: artifactLocation.optional(), region: region.optional() }).optional(),
      })).optional(),
    })).optional(),
  })),
});

export function parseSarif(input: unknown, workspace: string) {
  const workspaceUrl = new URL(workspace.replace(/\/?$/, '/'));
  return report.parse(input).runs.flatMap(run => {
    function resolveUri(location: z.infer<typeof artifactLocation>, visited = new Set<string>()): URL | undefined {
      const indexed = location.index === undefined ? undefined : run.artifacts?.[location.index]?.location;
      const uri = location.uri ?? indexed?.uri;
      const baseId = location.uriBaseId ?? indexed?.uriBaseId;
      if (!uri || (baseId && visited.has(baseId))) return;
      let base: URL | undefined = workspaceUrl;
      if (baseId) {
        const declared = run.originalUriBaseIds?.[baseId];
        if (!declared) return;
        base = resolveUri(declared, new Set([...visited, baseId]));
      }
      if (!base) return;
      try {
        return new URL(uri, base);
      } catch {
        return;
      }
    }
    return (run.results ?? []).flatMap(result =>
      (result.locations?.length ? result.locations : [{}]).map(({ physicalLocation }) => {
        const artifact = physicalLocation?.artifactLocation;
        const url = artifact && resolveUri(artifact);
        const path = url?.protocol === workspaceUrl.protocol && url.hostname === workspaceUrl.hostname &&
          url.pathname.startsWith(workspaceUrl.pathname)
          ? normalizeReviewPath(url.pathname.slice(workspaceUrl.pathname.length)) : undefined;
        const range = physicalLocation?.region;
        return {
          source: run.tool.driver.name,
          name: result.message.text ?? result.ruleId ?? 'Finding',
          status: result.level ?? 'warning',
          location: path,
          reportedUri: artifact?.uri ?? (artifact?.index !== undefined ? run.artifacts?.[artifact.index]?.location?.uri : undefined),
          startLine: range?.startLine,
          endLine: range?.endLine ?? range?.startLine,
          startColumn: range?.startColumn,
          endColumn: range?.endColumn,
          ruleId: result.ruleId,
          fingerprints: result.partialFingerprints,
          side: result.properties?.contexoSide,
          revision: result.properties?.contexoSha256,
        };
      }));
  });
}
