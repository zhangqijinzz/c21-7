import { analyzeGraph } from "./graph";
import { simulateProject } from "./simulation";
import type {
  LatencyProject,
  RequestNode,
  SimulationMode,
  SimulationResult,
  TimelineEntry,
} from "./types";

export type ImpactCertainty = "certain" | "conditional";
export type ImpactReason = "source" | "dependency" | "retry" | "fallback" | "queue";
export type ImpactTimingField =
  | "durationMs"
  | "jitterMs"
  | "timeoutMs";
export type ImpactRiskField = "retryCount" | "failureRate";
export type BatchOperation = "set" | "adjust";

export interface LatencyRange {
  low: number;
  expected: number;
  high: number;
}

export interface ImpactNodeView {
  nodeId: string;
  name: string;
  certainty: ImpactCertainty;
  reasons: ImpactReason[];
  durationDelta: LatencyRange;
  finishDelta: LatencyRange;
  participatesInBatch: boolean;
}

export interface ImpactBudget {
  current: LatencyRange;
  preview: LatencyRange;
  delta: LatencyRange;
}

export interface BatchAdjustment {
  field: ImpactTimingField;
  operation: BatchOperation;
  value: number | null;
}

export interface ImpactPreview {
  nodes: ImpactNodeView[];
  budget: ImpactBudget;
  warnings: string[];
}

export interface ImpactAdjustmentResult {
  project: LatencyProject;
  preview: ImpactPreview;
}

const simulationModes: SimulationMode[] = ["low", "expected", "high"];
const timingFields: ImpactTimingField[] = [
  "durationMs",
  "jitterMs",
  "timeoutMs",
];
const riskFields: ImpactRiskField[] = ["retryCount", "failureRate"];
const editableNumericFields = [...timingFields, ...riskFields] as const;

function asRange(results: SimulationResult[], key: "completionMs"): LatencyRange {
  return {
    low: results[0]?.[key] ?? 0,
    expected: results[1]?.[key] ?? 0,
    high: results[2]?.[key] ?? 0,
  };
}

function simulateAll(project: LatencyProject): {
  results: SimulationResult[];
  entriesByMode: Map<string, TimelineEntry>[];
} {
  const results = simulationModes.map((mode) => simulateProject(project, mode));
  return {
    results,
    entriesByMode: results.map(
      (result) => new Map(result.entries.map((entry) => [entry.nodeId, entry])),
    ),
  };
}

function hasCompleteResults(project: LatencyProject, results: SimulationResult[]) {
  return results.every(
    (result) =>
      result.entries.length === project.nodes.length &&
      !result.warnings.some((warning) => warning.includes("循环")),
  );
}

function applySourcePatch(
  project: LatencyProject,
  sourceId: string,
  patch: Partial<RequestNode>,
): LatencyProject {
  return {
    ...project,
    nodes: project.nodes.map((node) =>
      node.id === sourceId ? { ...node, ...patch } : node,
    ),
  };
}

function changedNumericFields(
  before: RequestNode,
  after: RequestNode,
): Set<(typeof editableNumericFields)[number]> {
  const changed = new Set<(typeof editableNumericFields)[number]>();
  for (const field of editableNumericFields)
    if (before[field] !== after[field]) changed.add(field);
  return changed;
}

function changedNodes(
  before: LatencyProject,
  after: LatencyProject,
): Map<string, Set<(typeof editableNumericFields)[number]>> {
  const result = new Map<
    string,
    Set<(typeof editableNumericFields)[number]>
  >();
  const beforeById = new Map(before.nodes.map((node) => [node.id, node]));
  for (const node of after.nodes) {
    const previous = beforeById.get(node.id);
    if (!previous) continue;
    const changed = changedNumericFields(previous, node);
    if (changed.size) result.set(node.id, changed);
  }
  return result;
}

interface Trait {
  certainty: ImpactCertainty;
  reasons: Set<ImpactReason>;
}

