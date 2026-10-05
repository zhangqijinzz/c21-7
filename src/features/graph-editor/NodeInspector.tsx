import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { LatencyProject, RequestNode } from "../../shared/domain/types";
import type { EditableNodeField } from "./graphViewModel";
import type {
  BatchAdjustment,
  ImpactPreview,
} from "../../shared/domain/impact";
import ImpactPreviewPanel from "./ImpactPreview";

interface Props {
  project: LatencyProject;
  node: RequestNode;
  onPatch: (id: string, patch: Partial<RequestNode>) => void;
  onDelete: (id: string) => void;
  onDependency: (id: string, dependencyId: string) => void;
  onCommitImpact: (
    id: string,
    patch: Partial<RequestNode>,
    batch?: BatchAdjustment,
  ) => { preview?: ImpactPreview; errors?: string[] };
  appliedPreview?: ImpactPreview;
}

const numericFields: {
  key: Exclude<EditableNodeField, "name">;
  label: string;
  suffix: string;
  step: number;
  max?: number;
}[] = [
  { key: "durationMs", label: "预计耗时", suffix: "ms", step: 10 },
  { key: "jitterMs", label: "延迟波动", suffix: "±ms", step: 10 },
  { key: "timeoutMs", label: "超时阈值", suffix: "ms", step: 50 },
  { key: "retryCount", label: "重试次数", suffix: "次", step: 1, max: 8 },
  { key: "failureRate", label: "失败概率", suffix: "%", step: 1, max: 100 },
];

export default function NodeInspector({
  project,
  node,
  onPatch,
  onDelete,
  onDependency,
  onCommitImpact,
  appliedPreview,
}: Props) {
  const [pendingDelete, setPendingDelete] = useState(false);
  const [numericDraft, setNumericDraft] = useState(() =>
    Object.fromEntries(
      numericFields.map(({ key }) => [key, String(node[key])]),
    ) as Record<Exclude<EditableNodeField, "name">, string>,
  );
  const draftPatch: Partial<RequestNode> = Object.fromEntries(
    numericFields.map(({ key }) => [key, Number(numericDraft[key])]),
  );
  const draftIsDirty = numericFields.some(
    ({ key }) => Number(numericDraft[key]) !== node[key],
  );
  const updateDraft = (
    key: Exclude<EditableNodeField, "name">,
    value: string,
  ) => setNumericDraft((current) => ({ ...current, [key]: value }));
  return (
    <>
      <aside className="inspector">
        <div className="inspector-heading">
          <span className="eyebrow">NODE INSPECTOR</span>
          <button
            className="icon-button danger-button"
            title="删除节点"
            aria-label="删除节点"
            onClick={() => setPendingDelete(true)}
          >
            <Trash2 size={15} />
          </button>
        </div>
        <label className="field-label">
          节点名称
          <input
            className="text-input"
            value={node.name}
            onChange={(event) => onPatch(node.id, { name: event.target.value })}
          />
        </label>
        <div className="field-grid">
          {numericFields.map(({ key, label, suffix, step, max }) => (
            <label className="field-label" key={key}>
              {label}
              <span className="number-wrap">
                <input
                  type="number"
                  min="0"
                  max={max}
                  step={step}
                  value={numericDraft[key]}
                  onChange={(event) =>
                    updateDraft(key, event.target.value)
                  }
                />
                <small>{suffix}</small>
              </span>
            </label>
          ))}
        </div>
        <div className="dependency-section">
          <div className="field-title">
            前置依赖 <span>{node.dependencyIds.length} 已选</span>
          </div>
          <div className="dependency-list">
            {project.nodes
              .filter((item) => item.id !== node.id)
              .map((item) => (
                <label className="dependency-option" key={item.id}>
                  <input
                    type="checkbox"
                    checked={node.dependencyIds.includes(item.id)}
                    onChange={() => onDependency(node.id, item.id)}
                  />
                  <span className="checkmark" />
                  <span>{item.name}</span>
                </label>
              ))}
          </div>
        </div>
        <label className="field-label fallback-field">
          失败后降级到
          <select
            className="text-input"
            value={node.fallbackNodeId ?? ""}
            onChange={(event) =>
              onPatch(node.id, {
                fallbackNodeId: event.target.value || undefined,
              })
            }
          >
            <option value="">不设置降级</option>
            {project.nodes
              .filter((item) => item.id !== node.id)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
          <small className="field-note">
            数值参数先保存在草稿中；在下方预览影响面并统一确认后才会生效。
          </small>
        </label>
      </aside>
      <ImpactPreviewPanel
        project={project}
        node={node}
        draft={draftPatch}
        draftIsDirty={draftIsDirty}
        appliedPreview={draftIsDirty ? undefined : appliedPreview}
        onApply={(patch, batch) => onCommitImpact(node.id, patch, batch)}
      />
      {pendingDelete && (
        <div className="dialog-backdrop" role="presentation">
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-node-title"
          >
            <span className="dialog-icon">
              <Trash2 size={18} />
            </span>
            <h2 id="delete-node-title">移除这个请求节点？</h2>
            <p>“{node.name}”会从链路移除，其他节点对它的依赖也会清除。</p>
            <div>
              <button
                className="button button-neutral"
                onClick={() => setPendingDelete(false)}
              >
                取消
              </button>
              <button
                className="button button-danger"
                onClick={() => {
                  onDelete(node.id);
                  setPendingDelete(false);
                }}
              >
                移除节点
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
