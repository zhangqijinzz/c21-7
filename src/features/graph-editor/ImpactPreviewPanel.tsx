import { useMemo, useState } from "react";
import {
  ArrowRight,
  CircleAlert,
  GitMerge,
  RotateCcw,
  ShieldQuestion,
  Sparkles,
  X,
} from "lucide-react";
import {
  applyNodeAdjustments,
  previewNodeImpact,
  type ImpactPreview,
  type NodeAdjustment,
} from "../../shared/domain/impact";
import type { LatencyProject, RequestNode } from "../../shared/domain/types";

interface Props {
  project: LatencyProject;
  node: RequestNode;
  onApply: (adjustments: NodeAdjustment[]) => string[];
}

type DraftField =
  "durationMs" | "jitterMs" | "timeoutMs" | "retryCount" | "failureRate";
type BulkField = "durationMs" | "jitterMs" | "timeoutMs";
type BulkMode = "scale" | "add" | "set";

type Draft = Record<string, Pick<RequestNode, DraftField>>;

const sourceFields: { key: DraftField; label: string; suffix: string }[] = [
  { key: "durationMs", label: "预计耗时", suffix: "ms" },
  { key: "jitterMs", label: "延迟波动", suffix: "±ms" },
  { key: "timeoutMs", label: "超时阈值", suffix: "ms" },
  { key: "retryCount", label: "重试次数", suffix: "次" },
  { key: "failureRate", label: "失败概率", suffix: "%" },
];

const bulkFields: { key: BulkField; label: string }[] = [
  { key: "durationMs", label: "预计耗时" },
  { key: "jitterMs", label: "延迟波动" },
  { key: "timeoutMs", label: "超时阈值" },
];

function toDraft(node: RequestNode): Pick<RequestNode, DraftField> {
  return {
    durationMs: node.durationMs,
    jitterMs: node.jitterMs,
    timeoutMs: node.timeoutMs,
    retryCount: node.retryCount,
    failureRate: node.failureRate,
  };
}

function initialDraft(project: LatencyProject): Draft {
  return Object.fromEntries(
    project.nodes.map((node) => [node.id, toDraft(node)]),
  ) as Draft;
}

function formatMs(value: number): string {
  const rounded = Math.round(value);
  return rounded < 1000 ? `${rounded} ms` : `${(value / 1000).toFixed(2)} s`;
}

function formatDelta(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return "±0 ms";
  return `${rounded > 0 ? "+" : ""}${rounded} ms`;
}

function validateDraft(project: LatencyProject, draft: Draft): string[] {
  const errors: string[] = [];
  for (const node of project.nodes) {
    const values = draft[node.id];
    if (!values) {
      errors.push(`${node.name}: 缺少调整值`);
      continue;
    }
    const label = node.name;
    if (!Number.isFinite(values.durationMs) || values.durationMs < 0)
      errors.push(`${label}: 预计耗时必须不小于 0`);
    if (!Number.isFinite(values.jitterMs) || values.jitterMs < 0)
      errors.push(`${label}: 延迟波动必须不小于 0`);
    if (!Number.isFinite(values.timeoutMs) || values.timeoutMs < 0)
      errors.push(`${label}: 超时阈值必须不小于 0`);
    if (
      !Number.isInteger(values.retryCount) ||
      values.retryCount < 0 ||
      values.retryCount > 8
    )
      errors.push(`${label}: 重试次数需为 0–8 的整数`);
    if (
      !Number.isFinite(values.failureRate) ||
      values.failureRate < 0 ||
      values.failureRate > 100
    )
      errors.push(`${label}: 失败概率需在 0–100%`);
  }
  return errors;
}

function buildAdjustments(
  project: LatencyProject,
  draft: Draft,
): NodeAdjustment[] {
  return project.nodes.flatMap((node) => {
    const values = draft[node.id];
    if (!values) return [];
    const patch = Object.fromEntries(
      (Object.keys(values) as DraftField[])
        .filter((key) => values[key] !== node[key])
        .map((key) => [key, values[key]]),
    ) as Partial<RequestNode>;
    return Object.keys(patch).length ? [{ id: node.id, patch }] : [];
  });
}

