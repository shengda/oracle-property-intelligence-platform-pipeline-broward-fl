import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      "vendor/",
      "work/",
      "runs/",
      "cache/",
      "bin/",
      "fixtures/",
      "cdk.out/",
      "infra/cdk.out/",
      "ui/dist/",
      "test-results/",
      "playwright-report/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "@anthropic-ai/sdk", message: "Use the Vercel AI SDK (ai + @ai-sdk/anthropic)." }],
        },
      ],
    },
  },
);
