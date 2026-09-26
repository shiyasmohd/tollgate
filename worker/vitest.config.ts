import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            MASTER_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
            SESSION_SECRET: "test-session-secret",
            // onchain verification on, against a stubbed MultiBaas (test/onchain.test.ts)
            MULTIBAAS_URL: "https://multibaas.test",
            MULTIBAAS_API_KEY: "test-mb-key",
            MULTIBAAS_WEBHOOK_SECRET: "test-webhook-secret",
            MULTIBAAS_SYNC_FROM: "", // tests make calls minutes in the past; the deployed value would mark them untracked
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
