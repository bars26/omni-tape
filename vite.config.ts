import { defineConfig, type Plugin } from "vite";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";

// In dev, serve ./local-data at /local-data so `VITE_DATA_BASE=/local-data npm run dev`
// works against snapshots taken with `npm run collect`.
function localData(): Plugin {
  return {
    name: "local-data",
    configureServer(server) {
      server.middlewares.use("/local-data", async (req, res) => {
        const rel = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "");
        try {
          const body = await readFile(join(process.cwd(), "local-data", rel));
          res.setHeader("content-type", rel.endsWith(".json") ? "application/json" : "text/plain");
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.end("not found");
        }
      });
    },
  };
}

export default defineConfig({ plugins: [localData()] });
