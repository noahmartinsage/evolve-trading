/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BINANCE_REST?: string
  readonly VITE_FEED_WS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
