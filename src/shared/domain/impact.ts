import { analyzeGraph } from "./graph";
import { modelRequestDuration, simulateProject } from "./simulation";
import type {
  LatencyProject,
  RequestNode,
  SimulationMode,
  SimulationResult,
} from "./types";

export type ImpactKind = "always" | "conditional";

export interface ImpactScopeNode {
  nodeId: string;
  kind: ImpactKind;
  reasons: string[];
}

export interface ImpactNodePreview extends ImpactScopeNode {
  name: string;
  currentDurationMs: number;
  currentEndMs: number;
  rangeLowMs: number;
  rangeHighMs: number;
  rangeMetric: "end" | "weighted";
}

export interface ImpactPreview {
  sourceId: string;
  nodes: ImpactNodePreview[];
  alwaysCount: number;
  conditionalCount: number;
  completionLowMs: number;
  completionExpectedMs: number;
  completionHighMs: number;
  errors: string[];
}

export interface NodeAdjustment {
  id: string;
  patch: Partial<RequestNode>;
}

export interface ImpactAdjustmentResult {
  project: LatencyProject;
  errors: string[];
}

function getMaps(project: LatencyProject) {
  const byId = new Map(project.nodes.map((node) => [node.id, node]));
  const hardChildren = new Map(
    project.nodes.map((node) => [node.id, [] as string[]]),
  );
  for (const node of project.nodes)
    for (const dependencyId of node.dependencyIds)
      hardChildren.get(dependencyId)?.push(node.id);
  return { byId, hardChildren };
}

function addReason(
  reasonsById: Map<string, Set<string>>,
  id: string,
  reason: string,
) {
  const reasons = reasonsById.get(id) ?? new Set<string>();
  reasons.add(reason);
  reasonsById.set(id, reasons);
}

export function getImpactScope(
  project: LatencyProject,
  sourceId: string,
): ImpactScopeNode[] {
  const { byId, hardChildren } = getMaps(project);
  const source = byId.get(sourceId);
  if (!source) return [];

  const always = new Set<string>();
  const conditionalReasons = new Map<string, Set<string>>();
  const queue = [sourceId];
  while (queue.length) {
    const id = queue.shift();
    if (!id || always.has(id)) continue;
    if (id !== sourceId) always.add(id);
    for (const childId of hardChildren.get(id) ?? [])
      if (!always.has(childId)) queue.push(childId);
  }

  const addConditional = (id: string, reason: string) => {
    if (id === sourceId || always.has(id)) return;
    addReason(conditionalReasons, id, reason);
  };

  // The source can invoke a fallback chain after its retries are exhausted.
  const fallbackSeen = new Set<string>();
  let fallbackId = source.fallbackNodeId;
  let weightReason = "重试耗尽后降级调用";
  while (fallbackId && byId.has(fallbackId) && !fallbackSeen.has(fallbackId)) {
    fallbackSeen.add(fallbackId);
    addConditional(fallbackId, weightReason);
    const fallbackNode = byId.get(fallbackId);
    fallbackId = fallbackNode?.fallbackNodeId;
    weightReason = "降级节点再次失败后的备用请求";
  }

  // Nodes using the source as a fallback are changed only after they fail.
  for (const owner of project.nodes) {
    if (owner.fallbackNodeId !== sourceId) continue;
    addConditional(owner.id, "该节点失败后调用当前节点");
    const childQueue = [...(hardChildren.get(owner.id) ?? [])];
    while (childQueue.length) {
      const childId = childQueue.shift();
      if (!childId) continue;
      addConditional(childId, "随降级调用方的完成时间变化");
      childQueue.push(...(hardChildren.get(childId) ?? []));
    }
  }

  return project.nodes
    .filter((node) => always.has(node.id) || conditionalReasons.has(node.id))
    .map((node) => ({
      nodeId: node.id,
      kind: always.has(node.id)
        ? ("always" as const)
        : ("conditional" as const),
      reasons: Array.from(
        always.has(node.id)
          ? new Set(["依赖链必经，完成时间会被直接推迟"])
          : (conditionalReasons.get(node.id) ?? []),
      ),
    }));
}

function simulateFocused(
  project: LatencyProject,
  focusNodeId: string,
  mode: SimulationMode,
): SimulationResult {
  return simulateProject(
    {
      ...project,
      nodes: project.nodes.map((node) =>
        node.id === focusNodeId
          ? node
          : {
              ...node,
              jitterMs: node.jitterMs * 0.5,
            },
      ),
    },
    mode,
  );
}