function collectGraphImpact(
  project: LatencyProject,
  changed: Map<string, Set<(typeof editableNumericFields)[number]>>,
): Map<string, Trait> {
  const normalChildren = new Map<string, string[]>();
  const fallbackOwners = new Map<string, string[]>();
  for (const node of project.nodes) {
    for (const dependencyId of node.dependencyIds) {
      normalChildren.set(dependencyId, [
        ...(normalChildren.get(dependencyId) ?? []),
        node.id,
      ]);
    }
    if (node.fallbackNodeId)
      fallbackOwners.set(node.fallbackNodeId, [
        ...(fallbackOwners.get(node.fallbackNodeId) ?? []),
        node.id,
      ]);
  }

  const traits = new Map<string, Trait>();
  const queue: {
    nodeId: string;
    certainty: ImpactCertainty;
    reason: ImpactReason;
  }[] = [];
  const enqueued = new Set<string>();

  const add = (
    nodeId: string,
    certainty: ImpactCertainty,
    reason: ImpactReason,
  ) => {
    const trait = traits.get(nodeId) ?? {
      certainty: "conditional" as ImpactCertainty,
      reasons: new Set<ImpactReason>(),
    };
    trait.certainty =
      trait.certainty === "certain" || certainty === "certain"
        ? "certain"
        : "conditional";
    trait.reasons.add(reason);
    traits.set(nodeId, trait);
    const edgeKey = `${nodeId}:${certainty}:${reason}`;
    if (!enqueued.has(edgeKey)) {
      enqueued.add(edgeKey);
      queue.push({ nodeId, certainty, reason });
    }
  };

  for (const [nodeId, fields] of changed) {
    const hasTimingChange = timingFields.some((field) => fields.has(field));
    add(
      nodeId,
      hasTimingChange ? "certain" : "conditional",
      "source",
    );
  }

  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    for (const childId of normalChildren.get(current.nodeId) ?? [])
      add(childId, current.certainty, current.certainty === "certain" ? "dependency" : "retry");
    for (const ownerId of fallbackOwners.get(current.nodeId) ?? [])
      add(ownerId, "conditional", "fallback");
  }
  return traits;
}

function subtractRange(current: LatencyRange, baseline: LatencyRange): LatencyRange {
  return {
    low: current.low - baseline.low,
    expected: current.expected - baseline.expected,
    high: current.high - baseline.high,
  };
}

function fieldLimits(field: (typeof editableNumericFields)[number]): {
  integer?: boolean;
  max: number;
} {
  return {
    integer: field === "retryCount",
    max: field === "retryCount" ? 8 : field === "failureRate" ? 100 : Number.POSITIVE_INFINITY,
  };
}

function invalidCandidate(node: RequestNode): string[] {
  const errors: string[] = [];
  for (const field of editableNumericFields) {
    const value = node[field];
    const { integer, max } = fieldLimits(field);
    if (!Number.isFinite(value) || value < 0 || value > max)
      errors.push(`${node.name}: ${fieldLabel(field)}不在允许范围内`);
    else if (integer && !Number.isInteger(value))
      errors.push(`${node.name}: ${fieldLabel(field)}必须是整数`);
  }
  return errors;
}

function fieldLabel(field: (typeof editableNumericFields)[number]): string {
  const labels: Record<(typeof editableNumericFields)[number], string> = {
    durationMs: "预计耗时",
    jitterMs: "延迟波动",
    timeoutMs: "超时阈值",
    retryCount: "重试次数",
    failureRate: "失败概率",
  };
  return labels[field];
}

