import { useState } from 'react';
import { benchmark, CompressionResult } from './compression';
import {
  generateCatalog,
  generateMediaTimeline,
  generateEventTimeline,
  CatalogOptions,
  MediaTimelineOptions,
  EventTimelineOptions,
} from './generators';

type DataType = 'catalog' | 'mediaTimeline' | 'eventTimeline' | 'custom';

interface BenchmarkEntry {
  id: number;
  type: DataType;
  description: string;
  result: CompressionResult;
  json: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function App() {
  const [results, setResults] = useState<BenchmarkEntry[]>([]);
  const [selectedJson, setSelectedJson] = useState<string | null>(null);
  const [customJson, setCustomJson] = useState('');
  const [isRunning, setIsRunning] = useState(false);

  const [catalogOptions, setCatalogOptions] = useState<CatalogOptions>({
    numTracks: 4,
    includeInitData: true,
    initDataSize: 1024,
  });

  const [timelineOptions, setTimelineOptions] = useState<MediaTimelineOptions>({
    numEntries: 100,
    format: 'explicit',
    gopDuration: 2000,
  });

  const [eventOptions, setEventOptions] = useState<EventTimelineOptions>({
    numEvents: 100,
    eventType: 'sports',
  });

  const runBenchmark = async (type: DataType, json: string, description: string) => {
    setIsRunning(true);
    try {
      const result = await benchmark(json);
      setResults(prev => [
        ...prev,
        {
          id: Date.now(),
          type,
          description,
          result,
          json,
        },
      ]);
    } finally {
      setIsRunning(false);
    }
  };

  const runCatalogBenchmark = () => {
    const json = generateCatalog(catalogOptions);
    const desc = `Catalog: ${catalogOptions.numTracks} tracks${catalogOptions.includeInitData ? `, ${formatBytes(catalogOptions.initDataSize)} init data` : ''}`;
    runBenchmark('catalog', json, desc);
  };

  const runTimelineBenchmark = () => {
    const json = generateMediaTimeline(timelineOptions);
    const desc = `Media Timeline: ${timelineOptions.numEntries} entries (${timelineOptions.format})`;
    runBenchmark('mediaTimeline', json, desc);
  };

  const runEventBenchmark = () => {
    const json = generateEventTimeline(eventOptions);
    const desc = `Event Timeline: ${eventOptions.numEvents} ${eventOptions.eventType} events`;
    runBenchmark('eventTimeline', json, desc);
  };

  const runCustomBenchmark = () => {
    if (!customJson.trim()) return;
    try {
      JSON.parse(customJson);
      runBenchmark('custom', customJson, 'Custom JSON');
    } catch {
      alert('Invalid JSON');
    }
  };

  const clearResults = () => {
    setResults([]);
    setSelectedJson(null);
  };

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">MSF Compression Benchmark</h1>
        <p className="text-gray-400 mb-8">
          Test GZIP compression effectiveness on MSF catalogs, media timelines, and event timelines
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          {/* Catalog */}
          <div className="bg-gray-800 rounded-lg p-6">
            <h2 className="text-xl font-semibold mb-4">Catalog</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Number of tracks</label>
                <input
                  type="number"
                  value={catalogOptions.numTracks}
                  onChange={e => setCatalogOptions(prev => ({ ...prev, numTracks: parseInt(e.target.value) || 1 }))}
                  className="w-full bg-gray-700 rounded px-3 py-2"
                  min={1}
                  max={100}
                />
              </div>
              <div>
                <label className="flex items-center gap-2 text-sm text-gray-400">
                  <input
                    type="checkbox"
                    checked={catalogOptions.includeInitData}
                    onChange={e => setCatalogOptions(prev => ({ ...prev, includeInitData: e.target.checked }))}
                    className="rounded"
                  />
                  Include init data
                </label>
              </div>
              {catalogOptions.includeInitData && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Init data size (bytes)</label>
                  <input
                    type="number"
                    value={catalogOptions.initDataSize}
                    onChange={e => setCatalogOptions(prev => ({ ...prev, initDataSize: parseInt(e.target.value) || 0 }))}
                    className="w-full bg-gray-700 rounded px-3 py-2"
                    min={0}
                    step={256}
                  />
                </div>
              )}
              <button
                onClick={runCatalogBenchmark}
                disabled={isRunning}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded px-4 py-2 font-medium"
              >
                Run Benchmark
              </button>
            </div>
          </div>

          {/* Media Timeline */}
          <div className="bg-gray-800 rounded-lg p-6">
            <h2 className="text-xl font-semibold mb-4">Media Timeline</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Number of entries</label>
                <input
                  type="number"
                  value={timelineOptions.numEntries}
                  onChange={e => setTimelineOptions(prev => ({ ...prev, numEntries: parseInt(e.target.value) || 1 }))}
                  className="w-full bg-gray-700 rounded px-3 py-2"
                  min={1}
                  max={10000}
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Format</label>
                <select
                  value={timelineOptions.format}
                  onChange={e => setTimelineOptions(prev => ({ ...prev, format: e.target.value as MediaTimelineOptions['format'] }))}
                  className="w-full bg-gray-700 rounded px-3 py-2"
                >
                  <option value="explicit">Explicit entries</option>
                  <option value="template">Template only</option>
                  <option value="mixed">Mixed</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">GOP duration (ms)</label>
                <input
                  type="number"
                  value={timelineOptions.gopDuration}
                  onChange={e => setTimelineOptions(prev => ({ ...prev, gopDuration: parseInt(e.target.value) || 1000 }))}
                  className="w-full bg-gray-700 rounded px-3 py-2"
                  min={100}
                  step={100}
                />
              </div>
              <button
                onClick={runTimelineBenchmark}
                disabled={isRunning}
                className="w-full bg-green-600 hover:bg-green-700 disabled:bg-gray-600 rounded px-4 py-2 font-medium"
              >
                Run Benchmark
              </button>
            </div>
          </div>

