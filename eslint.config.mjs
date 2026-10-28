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

const noFollowRemoval = "Use removeTree/removeTreeSync from services/fs-remove-no-follow.js: Node's rm follows junctions after a Windows EPERM.";

export default [
  {
    ignores: [
      "archive/**",
      "dist/**",
      // Generated hosted browser bundle; lint its server/browser sources.
      "build/browser/**",
      // Owner-gate evidence (gitignored): captured profiles, venvs and sample
      // projects from real-app gate runs, not Jenny source.
      "build/gate-evidence/**",
      // Runtime diagnostics and QA evidence bundles (gitignored), which can
      // hold apps a tester built through Jenny; not Jenny source.
      ".jenny-diagnostics/**",
      "locales/**",
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
    files: ["*.js", "services/**/*.js", "server/**/*.js", "cli/**/*.js", "scripts/**/*.js", "tests/**/*.js", "build/**/*.js"],
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
    // Node's rm (recursive or not) stat()s through a Windows junction after a transient EPERM and
    // empties its target; services/fs-remove-no-follow.js is the only removal path.
    files: ["services/**/*.js", "scripts/uninstall.js"],
    rules: {
      "no-restricted-syntax": ["error",
        { selector: "CallExpression[callee.property.name=/^(rm|rmSync)$/]", message: noFollowRemoval },
        { selector: "CallExpression[callee.name=/^(rm|rmSync)$/]", message: noFollowRemoval },
        { selector: "MemberExpression[computed=true][property.value=/^(rm|rmSync)$/]", message: noFollowRemoval },
        { selector: "ObjectPattern > Property[key.name=/^(rm|rmSync)$/]", message: noFollowRemoval },
        // An options object held in a variable is not resolved; review rmdir calls that pass one.
        { selector: "CallExpression[callee.property.name=/^rmdir(Sync)?$/] Property[key.name='recursive']",
          message: noFollowRemoval },
        { selector: "CallExpression[callee.property.name=/^rmdir(Sync)?$/] Property[key.value='recursive']",
          message: noFollowRemoval },
        { selector: "CallExpression[callee.name=/^rmdir(Sync)?$/] Property[key.name='recursive']",
          message: noFollowRemoval },
        { selector: "CallExpression[callee.name=/^rmdir(Sync)?$/] Property[key.value='recursive']",
          message: noFollowRemoval },
      ],
    },
  },
  {
    // Pending migration by the row 54 NInfer owner; same pattern as services/image-engine-service.js.
    files: ["services/ninfer-runtime-install.js", "services/ninfer-artifact-download.js"],
    rules: { "no-restricted-syntax": "off" },
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
