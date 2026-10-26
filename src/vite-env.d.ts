/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_META_MODEL_API_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