export default function ImpactPreviewPanel({ project, node, onApply }: Props) {
  const [open, setOpen] = useState(false);
  const preview = useMemo(
    () => previewNodeImpact(project, node.id),
    [project, node.id],
  );

  if (preview.errors.length) {
    return (
      <section className="impact-panel impact-error">
        <div className="impact-title">
          <ShieldQuestion size={15} />
          <div>
            <span>影响面预览</span>
            <small>修复当前链路错误后可推演影响范围</small>
          </div>
        </div>
        <p>{preview.errors[0]}</p>
      </section>
    );
  }

  return (
    <section className="impact-panel">
      <div className="impact-title">
        <GitMerge size={15} />
        <div>
          <span>影响面预览</span>
          <small>共用节点只计算一次，条件路径不与必经链路叠加</small>
        </div>
      </div>
      <div className="impact-counts">
        <div>
          <b>{preview.alwaysCount}</b>
          <span>必经下游</span>
        </div>
        <div className="conditional">
          <b>{preview.conditionalCount}</b>
          <span>重试/降级路径</span>
        </div>
        <div>
          <b>{formatMs(preview.completionHighMs - preview.completionLowMs)}</b>
          <span>源节点预算波动</span>
        </div>
      </div>
      <div className="impact-list">
        {preview.nodes.length ? (
          preview.nodes.map((item) => (
            <div className="impact-row" key={item.nodeId}>
              <span className={`impact-dot ${item.kind}`} />
              <div>
                <strong>{item.name}</strong>
                <small>{item.reasons[0]}</small>
              </div>
              <em className={item.kind}>
                {item.kind === "always" ? "必然受影响" : "条件受影响"}
              </em>
              <b>
                {item.rangeMetric === "weighted" ? "加权 " : ""}
                {item.rangeLowMs === item.rangeHighMs
                  ? formatDelta(item.rangeLowMs)
                  : `${formatMs(item.rangeLowMs)} – ${formatMs(item.rangeHighMs)}`}
              </b>
            </div>
          ))
        ) : (
          <p className="impact-empty">没有下游节点；调整只影响当前请求自身。</p>
        )}
      </div>
      <button
        className="button button-primary impact-action"
        onClick={() => setOpen(true)}
      >
        <Sparkles size={14} /> 统一调整影响范围
      </button>
      {open && (
        <ImpactAdjustmentDialog
          project={project}
          source={node}
          preview={preview}
          draft={initialDraft(project)}
          onClose={() => setOpen(false)}
          onApply={onApply}
        />
      )}
    </section>
  );
}

interface DialogProps {
  project: LatencyProject;
  source: RequestNode;
  preview: ImpactPreview;
  draft: Draft;
  onClose: () => void;
  onApply: Props["onApply"];
}

