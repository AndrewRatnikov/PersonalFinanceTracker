import { useState } from 'react'

export default function SpeedEntryForm({
  categories,
  onSubmit,
  isPending,
}: {
  categories: any[]
  onSubmit: (data: {
    amount: number
    currency: string
    category_id: string
  }) => void
  isPending?: boolean
}) {
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('UAH')
  // Automatically select the first category if available
  const [categoryId, setCategoryId] = useState(categories[0]?.id || '')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!amount || !categoryId) return
    onSubmit({ amount: Number(amount), currency, category_id: categoryId })
    // Reset form after submit
    setAmount('')
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-4 bg-slate-800/40 p-6 rounded-2xl border border-slate-700/50"
    >
      <div className="flex gap-4 items-end">
        <label className="flex-1">
          <span className="text-sm text-slate-400 mb-1 block">Amount</span>
          <input
            type="number"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-4 text-3xl font-bold text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-colors"
            placeholder="0.00"
            required
            disabled={isPending}
          />
        </label>

        <label className="w-28">
          <span className="text-sm text-slate-400 mb-1 block">Currency</span>
          <div className="relative">
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              disabled={isPending}
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-4 text-xl font-bold text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 appearance-none cursor-pointer"
            >
              <option value="UAH">UAH</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-400">
              <svg
                className="fill-current h-4 w-4"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
              >
                <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
              </svg>
            </div>
          </div>
        </label>
      </div>

      <label>
        <span className="text-sm text-slate-400 mb-1 block">Category</span>
        <div className="relative">
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            disabled={isPending}
            className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-4 text-lg text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 appearance-none cursor-pointer"
            required
          >
            <option value="" disabled>
              Select a category
            </option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.icon ? `${cat.icon} ` : ''}
                {cat.name}
              </option>
            ))}
          </select>
          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-slate-400">
            <svg
              className="fill-current h-4 w-4"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
            >
              <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
            </svg>
          </div>
        </div>
      </label>

      <button
        type="submit"
        disabled={isPending}
        className="w-full bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-4 rounded-xl text-lg shadow-lg shadow-cyan-500/30 transition-all mt-2"
      >
        {isPending ? 'Saving...' : 'Save Expense'}
      </button>
    </form>
  )
}
