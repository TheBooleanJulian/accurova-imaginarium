/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `server` to use the Imaginarium API; anything else runs the browser-only demo. */
  readonly VITE_BACKEND?: string;
  /** API origin when the frontend and API are hosted separately. Empty = same origin. */
  readonly VITE_API_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
