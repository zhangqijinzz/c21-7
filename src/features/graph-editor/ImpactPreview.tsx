import { useState } from "react";
import {
  AlertTriangle,
  CheckCheck,
  GitPullRequestArrow,
  Route,
  ShieldQuestion,
  TimerReset,
} from "lucide-react";
import { previewImpact } from "./graphViewModel";
import type {
  BatchAdjustment,
  ImpactNodeView,
  ImpactPreview as ImpactPreviewModel,
  ImpactReason,
  ImpactTimingField,
  LatencyRange,
} from "../../shared/domain/impact";
import type { LatencyProject, RequestNode } from "../../shared/domain/types";

interface Props {
  project: LatencyProject;
  node: RequestNode;
  draft: Partial<RequestNode>;
  draftIsDirty: boolean;
  appliedPreview?: ImpactPreviewModel;
  onApply: (
    patch: Partial<RequestNode>,
    batch?: BatchAdjustment,
  ) => { preview?: ImpactPreviewModel; errors?: string[] };
}

const timingFields: {
  key: ImpactTimingField;
  label: string;
  suffix: string;
}[] = [
  { key: "durationMs", label: "预计耗时", suffix: "ms" },
  { key: "jitterMs", label: "延迟波动", suffix: "ms" },
  { key: "timeoutMs", label: "超时阈值", suffix: "ms" },
];

const reasonLabels: Record<ImpactReason, string> = {
  source: "参数源",
  dependency: "直接 / 传递依赖",
  retry: "失败重试",
  fallback: "降级路径",
  queue: "并发排队",
};

function formatRange(range: LatencyRange): string {
  const values = [range.low, range.expected, range.high].map((value) =>
    Math.round(value),
  );
  if (values[0] === values[1] && values[1] === values[2]) return `${values[0]} ms`;
  return `${values[0]} / ${values[1]} / ${values[2]} ms`;
}

