import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState, useRef } from 'react'
import {
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  Download,
  Upload,
  Tag,
  Database,
} from 'lucide-react'

import { getUserCategories } from '../lib/categories'
import {
  createCategory,
  updateCategory,
  deleteCategory,
} from '../lib/categories'
import { exportExpensesCSV, importExpensesCSV } from '../lib/csvTools'
import type { Category } from '../lib/domain'
import Header from '../components/Header'

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const Route = createFileRoute('/settings')({
  loader: async (): Promise<{ categories: Category[] }> => {
    const categories = await getUserCategories()
    return { categories }
  },
  component: SettingsPage,
})

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

type Tab = 'categories' | 'data'

function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('categories')

  return (
    <div className="min-h-screen bg-slate-900">
      <Header />
      <div className="max-w-xl mx-auto px-4 sm:px-6 pt-6 flex flex-col gap-6 pb-12">
        <h1 className="text-2xl font-bold text-white">Settings</h1>

        {/* Tab switcher */}
        <div className="flex gap-2">
          <TabButton
            label="Categories"
            icon={<Tag size={16} />}
            active={activeTab === 'categories'}
            onClick={() => setActiveTab('categories')}
          />
          <TabButton
            label="Data Tools"
            icon={<Database size={16} />}
            active={activeTab === 'data'}
            onClick={() => setActiveTab('data')}
          />
        </div>

        {activeTab === 'categories' ? <CategoriesTab /> : <DataToolsTab />}
      </div>
    </div>
  )
}

function TabButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors ${
        active
          ? 'bg-cyan-500 text-white'
          : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Categories Tab
// ---------------------------------------------------------------------------

function CategoriesTab() {
  const { categories } = Route.useLoaderData()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)

  // Add form state
  const [newName, setNewName] = useState('')
  const [newIcon, setNewIcon] = useState('')

  const refresh = () => router.invalidate()
  const withPending = async (fn: () => Promise<void>) => {
    setError(null)
    setIsPending(true)
    try {
      await fn()
      await refresh()
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong')
    } finally {
      setIsPending(false)
    }
  }

  const handleAdd = () =>
    withPending(async () => {
      await createCategory({ data: { name: newName, icon: newIcon || null } })
      setNewName('')
      setNewIcon('')
    })

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="p-3 bg-red-900/40 border border-red-700/50 rounded-xl text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Category list */}
      <div className="flex flex-col gap-2">
        {categories.length === 0 && (
          <p className="text-slate-500 text-sm text-center py-6">
            No categories yet. Add one below.
          </p>
        )}
        {categories.map((cat) => (
          <CategoryRow
            key={cat.id}
            category={cat}
            onMutate={refresh}
            onError={setError}
          />
        ))}
      </div>

      {/* Add new category */}
      <div className="bg-slate-800/60 rounded-2xl p-4 border border-slate-700/40 flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">
          Add Category
        </h3>
        <div className="flex gap-2">
          <input
            id="new-category-name"
            type="text"
            placeholder="Name (e.g. Coffee)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={40}
            className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500"
          />
          <input
            id="new-category-icon"
            type="text"
            placeholder="Icon (optional)"
            value={newIcon}
            onChange={(e) => setNewIcon(e.target.value)}
            className="w-32 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500"
          />
          <button
            id="add-category-btn"
            onClick={handleAdd}
            disabled={isPending || !newName.trim()}
            className="p-2 bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-white transition-colors"
            aria-label="Add category"
          >
            <Plus size={20} />
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Category Row (with inline rename)
// ---------------------------------------------------------------------------

function CategoryRow({
  category,
  onMutate,
  onError,
}: {
  category: Category
  onMutate: () => void
  onError: (msg: string) => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(category.name)
  const [editIcon, setEditIcon] = useState(category.icon ?? '')
  const [isPending, setIsPending] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)

  const save = async () => {
    setIsPending(true)
    try {
      await updateCategory({
        data: { id: category.id, name: editName, icon: editIcon || null },
      })
      onMutate()
      setIsEditing(false)
    } catch (e: any) {
      onError(e?.message ?? 'Failed to update category')
    } finally {
      setIsPending(false)
    }
  }

  const remove = async () => {
    setIsPending(true)
    try {
      await deleteCategory({ data: category.id })
      onMutate()
    } catch (e: any) {
      onError(e?.message ?? 'Failed to delete category')
      setDeleteConfirm(false)
    } finally {
      setIsPending(false)
    }
  }

  if (isEditing) {
    return (
      <div className="bg-slate-800/60 border border-cyan-500/40 rounded-xl px-3 py-2 flex items-center gap-2">
        <input
          autoFocus
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          maxLength={40}
          className="flex-1 bg-transparent text-white text-sm focus:outline-none"
        />
        <input
          type="text"
          value={editIcon}
          onChange={(e) => setEditIcon(e.target.value)}
          placeholder="icon"
          className="w-20 bg-transparent text-slate-400 text-sm focus:outline-none"
        />
        <button
          onClick={save}
          disabled={isPending || !editName.trim()}
          className="p-1 text-cyan-400 hover:text-cyan-300 disabled:opacity-50"
          aria-label="Save"
        >
          <Check size={18} />
        </button>
        <button
          onClick={() => setIsEditing(false)}
          className="p-1 text-slate-500 hover:text-slate-300"
          aria-label="Cancel"
        >
          <X size={18} />
        </button>
      </div>
    )
  }

  return (
    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl px-3 py-2 flex items-center gap-2 group">
      {category.icon && (
        <span className="text-xs bg-slate-700 px-2 py-0.5 rounded-md text-slate-300 font-mono">
          {category.icon}
        </span>
      )}
      <span className="flex-1 text-white text-sm">{category.name}</span>

      {deleteConfirm ? (
        <div className="flex items-center gap-1 text-xs text-red-400">
          <span>Delete?</span>
          <button
            onClick={remove}
            disabled={isPending}
            className="px-2 py-0.5 bg-red-900/60 hover:bg-red-800 rounded text-red-300 disabled:opacity-50"
          >
            Yes
          </button>
          <button
            onClick={() => setDeleteConfirm(false)}
            className="px-2 py-0.5 bg-slate-700 hover:bg-slate-600 rounded text-slate-300"
          >
            No
          </button>
        </div>
      ) : (
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => setIsEditing(true)}
            className="p-1 text-slate-500 hover:text-cyan-400 transition-colors"
            aria-label="Rename category"
          >
            <Pencil size={16} />
          </button>
          <button
            onClick={() => setDeleteConfirm(true)}
            className="p-1 text-slate-500 hover:text-red-400 transition-colors"
            aria-label="Delete category"
          >
            <Trash2 size={16} />
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Data Tools Tab
// ---------------------------------------------------------------------------

function DataToolsTab() {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [exportPending, setExportPending] = useState(false)
  const [importPending, setImportPending] = useState(false)
  const [importResult, setImportResult] = useState<{
    inserted: number
    skipped: number
    errors: string[]
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
