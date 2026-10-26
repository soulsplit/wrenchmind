import { useState, type FormEvent } from 'react'

interface QueryBarProps {
  onSubmit: (text: string) => void
}

/** Text fallback for the voice pipeline: noisy shops, unsupported browsers, testing. */
export default function QueryBar({ onSubmit }: QueryBarProps) {
  const [value, setValue] = useState('')

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    const text = value.trim()
    if (!text) return
    setValue('')
    onSubmit(text)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-center gap-2"
      aria-label="Text query"
    >
      <input
        type="text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Ask, e.g. show me the blend door"
        aria-label="Query text"
        enterKeyHint="send"
        autoComplete="off"
        className="min-h-[48px] w-56 px-3 py-2 rounded-lg bg-black/70 text-white placeholder:text-white/60 text-base outline-none border border-white/20 focus:border-white/60 sm:w-72"
      />
      <button
        type="submit"
        className="min-h-[48px] min-w-[48px] px-4 py-2 rounded-lg bg-white/90 text-black font-bold shadow text-base active:scale-95 transition"
      >
        Send
      </button>
    </form>
  )
}
