import { useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { Download, Upload } from 'lucide-react'
import { exportExpensesCSV, importExpensesCSV } from '@/lib/csvTools'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

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
      <Card className="bg-slate-800/60 border-slate-700/40">
        <CardHeader>
          <CardTitle className="text-white text-lg">Export to CSV</CardTitle>
          <CardDescription className="text-slate-400">
            Download all your expenses as a spreadsheet-compatible CSV file.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            id="export-csv-btn"
            onClick={handleExport}
            disabled={exportPending}
            className="flex items-center gap-2 bg-cyan-500 hover:bg-cyan-600 text-white"
          >
            <Download size={16} />
            {exportPending ? 'Preparing…' : 'Download CSV'}
          </Button>
        </CardContent>
      </Card>

      {/* Import */}
      <Card className="bg-slate-800/60 border-slate-700/40">
        <CardHeader>
          <CardTitle className="text-white text-lg">Import from CSV</CardTitle>
          <CardDescription className="text-slate-400">
            Upload a CSV in the export format. Categories must already exist.
            Columns:{' '}
            <code className="text-cyan-400">
              date, amount, currency, category, description
            </code>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <input
            ref={fileInputRef}
            id="import-csv-input"
            type="file"
            accept=".csv"
            onChange={handleFileChange}
            className="hidden"
          />

          <Button
            id="import-csv-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={importPending}
            variant="secondary"
            className="self-start flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white"
          >
            <Upload size={16} />
            {importPending ? 'Importing…' : 'Choose CSV File'}
          </Button>

          {importError && (
            <Alert variant="destructive" className="bg-red-900/40 border-red-700/50 text-red-300">
              <AlertDescription>{importError}</AlertDescription>
            </Alert>
          )}

          {importResult && (
            <Alert className="bg-emerald-900/30 border-emerald-700/40 text-emerald-300">
              <AlertTitle className="flex items-center gap-2">
                ✓ {importResult.inserted} expense{importResult.inserted !== 1 ? 's' : ''} imported
                {importResult.skipped > 0 && `, ${importResult.skipped} skipped`}.
              </AlertTitle>
              {importResult.errors.length > 0 && (
                <AlertDescription>
                  <ul className="text-slate-400 list-disc list-inside mt-1 space-y-0.5">
                    {importResult.errors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </AlertDescription>
              )}
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
