import { GlassPanel } from '@moq-web/app-kit/shell';

export interface VodAsset {
  id: string;
  title: string;
  durationMs: number;
  sizeBytes: number;
}

interface AssetPickerProps {
  assets: VodAsset[];
  selected: VodAsset;
  onSelect: (a: VodAsset) => void;
}

const humanMB = (bytes: number) => `${(bytes / 1_000_000).toFixed(0)} MB`;
const humanMin = (ms: number) => {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${s}s`;
};

export function AssetPicker({ assets, selected, onSelect }: AssetPickerProps) {
  return (
    <GlassPanel padding="md">
      <div className="ak-row-between" style={{ marginBottom: 12 }}>
        <div className="ak-heading">Asset library</div>
        <span className="ak-subtle">Pick one to play</span>
      </div>
      <div className="ak-grid-3">
        {assets.map((a) => {
          const active = a.id === selected.id;
          return (
            <button
              key={a.id}
              onClick={() => onSelect(a)}
              className="ak-glass"
              style={{
                padding: 12,
                cursor: 'pointer',
                textAlign: 'left',
                border: active ? '1px solid var(--ak-accent)' : '1px solid var(--ak-border)',
                background: active ? 'var(--ak-accent-soft)' : 'var(--ak-bg-elev)',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13 }}>{a.title}</div>
              <div className="ak-subtle" style={{ marginTop: 4 }}>
                {humanMin(a.durationMs)} · {humanMB(a.sizeBytes)}
              </div>
            </button>
          );
        })}
      </div>
    </GlassPanel>
  );
}
