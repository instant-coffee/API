// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";
// import { isTypeAliasDeclaration } from "typescript";

export default tseslint.config(
  // -------------------------------------------------------------------
  // 1. Base JS recommended rules
  // -------------------------------------------------------------------
  eslint.configs.recommended,

  // -------------------------------------------------------------------
  // 2. TypeScript recommended rules (type-aware)
  // -------------------------------------------------------------------
  ...tseslint.configs.recommendedTypeChecked,

  // -------------------------------------------------------------------
  // 3. Parser + project config (required for type-aware rules)
  // -------------------------------------------------------------------
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // -------------------------------------------------------------------
  // 4. Project-wide rule overrides
  // -------------------------------------------------------------------
  {
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      // --- Prettier integration ---
      "prettier/prettier": "error",

      // --- NestJS conventions ---
      // Decorators use classes extensively — allow empty constructors
      "@typescript-eslint/no-extraneous-class": "off",

      // Interfaces (DTOs, guards, strategies) often have implicit returns
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",

      // Decorators like @Body(), @Param() can produce `any` — suppress noise
      "@typescript-eslint/no-explicit-any": "warn",

      // Allow unused vars prefixed with _ (common in NestJS strategy stubs)
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Unsafe assignments surface often with Passport/JWT — warn, not error
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",

      // Prefer `interface` over `type` for object shapes (NestJS convention)
      "@typescript-eslint/consistent-type-definitions": ["warn", "interface"],

      // Enforce explicit accessibility on class members
      // (NestJS services/controllers benefit from this clarity)
      "@typescript-eslint/explicit-member-accessibility": [
        "warn",
        { accessibility: "no-public" },
      ],

      // TODO WIP Fix before launch
      "@typescript-eslint/no-floating-promises": "off",
    },
  },

  // -------------------------------------------------------------------
  // 5. Prettier config last — disables any rules that conflict with formatting
  // -------------------------------------------------------------------
  prettierConfig,

  // -------------------------------------------------------------------
  // 6. Ignores (replaces .eslintignore)
  // -------------------------------------------------------------------
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
);