function ImpactAdjustmentDialog({
  project,
  source,
  preview,
  draft: initial,
  onClose,
  onApply,
}: DialogProps) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [bulkField, setBulkField] = useState<BulkField>("durationMs");
  const [bulkMode, setBulkMode] = useState<BulkMode>("scale");
  const [bulkValue, setBulkValue] = useState(-10);
  const [bulkError, setBulkError] = useState("");
  const [applyErrors, setApplyErrors] = useState<string[]>([]);

  const impactedIds = new Set(preview.nodes.map((item) => item.nodeId));
  const candidate = useMemo(() => {
    const localErrors = validateDraft(project, draft);
    if (localErrors.length) return { errors: localErrors, project };
    const adjustments = buildAdjustments(project, draft);
    return applyNodeAdjustments(project, adjustments, project.updatedAt);
  }, [draft, project]);

  const candidatePreview = candidate.errors.length
    ? preview
    : previewNodeImpact(candidate.project, source.id);

  const updateSource = (key: DraftField, rawValue: string) => {
    const value = Number(rawValue);
    setDraft((current) => ({
      ...current,
      [source.id]: { ...current[source.id]!, [key]: value },
    }));
    setApplyErrors([]);
  };

  const applyBulk = () => {
    if (!Number.isFinite(bulkValue)) {
      setBulkError("请先输入合法的调整数值");
      return;
    }
    const next: Draft = { ...draft };
    for (const item of preview.nodes) {
      const current = next[item.nodeId]!;
      const oldValue = current[bulkField];
      const raw =
        bulkMode === "set"
          ? bulkValue
          : bulkMode === "add"
            ? oldValue + bulkValue
            : oldValue * (1 + bulkValue / 100);
      const value = Math.round(raw * 100) / 100;
      next[item.nodeId] = { ...current, [bulkField]: value };
    }
    const errors = validateDraft(project, next);
    if (errors.length) {
      setBulkError(`统一调整未生效：${errors[0]}`);
      return;
    }
    setDraft(next);
    setBulkError("");
    setApplyErrors([]);
  };

  const reset = () => {
    setDraft(initialDraft(project));
    setBulkError("");
    setApplyErrors([]);
  };

  const confirm = () => {
    const adjustments = buildAdjustments(project, draft);
    if (!adjustments.length) {
      setApplyErrors(["没有需要应用的调整"]);
      return;
    }
    const errors = onApply(adjustments);
    if (errors.length) setApplyErrors(errors);
    else onClose();
  };

  const budgetRows: {
    label: string;
    base: number;
    next: number;
  }[] = [
    {
      label: "乐观",
      base: preview.completionLowMs,
      next: candidatePreview.completionLowMs,
    },
    {
      label: "预期",
      base: preview.completionExpectedMs,
      next: candidatePreview.completionExpectedMs,
    },
    {
      label: "保守",
      base: preview.completionHighMs,
      next: candidatePreview.completionHighMs,
    },
  ];

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="confirm-dialog impact-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="impact-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="impact-dialog-head">
          <div>
            <span className="eyebrow">ATOMIC BATCH EDIT</span>
            <h2 id="impact-dialog-title">统一调整影响范围</h2>
            <p>
              从“{source.name}”出发的 {preview.nodes.length}{" "}
              个唯一节点会一起校验；任一项不合法，本次整体不生效。
            </p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="bulk-source-grid">
          {sourceFields.map(({ key, label, suffix }) => (
            <label key={key}>
              {label}
              <span>
                <input
                  type="number"
                  value={draft[source.id]?.[key] ?? ""}
                  onChange={(event) => updateSource(key, event.target.value)}
                />
                <small>{suffix}</small>
              </span>
            </label>
          ))}
        </div>

        <div className="bulk-operation">
          <label>
            统一字段
            <select
              value={bulkField}
              onChange={(event) =>
                setBulkField(event.target.value as BulkField)
              }
            >
              {bulkFields.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            调整方式
            <select
              value={bulkMode}
              onChange={(event) => setBulkMode(event.target.value as BulkMode)}
            >
              <option value="scale">按比例</option>
              <option value="add">固定增减</option>
              <option value="set">统一设为</option>
            </select>
          </label>
          <label>
            调整值
            <span>
              <input
                type="number"
                value={bulkValue}
                onChange={(event) => setBulkValue(Number(event.target.value))}
              />
              <small>{bulkMode === "scale" ? "%" : "ms"}</small>
            </span>
          </label>
          <button className="button button-neutral" onClick={applyBulk}>
            生成统一调整
          </button>
        </div>
        {bulkError && (
          <div className="impact-dialog-error">
            <CircleAlert size={14} /> {bulkError}
          </div>
        )}

        <div className="impact-budget-preview">
          {budgetRows.map((row) => (
            <div key={row.label}>
              <span>{row.label}</span>
              <b>{formatMs(row.next)}</b>
              <em
                className={
                  row.next - row.base > 0
                    ? "worse"
                    : row.next - row.base < 0
                      ? "better"
                      : ""
                }
              >
                {formatDelta(row.next - row.base)}
              </em>
            </div>
          ))}
        </div>

        <div className="impact-adjust-table">
          <div className="impact-adjust-head">
            <span>节点</span>
            <span>类型</span>
            <span>耗时</span>
            <span>波动</span>
            <span>超时</span>
          </div>
          {preview.nodes.map((item) => {
            const values = draft[item.nodeId];
            return (
              <div className="impact-adjust-row" key={item.nodeId}>
                <span title={item.reasons.join("；")}>{item.name}</span>
                <em className={item.kind}>
                  {item.kind === "always" ? "必然" : "条件"}
                </em>
                <span>{values?.durationMs}</span>
                <span>{values?.jitterMs}</span>
                <span>{values?.timeoutMs}</span>
              </div>
            );
          })}
          {!impactedIds.size && <p>没有需要调整的下游节点。</p>}
        </div>

        {candidate.errors.length > 0 && (
          <div className="impact-dialog-error">
            <CircleAlert size={14} /> {candidate.errors[0]}
          </div>
        )}
        {applyErrors.length > 0 && (
          <div className="impact-dialog-error">
            <CircleAlert size={14} /> {applyErrors[0]}
          </div>
        )}

        <div className="impact-dialog-actions">
          <button className="button button-neutral" onClick={reset}>
            <RotateCcw size={13} /> 清空草稿
          </button>
          <button className="button button-neutral" onClick={onClose}>
            取消
          </button>
          <button
            className="button button-primary"
            disabled={candidate.errors.length > 0}
            onClick={confirm}
          >
            校验并确认 <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
