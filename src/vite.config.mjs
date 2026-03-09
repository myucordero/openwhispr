import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_DEV_SERVER_PORT = 5191;

const parseDevServerPort = (rawPort) => {
  const normalizedPort = rawPort || String(DEFAULT_DEV_SERVER_PORT);
  const parsedPort = Number(normalizedPort);

  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    return DEFAULT_DEV_SERVER_PORT;
  }

  return parsedPort;
};

const chunkNameForId = (id) => {
  if (!id.includes("node_modules")) return null;

  if (id.includes("node_modules/lucide-react/")) {
    return "vendor-icons";
  }

  if (id.includes("node_modules/@radix-ui/")) {
    return "vendor-radix";
  }

  if (
    id.includes("node_modules/react-markdown/") ||
    id.includes("node_modules/remark-") ||
    id.includes("node_modules/rehype-") ||
    id.includes("node_modules/mdast-") ||
    id.includes("node_modules/micromark") ||
    id.includes("node_modules/unified/") ||
    id.includes("node_modules/vfile/") ||
    id.includes("node_modules/hast-util-") ||
    id.includes("node_modules/unist-util-")
  ) {
    return "vendor-markdown";
  }

  if (
    id.includes("node_modules/@neondatabase/auth/") ||
    id.includes("node_modules/better-auth/") ||
    id.includes("node_modules/@better-auth/") ||
    id.includes("node_modules/@tanstack/react-query/") ||
    id.includes("node_modules/@captchafox/react/") ||
    id.includes("node_modules/@hcaptcha/react-hcaptcha/") ||
    id.includes("node_modules/react-google-recaptcha/") ||
    id.includes("node_modules/react-qr-code/") ||
    id.includes("node_modules/@instantdb/") ||
    id.includes("node_modules/@triplit/")
  ) {
    return "vendor-auth";
  }

  if (
    id.includes("node_modules/react/") ||
    id.includes("node_modules/react-dom/") ||
    id.includes("node_modules/scheduler/")
  ) {
    return "vendor-react";
  }

  return null;
};

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const envDir = path.resolve(__dirname, "..");
  const env = loadEnv(mode, envDir, "");
  const rawPort = env.VITE_DEV_SERVER_PORT || env.OPENWHISPR_DEV_SERVER_PORT;
  const devServerPort = parseDevServerPort(rawPort);

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "write-runtime-env",
        writeBundle() {
          const runtimeEnv = {
            VITE_OPENWHISPR_API_URL: env.VITE_OPENWHISPR_API_URL || "",
            VITE_NEON_AUTH_URL: env.VITE_NEON_AUTH_URL || "",
          };
          fs.writeFileSync(
            path.resolve(__dirname, "dist", "runtime-env.json"),
            JSON.stringify(runtimeEnv)
          );
        },
      },
    ],
    base: "./", // Use relative paths for file:// protocol in Electron
    envDir, // Load .env from project root
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "."),
        i18next: path.resolve(__dirname, "lib/simpleI18n.ts"),
        "react-i18next": path.resolve(__dirname, "lib/reactI18nextShim.tsx"),
      },
    },
    server: {
      port: devServerPort,
      strictPort: true,
      host: "127.0.0.1", // Use IP address instead of localhost for Neon Auth CORS
    },
    build: {
      outDir: "dist",
      assetsDir: "assets",
      rollupOptions: {
        external: [
          "electron",
          "fs",
          "path",
          "child_process",
          "https",
          "http",
          "crypto",
          "os",
          "stream",
          "util",
          "zlib",
          "tar",
          "unzipper",
          "@aws-sdk/client-s3",
        ],
        output: {
          manualChunks(id) {
            return chunkNameForId(id);
          },
        },
      },
    },
  };
});
