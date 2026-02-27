interface TabButtonProps {
  label: string
  icon: React.ReactNode
  active: boolean
  onClick: () => void
}

export function TabButton({ label, icon, active, onClick }: TabButtonProps) {
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
