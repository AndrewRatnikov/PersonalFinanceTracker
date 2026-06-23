import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Download, Upload } from 'lucide-react'
import { exportAllLocalData } from '@/lib/localExport'
import { importLocalDataFile } from '@/lib/localImport'
import type { ImportResult } from '@/lib/localImport'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

interface FileImportResult {
  filename: string
  type: string
  result: ImportResult
}

export function DataToolsTab() {
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [exportPending, setExportPending] = useState(false)
  const [importPending, setImportPending] = useState(false)
  const [importResults, setImportResults] = useState<Array<FileImportResult> | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const handleExport = async () => {
    setExportPending(true)
    try {
      await exportAllLocalData()
    } catch (e: any) {
      console.error('Export failed:', e)
    } finally {
      setExportPending(false)
    }
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return

    setImportError(null)
    setImportResults(null)
    setImportPending(true)

    try {
      // Import in dependency order: categories first, then the rest in parallel
      const categories = files.filter((f) => f.name.toLowerCase().includes('categories'))
      const rest = files.filter((f) => !f.name.toLowerCase().includes('categories'))

      const results: Array<FileImportResult> = []

      for (const file of categories) {
        const { type, result } = await importLocalDataFile(file)
        results.push({ filename: file.name, type, result })
      }

      const restResults = await Promise.all(
        rest.map(async (file) => {
          const { type, result } = await importLocalDataFile(file)
          return { filename: file.name, type, result }
        }),
      )
      results.push(...restResults)

      setImportResults(results)
      queryClient.invalidateQueries()
    } catch (err: any) {
      setImportError(err?.message ?? 'Import failed')
    } finally {
      setImportPending(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Export */}
      <Card className="bg-card/50 border-border backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="text-lg">Export to CSV</CardTitle>
          <CardDescription>
            Download all your data as CSV files: expenses, income, categories, and budgets.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            id="export-csv-btn"
            onClick={handleExport}
            disabled={exportPending}
            className="flex items-center gap-2"
          >
            <Download size={16} />
            {exportPending ? 'Preparing…' : 'Download CSV'}
          </Button>
        </CardContent>
      </Card>

      {/* Import */}
      <Card className="bg-card/50 border-border backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="text-lg">Import from CSV</CardTitle>
          <CardDescription>
            Upload one or more CSV files from a Minima export (expenses.csv, income.csv,
            categories.csv, budgets.csv). Import categories before expenses or budgets.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <input
            ref={fileInputRef}
            id="import-csv-input"
            type="file"
            accept=".csv"
            multiple
            onChange={handleFileChange}
            className="hidden"
          />

          <Button
            id="import-csv-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={importPending}
            variant="secondary"
            className="self-start flex items-center gap-2"
          >
            <Upload size={16} />
            {importPending ? 'Importing…' : 'Choose CSV Files'}
          </Button>

          {importError && (
            <Alert variant="destructive" className="bg-destructive/10">
              <AlertDescription>{importError}</AlertDescription>
            </Alert>
          )}

          {importResults && (
            <Alert className="bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400">
              <AlertTitle className="text-sm font-medium mb-2">Import complete</AlertTitle>
              <AlertDescription>
                <ul className="flex flex-col gap-1.5">
                  {importResults.map(({ filename, result }) => (
                    <li key={filename}>
                      <span className="font-mono text-xs">{filename}</span>
                      {' — '}
                      <span>
                        {result.inserted} inserted
                        {result.skipped > 0 && `, ${result.skipped} skipped`}
                      </span>
                      {result.errors.length > 0 && (
                        <ul className="text-muted-foreground text-xs list-disc list-inside mt-1 space-y-0.5">
                          {result.errors.map((err, i) => (
                            <li key={i}>{err}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