          {/* Event Timeline */}
          <div className="bg-gray-800 rounded-lg p-6">
            <h2 className="text-xl font-semibold mb-4">Event Timeline</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Number of events</label>
                <input
                  type="number"
                  value={eventOptions.numEvents}
                  onChange={e => setEventOptions(prev => ({ ...prev, numEvents: parseInt(e.target.value) || 1 }))}
                  className="w-full bg-gray-700 rounded px-3 py-2"
                  min={1}
                  max={10000}
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Event type</label>
                <select
                  value={eventOptions.eventType}
                  onChange={e => setEventOptions(prev => ({ ...prev, eventType: e.target.value as EventTimelineOptions['eventType'] }))}
                  className="w-full bg-gray-700 rounded px-3 py-2"
                >
                  <option value="sports">Sports scores</option>
                  <option value="gps">GPS tracking</option>
                  <option value="speaker">Active speaker</option>
                </select>
              </div>
              <button
                onClick={runEventBenchmark}
                disabled={isRunning}
                className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 rounded px-4 py-2 font-medium"
              >
                Run Benchmark
              </button>
            </div>
          </div>
        </div>

        {/* Custom JSON */}
        <div className="bg-gray-800 rounded-lg p-6 mb-8">
          <h2 className="text-xl font-semibold mb-4">Custom JSON</h2>
          <textarea
            value={customJson}
            onChange={e => setCustomJson(e.target.value)}
            placeholder="Paste your own JSON here..."
            className="w-full bg-gray-700 rounded px-3 py-2 h-32 font-mono text-sm mb-4"
          />
          <button
            onClick={runCustomBenchmark}
            disabled={isRunning || !customJson.trim()}
            className="bg-orange-600 hover:bg-orange-700 disabled:bg-gray-600 rounded px-4 py-2 font-medium"
          >
            Run Benchmark
          </button>
        </div>

        {/* Results */}
        {results.length > 0 && (
          <div className="bg-gray-800 rounded-lg p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold">Results</h2>
              <button
                onClick={clearResults}
                className="bg-red-600 hover:bg-red-700 rounded px-3 py-1 text-sm font-medium"
              >
                Clear Results
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-gray-700">
                    <th className="pb-2 pr-4">Type</th>
                    <th className="pb-2 pr-4">Description</th>
                    <th className="pb-2 pr-4 text-right">Original</th>
                    <th className="pb-2 pr-4 text-right">Compressed</th>
                    <th className="pb-2 pr-4 text-right">Ratio</th>
                    <th className="pb-2 text-right">Savings</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map(entry => (
                    <tr
                      key={entry.id}
                      className="border-b border-gray-700 hover:bg-gray-750 cursor-pointer"
                      onClick={() => setSelectedJson(selectedJson === entry.json ? null : entry.json)}
                    >
                      <td className="py-3 pr-4">
                        <span className={`px-2 py-1 rounded text-xs font-medium ${
                          entry.type === 'catalog' ? 'bg-blue-600' :
                          entry.type === 'mediaTimeline' ? 'bg-green-600' :
                          entry.type === 'eventTimeline' ? 'bg-purple-600' :
                          'bg-orange-600'
                        }`}>
                          {entry.type}
                        </span>
                      </td>
                      <td className="py-3 pr-4">{entry.description}</td>
                      <td className="py-3 pr-4 text-right font-mono">{formatBytes(entry.result.originalSize)}</td>
                      <td className="py-3 pr-4 text-right font-mono">{formatBytes(entry.result.compressedSize)}</td>
                      <td className="py-3 pr-4 text-right font-mono">{entry.result.ratio.toFixed(3)}</td>
                      <td className={`py-3 text-right font-mono font-semibold ${
                        entry.result.savings > 50 ? 'text-green-400' :
                        entry.result.savings > 20 ? 'text-yellow-400' :
                        'text-red-400'
                      }`}>
                        {entry.result.savings.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {selectedJson && (
              <div className="mt-4">
                <h3 className="text-sm text-gray-400 mb-2">JSON Preview (click row to toggle)</h3>
                <pre className="bg-gray-900 rounded p-4 overflow-auto max-h-64 text-sm font-mono">
                  {selectedJson}
                </pre>
              </div>
            )}
          </div>
        )}

        <footer className="mt-8 text-center text-gray-500 text-sm">
          <p>
            Uses browser-native <code className="bg-gray-800 px-1 rounded">CompressionStream</code> API for GZIP compression.
          </p>
          <p className="mt-1">
            Part of the <a href="https://datatracker.ietf.org/doc/draft-ietf-moq-msf/" className="text-blue-400 hover:underline">MOQT Streaming Format (MSF)</a> specification.
          </p>
        </footer>
      </div>
    </div>
  );
}
