import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyRequest) => {
            proxyRequest.setHeader("origin", apiTarget);
          });
        }
      },
      "/terminal": {
        target: "ws://localhost:3000",
        ws: true,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReqWs", (proxyRequest) => {
            proxyRequest.setHeader("origin", apiTarget);
          });
        }
      }
    }
  }
});
