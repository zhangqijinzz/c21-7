import { describe, expect, it } from "vitest";
import { analyzeGraph } from "../src/shared/domain/graph";
import { EXAMPLE_PROJECT } from "../src/shared/domain/types";
import { simulateProject } from "../src/shared/domain/simulation";
import {
  addRequestNode,
  toggleDependency,
} from "../src/features/graph-editor/graphViewModel";
import {
  applyNodeAdjustments,
  getImpactScope,
  previewNodeImpact,
} from "../src/shared/domain/impact";

describe("request dependency graph", () => {
  it("orders a DAG and detects a cycle before simulation", () => {
    const project = structuredClone(EXAMPLE_PROJECT);
    expect(analyzeGraph(project).order).toHaveLength(project.nodes.length);
    const cyclic = {
      ...project,
      nodes: project.nodes.map((node) =>
        node.id === "session" ? { ...node, dependencyIds: ["profile"] } : node,
      ),
    };
    expect(analyzeGraph(cyclic).validation.errors.join(" ")).toContain(
      "循环依赖",
    );
    expect(simulateProject(cyclic).entries).toHaveLength(0);
  });

  it("rejects cyclic edges and accepts valid dependencies", () => {
    const project = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 3),
    };
    const accepted = toggleDependency(project, "profile", "flags");
    expect(accepted.error).toBeUndefined();
    const rejected = toggleDependency(accepted.project, "flags", "profile");
    expect(rejected.error).toContain("循环");
    expect(rejected.project).toEqual(accepted.project);
  });

  it("schedules independent roots in parallel and serializes them at concurrency one", () => {
    const project = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 2).map((node) => ({
        ...node,
        durationMs: 300,
        jitterMs: 0,
        timeoutMs: 1000,
        retryCount: 0,
        failureRate: 0,
      })),
    };
    const parallel = simulateProject(project);
    const serial = simulateProject({ ...project, concurrencyLimit: 1 });
    expect(parallel.completionMs).toBe(300);
    expect(serial.completionMs).toBe(600);
    expect(serial.entries[1]?.waitMs).toBe(300);
  });

  it("applies jitter modes, timeout caps, bounded retries, and fallback probability", () => {
    const node = {
      id: "a",
      name: "slow",
      durationMs: 1200,
      jitterMs: 400,
      dependencyIds: [],
      timeoutMs: 1000,
      retryCount: 1,
      failureRate: 50,
      fallbackNodeId: "b",
    };
    const fallback = {
      ...node,
      id: "b",
      name: "fallback",
      durationMs: 200,
      jitterMs: 0,
      timeoutMs: 500,
      retryCount: 0,
      failureRate: 0,
      fallbackNodeId: undefined,
    };
    const project = { ...EXAMPLE_PROJECT, nodes: [node, fallback] };
    const low = simulateProject(project, "low");
    const expected = simulateProject(project, "expected");
    const high = simulateProject(project, "high");
    expect(low.completionMs).toBeLessThanOrEqual(expected.completionMs);
    expect(expected.completionMs).toBeLessThanOrEqual(high.completionMs);
    expect(high.warnings.join(" ")).toContain("超时");
    expect(high.entries[0]?.modeledDurationMs).toBe(1650);
    const invalid = {
      ...project,
      nodes: [{ ...node, retryCount: 9 }, fallback],
    };
    expect(simulateProject(invalid).entries).toHaveLength(0);
  });

  it("creates an editable request node with safe defaults", () => {
    const project = { ...EXAMPLE_PROJECT, nodes: [] };
    const next = addRequestNode(project);
    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0]?.durationMs).toBe(400);
    expect(next.nodes[0]?.dependencyIds).toEqual([]);
  });

  it("classifies impact scope once when downstream paths merge", () => {
    const make = (
      id: string,
      dependencyIds: string[] = [],
      fallbackNodeId?: string,
    ) => ({
      id,
      name: id,
      durationMs: 100,
      jitterMs: 0,
      dependencyIds,
      timeoutMs: 500,
      retryCount: 0,
      failureRate: 0,
      ...(fallbackNodeId ? { fallbackNodeId } : {}),
    });
    const project = {
      ...EXAMPLE_PROJECT,
      nodes: [
        make("a"),
        make("b", ["a"]),
        make("c", ["a"]),
        make("d", ["b", "c"]),
      ],
    };
    const scope = getImpactScope(project, "a");
    expect(scope.map((node) => node.nodeId)).toEqual(["b", "c", "d"]);
    expect(scope.every((node) => node.kind === "always")).toBe(true);
    expect(new Set(scope.map((node) => node.nodeId)).size).toBe(scope.length);
  });

  it("separates fallback impact from mandatory downstream impact", () => {
    const scope = getImpactScope(EXAMPLE_PROJECT, "catalog");
    const recommend = scope.find((node) => node.nodeId === "recommend");
    expect(recommend?.kind).toBe("conditional");
    expect(recommend?.reasons.join(" ")).toContain("失败后调用");
    expect(scope.filter((node) => node.kind === "conditional")).toHaveLength(1);
  });

  it("previews a focused uncertainty range without counting shared nodes twice", () => {
    const preview = previewNodeImpact(EXAMPLE_PROJECT, "catalog");
    expect(preview.conditionalCount).toBe(1);
    const recommend = preview.nodes.find((node) => node.nodeId === "recommend");
    expect(recommend).toBeDefined();
    expect(recommend?.rangeMetric).toBe("end");
    expect(recommend?.rangeLowMs).toBeGreaterThan(0);
    expect(new Set(preview.nodes.map((node) => node.nodeId)).size).toBe(
      preview.nodes.length,
    );
  });

  it("applies a batch only when every node adjustment is valid", () => {
    const invalid = applyNodeAdjustments(EXAMPLE_PROJECT, [
      { id: "catalog", patch: { durationMs: 800 } },
      { id: "profile", patch: { retryCount: 9 } },
    ]);
    expect(invalid.project).toEqual(EXAMPLE_PROJECT);
    expect(invalid.errors.join(" ")).toContain("重试次数");

    const valid = applyNodeAdjustments(EXAMPLE_PROJECT, [
      { id: "catalog", patch: { durationMs: 800 } },
      { id: "profile", patch: { durationMs: 500 } },
    ]);
    expect(valid.errors).toEqual([]);
    expect(
      valid.project.nodes.find((node) => node.id === "catalog")?.durationMs,
    ).toBe(800);
    expect(
      valid.project.nodes.find((node) => node.id === "profile")?.durationMs,
    ).toBe(500);
  });
});
