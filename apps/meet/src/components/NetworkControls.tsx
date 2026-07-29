import { useStore } from '../store';

const PRESETS = [
  { label: 'Normal', kbps: 6000 },
  { label: 'Moderate', kbps: 4000 },
  { label: 'Constrained', kbps: 3000 },
  { label: 'Severe', kbps: 1500 },
  { label: 'Critical', kbps: 800 },
];

interface NetworkControlsProps {
  onBandwidthChange?: (kbps: number) => void;
}

export function NetworkControls({ onBandwidthChange }: NetworkControlsProps) {
  const bandwidthCapKbps = useStore((s) => s.bandwidthCapKbps);
  const setBandwidthCapKbps = useStore((s) => s.setBandwidthCapKbps);
  const gridLayout = useStore((s) => s.gridLayout);
  const setGridLayout = useStore((s) => s.setGridLayout);
  const rankMode = useStore((s) => s.rankMode);
  const setRankMode = useStore((s) => s.setRankMode);
  const simulcastEnabled = useStore((s) => s.simulcastEnabled);
  const setSimulcastEnabled = useStore((s) => s.setSimulcastEnabled);

  const handleBandwidthChange = (kbps: number) => {
    setBandwidthCapKbps(kbps);
    onBandwidthChange?.(kbps);
  };

  return (
    <div className="rounded-xl bg-gray-800/80 p-4 backdrop-blur-sm">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-400">
        Demo Controls
      </h3>

      {/* Grid Layout */}
      <div className="mb-4">
        <label className="mb-1 block text-xs text-gray-500">Grid Layout</label>
        <div className="flex gap-2">
          <button
            onClick={() => setGridLayout('1x2')}
            className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
              gridLayout === '1x2'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            1x2
          </button>
          <button
            onClick={() => setGridLayout('2x2')}
            className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
              gridLayout === '2x2'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            2x2
          </button>
        </div>
      </div>

      {/* Simulcast Toggle */}
      <div className="mb-4">
        <label className="flex items-center gap-2 text-xs text-gray-500">
          <input
            type="checkbox"
            checked={simulcastEnabled}
            onChange={(e) => setSimulcastEnabled(e.target.checked)}
            className="rounded"
          />
          Simulcast (3 layers)
        </label>
      </div>

      {/* Rank Mode */}
      <div className="mb-4">
        <label className="mb-1 block text-xs text-gray-500">Rank Mode</label>
        <div className="flex gap-2">
          <button
            onClick={() => setRankMode('equal')}
            className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
              rankMode === 'equal'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            Equal
          </button>
          <button
            onClick={() => setRankMode('speaker-priority')}
            className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
              rankMode === 'speaker-priority'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            Speaker Priority
          </button>
        </div>
      </div>

      {/* Bandwidth Slider */}
      <div className="mb-3">
        <label className="mb-1 flex items-center justify-between text-xs text-gray-500">
          <span>Bandwidth Cap</span>
          <span className="font-mono text-gray-300">{bandwidthCapKbps} kbps</span>
        </label>
        <input
          type="range"
          min={500}
          max={8000}
          step={100}
          value={bandwidthCapKbps}
          onChange={(e) => handleBandwidthChange(Number(e.target.value))}
          className="w-full accent-blue-500"
        />
      </div>

      {/* Bandwidth Presets */}
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            onClick={() => handleBandwidthChange(preset.kbps)}
            className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
              bandwidthCapKbps === preset.kbps
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}
