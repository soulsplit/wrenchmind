import { useState, type FormEvent } from 'react'

interface QueryBarProps {
  onSubmit: (text: string) => void
  /** A photo picked from the device; the host freezes it like a still. */
  onPhotoSelect: (file: File) => void
}

/** Text fallback for the voice pipeline: noisy shops, unsupported browsers, testing. */
export default function QueryBar({ onSubmit, onPhotoSelect }: QueryBarProps) {
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
      className="flex items-center gap-2 w-full"
      aria-label="Text query"
    >
      {/*
        Photo upload: a (+) circle left of the input. The label opens the
        system picker; the host decodes the file into a still that behaves
        exactly like a frozen camera frame (tap/circle to identify).
      */}
      <label
        className="min-h-[48px] min-w-[48px] shrink-0 rounded-full bg-black ring-1 ring-white/20 text-white flex items-center justify-center motion-safe:active:scale-95 transition cursor-pointer focus-within:outline-none focus-within:ring-2 focus-within:ring-white/80"
      >
        <span aria-hidden="true" className="text-2xl font-bold leading-none">
          +
        </span>
        <input
          type="file"
          accept="image/*"
          aria-label="Upload photo"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0]
            // Reset so picking the same photo twice still fires.
            event.target.value = ''
            if (file) onPhotoSelect(file)
          }}
        />
      </label>
      <input
        type="text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Ask, e.g. show me the blend door"
        aria-label="Query text"
        enterKeyHint="send"
        autoComplete="off"
        className="min-h-[48px] flex-1 min-w-0 px-3 py-2 rounded-lg bg-black/70 text-white placeholder:text-white/60 text-base outline-none border border-white/20 focus:border-white/60 focus-visible:ring-2 focus-visible:ring-white/60"
      />
      <button
        type="submit"
        className="min-h-[48px] min-w-[48px] shrink-0 px-4 py-2 rounded-lg bg-white/90 text-black font-bold shadow text-base motion-safe:active:scale-95 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2"
      >
        Send
      </button>
    </form>
  )
}
