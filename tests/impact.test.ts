import { describe, expect, it } from "vitest";
import { EXAMPLE_PROJECT } from "../src/shared/domain/types";
import type { RequestNode } from "../src/shared/domain/types";
import {
  applyImpactAdjustment,
  previewNodeImpact,
} from "../src/shared/domain/impact";

function chainProject(): typeof EXAMPLE_PROJECT {
  const nodes: RequestNode[] = [
    {
      id: "a",
      name: "A",
      durationMs: 100,
      jitterMs: 0,
      dependencyIds: [],
      timeoutMs: 1000,
      retryCount: 0,
      failureRate: 0,
    },
    {
      id: "b",
      name: "B",
      durationMs: 200,
      jitterMs: 0,
      dependencyIds: ["a"],
      timeoutMs: 1000,
      retryCount: 0,
      failureRate: 0,
    },
    {
      id: "c",
      name: "C",
      durationMs: 300,
      jitterMs: 0,
      dependencyIds: ["b"],
      timeoutMs: 1000,
      retryCount: 0,
      failureRate: 0,
    },
  ];
  return { ...EXAMPLE_PROJECT, nodes, concurrencyLimit: null };
}

describe("node impact preview", () => {
  it("lists deterministic downstream nodes once and gives a latency range", () => {
    const project = chainProject();
    const preview = previewNodeImpact(project, "a", { durationMs: 150 });
    if ("errors" in preview) throw new Error(preview.errors.join(" "));

    expect(preview.nodes.map((node) => node.nodeId)).toEqual(["a", "b", "c"]);
    expect(preview.nodes[1]?.certainty).toBe("certain");
    expect(preview.nodes[1]?.finishDelta.expected).toBe(50);
    expect(preview.budget.delta).toEqual({
      low: 50,
      expected: 50,
      high: 50,
    });
  });

  it("marks fallback propagation as conditional", () => {
    const project = chainProject();
    const nodes = project.nodes.map((node) =>
      node.id === "a"
        ? {
            ...node,
            durationMs: 300,
            dependencyIds: [],
            retryCount: 1,
            failureRate: 20,
            fallbackNodeId: "b",
          }
        : { ...node, dependencyIds: [] },
    );
    project.nodes = nodes;
    const preview = previewNodeImpact(project, "b", { durationMs: 250 });
    if ("errors" in preview) throw new Error(preview.errors.join(" "));

    const byId = new Map(preview.nodes.map((node) => [node.nodeId, node]));
    expect(byId.get("b")?.certainty).toBe("certain");
    expect(byId.get("a")?.certainty).toBe("conditional");
    expect(byId.get("a")?.reasons).toContain("fallback");
    expect(byId.get("c")).toBeUndefined();
  });

  it("applies a timing batch adjustment to every reachable downstream node", () => {
    const project = chainProject();
    const outcome = applyImpactAdjustment(
      project,
      "a",
      { durationMs: 150 },
      { field: "durationMs", operation: "adjust", value: -10 },
    );
    if ("errors" in outcome) throw new Error(outcome.errors.join(" "));

    expect(outcome.project.nodes.map((node) => node.durationMs)).toEqual([
      150, 190, 290,
    ]);
    expect(outcome.preview.budget.preview.expected).toBe(630);
  });

  it("rolls the whole atomic adjustment back when one resulting value is invalid", () => {
    const project = chainProject();
    const outcome = applyImpactAdjustment(
      project,
      "a",
      { durationMs: 150 },
      { field: "durationMs", operation: "adjust", value: -250 },
    );
    if (!("errors" in outcome)) throw new Error("invalid batch should fail");

    expect(outcome.errors.length).toBeGreaterThan(0);
    expect(project.nodes.map((node) => node.durationMs)).toEqual([
      100, 200, 300,
    ]);
  });
});
