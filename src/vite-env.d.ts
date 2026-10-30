/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_META_MODEL_API_KEY: string | undefined
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
