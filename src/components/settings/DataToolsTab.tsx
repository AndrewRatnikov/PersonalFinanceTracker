import { useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { Download, Upload } from 'lucide-react'
import { exportExpensesCSV, importExpensesCSV } from '../../lib/csvTools'

export function DataToolsTab() {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [exportPending, setExportPending] = useState(false)
  const [importPending, setImportPending] = useState(false)
  const [importResult, setImportResult] = useState<{
    inserted: number
    skipped: number
    errors: Array<string>
  } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  // --- Export ---
  const handleExport = async () => {
    setExportPending(true)
    try {
      const csv = await exportExpensesCSV()
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'minima-spend-export.csv'
      a.click()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      console.error('Export failed:', e)
    } finally {
      setExportPending(false)
    }
  }

  // --- Import ---
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setImportError(null)
    setImportResult(null)
    setImportPending(true)

    try {
      const text = await file.text()
      const result = await importExpensesCSV({ data: text })
      setImportResult(result)
      await router.invalidate()
    } catch (err: any) {
      setImportError(err?.message ?? 'Import failed')
    } finally {
      setImportPending(false)
      // Reset input so same file can be re-selected
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Export */}
      <div className="bg-slate-800/60 rounded-2xl p-5 border border-slate-700/40 flex flex-col gap-3">
        <div>
          <h3 className="text-white font-semibold mb-1">Export to CSV</h3>
          <p className="text-slate-400 text-sm">
            Download all your expenses as a spreadsheet-compatible CSV file.
          </p>
        </div>
        <button
          id="export-csv-btn"
          onClick={handleExport}
          disabled={exportPending}
          className="self-start flex items-center gap-2 px-4 py-2 bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-xl transition-colors"
        >
          <Download size={16} />
          {exportPending ? 'Preparing…' : 'Download CSV'}
        </button>
      </div>

      {/* Import */}
      <div className="bg-slate-800/60 rounded-2xl p-5 border border-slate-700/40 flex flex-col gap-3">
        <div>
          <h3 className="text-white font-semibold mb-1">Import from CSV</h3>
          <p className="text-slate-400 text-sm">
            Upload a CSV in the export format. Categories must already exist.
            Columns:{' '}
            <code className="text-cyan-400">
              date, amount, currency, category, description
            </code>
            .
          </p>
        </div>

        <input
          ref={fileInputRef}
          id="import-csv-input"
          type="file"
          accept=".csv"
          onChange={handleFileChange}
          className="hidden"
        />

        <button
          id="import-csv-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={importPending}
          className="self-start flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-xl transition-colors"
        >
          <Upload size={16} />
          {importPending ? 'Importing…' : 'Choose CSV File'}
        </button>

        {importError && (
          <div className="p-3 bg-red-900/40 border border-red-700/50 rounded-xl text-red-300 text-sm">
            {importError}
          </div>
        )}

        {importResult && (
          <div className="p-3 bg-emerald-900/30 border border-emerald-700/40 rounded-xl text-sm flex flex-col gap-1">
            <p className="text-emerald-300 font-medium">
              ✓ {importResult.inserted} expense
              {importResult.inserted !== 1 ? 's' : ''} imported
              {importResult.skipped > 0 && `, ${importResult.skipped} skipped`}.
            </p>
            {importResult.errors.length > 0 && (
              <ul className="text-slate-400 list-disc list-inside mt-1 space-y-0.5">
                {importResult.errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
