import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // build/ and release/ hold generated bundles and binaries.
    ignores: [
      "dist/**",
      "build/**",
      "release/**",
      "node_modules/**",
      "coverage/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The CLI deliberately handles loosely-typed API responses.
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    files: ["test/**/*.ts", "*.config.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Build and release scripts are ordinary Node programs whose output is
    // meant for a terminal, so console is the right channel there.
    files: ["scripts/**"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "writable",
        __dirname: "readonly",
      },
    },
    rules: {
      "no-console": "off",
      // .cjs scripts are CommonJS on purpose, matching the Termix repo.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
