import js from "@eslint/js";
import globals from "globals";

const browserShellFiles = [
  "renderer/**/*.js",
  "plugins/official/**/view/**/*.js",
];

const rendererContextCompositionFiles = [
  "renderer/app/renderer-app-controller-composition.js",
  "renderer/app/renderer-app-lifecycle-composition.js",
];

export default [
  {
    ignores: [
      "archive/**",
      "dist/**",
      "node_modules/**",
      // Generated sandboxed preload bundle (gitignored; rebuilt by
      // scripts/build/build-preload.js on every dev launch) — minified
      // output, never lint it.
      "preload.bundle.js",
      "PORT_BUNDLES/**",
      ".claude/**",
      ".venv/**",
      ".tmp/**",
      ".spec-first/**",
      // App-owned workspace scratch dir (gitignored); may hold arbitrary user/demo files.
      ".jenny/**",
      "vendor/**",
      "artifacts/**",
      "prototypes/**",
      "tests/orb-stream-demo.test.js",
      "tests/feature-lab-*.test.js",
      // Workspace File Map corpus fixtures are intentionally-shaped ES-module /
      // Python / CSS / HTML source samples fed to the scanner, not project code.
      "tests/fixtures/file-map-scan/**",
      "comet/**",
      "docs/**",
    ],
  },
  {
    ...js.configs.recommended,
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-console": "off",
      "no-unused-vars": "off",
    },
  },
  {
    files: ["*.js", "services/**/*.js", "scripts/**/*.js", "tests/**/*.js", "build/**/*.js"],
    ignores: browserShellFiles,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: browserShellFiles,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.node,
        pretextLayout: "readonly",
        rendererPretextUtils: "readonly",
      },
    },
    rules: {
      "no-redeclare": "off",
    },
  },
  {
    files: rendererContextCompositionFiles,
    rules: {
      "no-undef": "off",
      "no-useless-assignment": "off",
      "no-with": "off",
    },
  },
];
