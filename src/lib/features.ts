export const WORKSPACES_ENABLED = import.meta.env.VITE_WORKSPACES_ENABLED === "true";

export const SHARING_ENABLED = import.meta.env.VITE_SHARING_ENABLED === "true";

// Local-only build: hide every cloud surface (sign-in/account, cloud
// transcription, cloud reasoning/agent providers, cloud onboarding steps). Set
// VITE_LOCAL_ONLY=1 (or "true") in .env at build time. Personal/offline builds.
export const LOCAL_ONLY_MODE =
  import.meta.env.VITE_LOCAL_ONLY === "true" || import.meta.env.VITE_LOCAL_ONLY === "1";