function formatBudget(value: number): string {
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${Math.round(value)} ms`;
}

function rangeExtremes(range: LatencyRange) {
  return {
    min: Math.min(range.low, range.expected, range.high),
    max: Math.max(range.low, range.expected, range.high),
  };
}

function DeltaText({ range }: { range: LatencyRange }) {
  const { min, max } = rangeExtremes(range);
  if (Math.abs(min) < 0.000001 && Math.abs(max) < 0.000001)
    return <span className="impact-delta neutral">无变化</span>;
  const tone = min >= 0 ? "bad" : max <= 0 ? "good" : "mixed";
  const sign = tone === "bad" ? "+" : tone === "good" ? "" : "±";
  return (
    <span className={`impact-delta ${tone}`}>
      {tone === "mixed"
        ? `${formatRange(range)}`
        : `${sign}${formatRange(range)}`}
    </span>
  );
}

function NodeReason({ node }: { node: ImpactNodeView }) {
  const reasons = node.reasons
    .filter((reason) => reason !== "source")
    .map((reason) => reasonLabels[reason]);
  const label = [...new Set(reasons)].slice(0, 2).join(" · ") || "当前调整";
  return <small>{label}</small>;
}

export default function ImpactPreviewPanel({
  project,
  node,
  draft,
  draftIsDirty,
  appliedPreview,
  onApply,
}: Props) {
  const [field, setField] =
    useState<BatchAdjustment["field"]>("durationMs");
  const [operation, setOperation] = useState<BatchAdjustment["operation"]>("set");
  const [batchValue, setBatchValue] = useState("");
  const [applyError, setApplyError] = useState("");

  const parsedBatchValue = Number(batchValue);
  const batch: BatchAdjustment = {
    field,
    operation,
    value: batchValue.trim() === "" || !Number.isFinite(parsedBatchValue)
      ? null
      : parsedBatchValue,
  };
  const preview = previewImpact(project, node.id, draft, batch);
  const valid = "nodes" in preview ? preview : undefined;
  const errors = "errors" in preview ? preview.errors : [];
  const downstream = valid?.nodes.filter((item) => item.nodeId !== node.id) ?? [];
  const certainCount = downstream.filter(
    (item) => item.certainty === "certain",
  ).length;
  const conditionalCount = downstream.length - certainCount;
  const batchTargets = downstream.filter((item) => item.participatesInBatch);
  const hasSourceChange = valid?.nodes.some((item) => item.nodeId === node.id);

  const apply = () => {
    const outcome = onApply(draft, batch.value === null ? undefined : batch);
    if (outcome.errors?.length) setApplyError(outcome.errors[0] ?? "");
    else setApplyError("");
  };

  return (
    <section className="impact-preview">
      <div className="impact-head">
        <div>
          <span className="eyebrow">IMPACT PREVIEW</span>
          <h2>影响面预览 · {node.name}</h2>
          <p>
            同一个节点即使被多条链路共用，也只按节点 ID
            计算一次；完成时间变化会合并依赖、降级和并发排队。
          </p>
        </div>
        <div className="impact-counts">
          <span>
            <b>{certainCount}</b> 必然影响
          </span>
          <span>
            <b>{conditionalCount}</b> 条件路径
          </span>
        </div>
      </div>

      {appliedPreview && !draftIsDirty && (
        <div className="impact-applied">
          <CheckCheck size={15} />
          <span>
            原子调整已生效，整页预算从{" "}
            <b>{formatBudget(appliedPreview.budget.current.expected)}</b> 变为{" "}
            <b>{formatBudget(appliedPreview.budget.preview.expected)}</b>
          </span>
          <DeltaText range={appliedPreview.budget.delta} />
        </div>
      )}

      {valid && (
        <div className="impact-budget-grid">
          <article>
            <span>当前整页预算</span>
            <strong>{formatBudget(valid.budget.current.expected)}</strong>
            <small>
              乐观 {formatBudget(valid.budget.current.low)} · 保守{" "}
              {formatBudget(valid.budget.current.high)}
            </small>
          </article>
          <article>
            <span>推演后整页预算</span>
            <strong>{formatBudget(valid.budget.preview.expected)}</strong>
            <small>
              乐观 {formatBudget(valid.budget.preview.low)} · 保守{" "}
              {formatBudget(valid.budget.preview.high)}
            </small>
          </article>
          <article className="impact-budget-delta">
            <span>预算变化范围</span>
            <strong>
              <DeltaText range={valid.budget.delta} />
            </strong>
            <small>低 / 预期 / 高波动</small>
          </article>
        </div>
      )}

      {(errors.length > 0 || applyError) && (
        <div className="impact-error">
          <AlertTriangle size={15} />
          <div>
            <strong>存在不合法调整，批量动作尚未生效</strong>
            <p>{applyError || (errors[0] ?? "")}</p>
          </div>
        </div>
      )}

      <div className="impact-batch-card">
        <div className="impact-batch-title">
          <TimerReset size={16} />
          <div>
            <strong>对影响范围内节点统一调整</strong>
            <small>
              原子提交：{batchTargets.length}
              个可达下游节点中任一项不合法，所有调整都会回滚。
            </small>
          </div>
        </div>
        <div className="impact-batch-controls">
          <label>
            调整字段
            <select
              value={field}
              onChange={(event) =>
                setField(event.target.value as BatchAdjustment["field"])
              }
            >
              {timingFields.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            调整方式
            <select
              value={operation}
              onChange={(event) =>
                setOperation(event.target.value as BatchAdjustment["operation"])
              }
            >
              <option value="set">统一设为</option>
              <option value="adjust">统一增减</option>
            </select>
          </label>
          <label className="impact-batch-value">
            数值
            <span>
              <input
                type="number"
                value={batchValue}
                onChange={(event) => setBatchValue(event.target.value)}
              />
              <small>ms</small>
            </span>
          </label>
          <button
            className="button button-lime"
            disabled={!valid || !hasSourceChange || batch.value === null}
            onClick={apply}
          >
            <CheckCheck size={15} /> 确认并重新推演
          </button>
        </div>
      </div>

      {valid && (
        <div className="impact-table-wrap">
          <div className="impact-table-heading">
            <span>去重后的影响节点</span>
            <span>
              <i className="certain-dot" /> 必然
              <i className="conditional-dot" /> 仅失败重试 / 降级
            </span>
          </div>
          <div className="impact-table">
            {valid.nodes.map((item) => (
              <div className="impact-row" key={item.nodeId}>
                <div className="impact-node-copy">
                  <i className={item.certainty} />
                  <div>
                    <strong>
                      {item.name}
                      {item.nodeId === node.id && <em>调整源</em>}
                    </strong>
                    <NodeReason node={item} />
                  </div>
                </div>
                <div className="impact-range">
                  <span>节点耗时变化</span>
                  <DeltaText range={item.durationDelta} />
                </div>
                <div className="impact-range">
                  <span>完成时间变化</span>
                  <DeltaText range={item.finishDelta} />
                </div>
                <div className="impact-path-kind">
                  {item.certainty === "certain" ? (
                    <>
                      <Route size={13} /> 必然
                    </>
                  ) : (
                    <>
                      <ShieldQuestion size={13} /> 条件路径
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="impact-footnote">
            <GitPullRequestArrow size={13} />
            只通过资源排队改变完成时间的节点也计入整页预算，但不纳入字段批量调整。
            {valid.warnings[0] ? ` 推演提示：${valid.warnings[0]}` : ""}
          </div>
        </div>
      )}
    </section>
  );
}
