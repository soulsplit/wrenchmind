interface ToggleProps {
  checked: boolean
  onChange: (next: boolean) => void
  label?: string
}

export default function Toggle({ checked, onChange, label = 'Voice mode' }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`min-h-[48px] w-full px-4 py-3 rounded-lg font-bold shadow text-base active:scale-95 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 ${
        checked ? 'bg-green-500 text-white' : 'bg-white/90 text-black'
      }`}
    >
      {checked ? `Disable ${label}` : label}
    </button>
  )
}