function entry(result: SimulationResult, nodeId: string) {
  return result.entries.find((item) => item.nodeId === nodeId);
}

function terminalFailureRate(node: RequestNode): number {
  return (node.failureRate / 100) ** (node.retryCount + 1);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function previewNodeImpact(
  project: LatencyProject,
  sourceId: string,
): ImpactPreview {
  const analysis = analyzeGraph(project);
  const source = project.nodes.find((node) => node.id === sourceId);
  const empty: ImpactPreview = {
    sourceId,
    nodes: [],
    alwaysCount: 0,
    conditionalCount: 0,
    completionLowMs: 0,
    completionExpectedMs: 0,
    completionHighMs: 0,
    errors: analysis.validation.errors,
  };
  if (!source || analysis.validation.errors.length) return empty;

  const scope = getImpactScope(project, sourceId);
  const low = simulateFocused(project, sourceId, "low");
  const expected = simulateFocused(project, sourceId, "expected");
  const high = simulateFocused(project, sourceId, "high");
  const byId = new Map(project.nodes.map((node) => [node.id, node]));

  let fallbackWeight = terminalFailureRate(source);
  let fallbackId = source.fallbackNodeId;
  const fallbackRanges = new Map<string, { low: number; high: number }>();
  const fallbackSeen = new Set<string>();
  while (fallbackId && !fallbackSeen.has(fallbackId)) {
    fallbackSeen.add(fallbackId);
    const target = byId.get(fallbackId);
    if (!target) break;
    fallbackRanges.set(fallbackId, {
      low: modelRequestDuration(target, "low") * fallbackWeight,
      high: modelRequestDuration(target, "high") * fallbackWeight,
    });
    fallbackWeight *= terminalFailureRate(target);
    fallbackId = target.fallbackNodeId;
  }

  const nodes = scope.map((item) => {
    const node = byId.get(item.nodeId);
    const expectedEntry = entry(expected, item.nodeId);
    const lowEntry = entry(low, item.nodeId);
    const highEntry = entry(high, item.nodeId);
    let rangeLow = 0;
    let rangeHigh = 0;

    if (item.kind === "always") {
      rangeLow = (highEntry?.endMs ?? 0) - (lowEntry?.endMs ?? 0);
      rangeHigh = rangeLow;
    } else if (fallbackRanges.has(item.nodeId)) {
      rangeLow = fallbackRanges.get(item.nodeId)?.low ?? 0;
      rangeHigh = fallbackRanges.get(item.nodeId)?.high ?? 0;
    } else {
      rangeLow = (highEntry?.endMs ?? 0) - (lowEntry?.endMs ?? 0);
      rangeHigh = rangeLow;
    }

    return {
      ...item,
      name: node?.name ?? item.nodeId,
      currentDurationMs: expectedEntry?.modeledDurationMs ?? 0,
      currentEndMs: expectedEntry?.endMs ?? 0,
      rangeLowMs: round(Math.max(0, rangeLow)),
      rangeHighMs: round(Math.max(0, rangeHigh)),
      rangeMetric:
        item.kind === "conditional" && fallbackRanges.has(item.nodeId)
          ? ("weighted" as const)
          : ("end" as const),
    };
  });

  return {
    sourceId,
    nodes,
    alwaysCount: nodes.filter((node) => node.kind === "always").length,
    conditionalCount: nodes.filter((node) => node.kind === "conditional")
      .length,
    completionLowMs: low.completionMs,
    completionExpectedMs: expected.completionMs,
    completionHighMs: high.completionMs,
    errors: [],
  };
}

export function applyNodeAdjustments(
  project: LatencyProject,
  adjustments: NodeAdjustment[],
  now = Date.now(),
): ImpactAdjustmentResult {
  const adjustedById = new Map(
    adjustments.map((item) => [item.id, item.patch]),
  );
  if (adjustedById.size !== adjustments.length)
    return { project, errors: ["统一调整中存在重复节点，已整体取消"] };

  const knownIds = new Set(project.nodes.map((node) => node.id));
  const unknown = adjustments.filter((item) => !knownIds.has(item.id));
  if (unknown.length)
    return { project, errors: ["统一调整包含不存在的节点，已整体取消"] };

  const candidate: LatencyProject = {
    ...project,
    updatedAt: now,
    nodes: project.nodes.map((node) => {
      const patch = adjustedById.get(node.id);
      return patch ? { ...node, ...patch } : node;
    }),
  };
  const errors = analyzeGraph(candidate).validation.errors;
  return errors.length ? { project, errors } : { project: candidate, errors };
}