export function previewNodeImpact(
  project: LatencyProject,
  sourceId: string,
  sourcePatch: Partial<RequestNode>,
  batch?: BatchAdjustment,
): ImpactPreview | { errors: string[] } {
  const baselineAnalysis = analyzeGraph(project);
  if (baselineAnalysis.validation.errors.length)
    return { errors: baselineAnalysis.validation.errors };
  const source = project.nodes.find((node) => node.id === sourceId);
  if (!source) return { errors: ["没有找到要预览的节点"] };

  const patchedSource = { ...source, ...sourcePatch };
  const sourceErrors = invalidCandidate(patchedSource);
  if (sourceErrors.length) return { errors: sourceErrors };

  const sourceProject = applySourcePatch(project, sourceId, sourcePatch);
  const initialTraits = collectGraphImpact(sourceProject, changedNodes(project, sourceProject));

  const batchErrors: string[] = [];
  let candidateProject = sourceProject;
  if (batch && batch.value !== null) {
    const batchField = batch.field;
    const batchValue = batch.value;
    candidateProject = {
      ...sourceProject,
      nodes: sourceProject.nodes.map((node) => {
        if (node.id === sourceId || !initialTraits.has(node.id)) return node;
        const nextValue =
          batch.operation === "set"
            ? batchValue
            : node[batchField] + batchValue;
        const candidate = { ...node, [batchField]: nextValue };
        batchErrors.push(...invalidCandidate(candidate));
        return candidate;
      }),
    };
  }

  const candidateAnalysis = analyzeGraph(candidateProject);
  const errors = [...batchErrors, ...candidateAnalysis.validation.errors];
  if (errors.length) return { errors: [...new Set(errors)].slice(0, 3) };

  const baselineSimulation = simulateAll(project);
  const candidateSimulation = simulateAll(candidateProject);
  if (
    !hasCompleteResults(project, baselineSimulation.results) ||
    !hasCompleteResults(candidateProject, candidateSimulation.results)
  )
    return { errors: ["当前链路无法完成推演，请先修复配置"] };

  const allChanged = changedNodes(project, candidateProject);
  const traits = collectGraphImpact(candidateProject, allChanged);

  for (let modeIndex = 0; modeIndex < simulationModes.length; modeIndex += 1) {
    const beforeEntries = baselineSimulation.entriesByMode[modeIndex];
    const afterEntries = candidateSimulation.entriesByMode[modeIndex];
    if (!beforeEntries || !afterEntries) continue;
    for (const [nodeId, afterEntry] of afterEntries) {
      const beforeEntry = beforeEntries.get(nodeId);
      if (
        !traits.has(nodeId) &&
        beforeEntry &&
        Math.abs(afterEntry.endMs - beforeEntry.endMs) > 0.000001
      ) {
        traits.set(nodeId, {
          certainty: "certain",
          reasons: new Set<ImpactReason>(["queue"]),
        });
      }
    }
  }

  const order = new Map(candidateAnalysis.order.map((id, index) => [id, index]));
  const nodes: ImpactNodeView[] = [...traits.entries()]
    .map(([nodeId, trait]) => {
      const node = candidateProject.nodes.find((item) => item.id === nodeId);
      if (!node) return undefined;
      const durationDelta = {
        low:
          (candidateSimulation.entriesByMode[0]?.get(nodeId)?.modeledDurationMs ?? 0) -
          (baselineSimulation.entriesByMode[0]?.get(nodeId)?.modeledDurationMs ?? 0),
        expected:
          (candidateSimulation.entriesByMode[1]?.get(nodeId)?.modeledDurationMs ?? 0) -
          (baselineSimulation.entriesByMode[1]?.get(nodeId)?.modeledDurationMs ?? 0),
        high:
          (candidateSimulation.entriesByMode[2]?.get(nodeId)?.modeledDurationMs ?? 0) -
          (baselineSimulation.entriesByMode[2]?.get(nodeId)?.modeledDurationMs ?? 0),
      };
      const finishDelta = {
        low:
          (candidateSimulation.entriesByMode[0]?.get(nodeId)?.endMs ?? 0) -
          (baselineSimulation.entriesByMode[0]?.get(nodeId)?.endMs ?? 0),
        expected:
          (candidateSimulation.entriesByMode[1]?.get(nodeId)?.endMs ?? 0) -
          (baselineSimulation.entriesByMode[1]?.get(nodeId)?.endMs ?? 0),
        high:
          (candidateSimulation.entriesByMode[2]?.get(nodeId)?.endMs ?? 0) -
          (baselineSimulation.entriesByMode[2]?.get(nodeId)?.endMs ?? 0),
      };
      return {
        nodeId,
        name: node.name,
        certainty: trait.certainty,
        reasons: [...trait.reasons],
        durationDelta,
        finishDelta,
        participatesInBatch: nodeId !== sourceId && initialTraits.has(nodeId),
      };
    })
    .filter((item): item is ImpactNodeView => Boolean(item))
    .sort(
      (a, b) =>
        (order.get(a.nodeId) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.nodeId) ?? Number.MAX_SAFE_INTEGER),
    );

  const currentBudget = asRange(baselineSimulation.results, "completionMs");
  const previewBudget = asRange(candidateSimulation.results, "completionMs");
  const warnings = [
    ...new Set(candidateSimulation.results.flatMap((result) => result.warnings)),
  ];

  return {
    nodes,
    budget: {
      current: currentBudget,
      preview: previewBudget,
      delta: subtractRange(previewBudget, currentBudget),
    },
    warnings,
  };
}

export function applyImpactAdjustment(
  project: LatencyProject,
  sourceId: string,
  sourcePatch: Partial<RequestNode>,
  batch?: BatchAdjustment,
): ImpactAdjustmentResult | { errors: string[] } {
  const preview = previewNodeImpact(project, sourceId, sourcePatch, batch);
  if ("errors" in preview) return { errors: preview.errors };

  const source = project.nodes.find((node) => node.id === sourceId);
  if (!source) return { errors: ["没有找到要调整的节点"] };
  const sourceProject = applySourcePatch(project, sourceId, sourcePatch);
  const initialTraits = collectGraphImpact(
    sourceProject,
    changedNodes(project, sourceProject),
  );
  const next: LatencyProject = {
    ...project,
    updatedAt: Date.now(),
    nodes:
      batch && batch.value !== null
        ? sourceProject.nodes.map((node) =>
            node.id === sourceId || !initialTraits.has(node.id)
              ? node
              : {
                  ...node,
                  [batch.field]:
                    batch.operation === "set"
                      ? batch.value
                      : node[batch.field] + (batch.value ?? 0),
                },
          )
        : sourceProject.nodes,
  };
  return { project: next, preview };
}
