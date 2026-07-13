// @ts-check
// Root eslint config — applies to all .ts/.tsx files in the monorepo from the
// pre-commit hook (which runs `pnpm exec eslint` from the repo root).
// Mirrors packages/berth/eslint.config.js so the root hook and per-package
// `pnpm lint` produce identical results.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "pnpm-lock.yaml",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
  },
  prettier,
);
