import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";
import prettier from "eslint-config-prettier";
import globals from "globals";

const sourceFilePatterns = ["main.ts", "src/**/*.ts"];

const sentenceCaseOptions = {
  allowAutoFix: true,
  brands: ["Connect", "Markdown", "mdbase", "Obsidian"],
  acronyms: ["ID", "URL", "YAML"],
  enforceCamelCaseLower: true,
  ignoreRegex: ["^[a-z][A-Za-z0-9_-]*$", "^[a-z0-9_-]+(?:, [a-z0-9_-]+)*$"],
};

const pluginReviewRules = {
  rules: {
    "require-eslint-directive-description": {
      meta: {
        type: "suggestion",
        docs: { description: "Require descriptions on ESLint directive comments." },
        messages: { missingDescription: "Include a description after -- on this ESLint directive." },
        schema: [],
      },
      create(context) {
        return {
          Program() {
            const sourceCode = context.sourceCode ?? context.getSourceCode();
            const directive = /\beslint-(?:disable|disable-next-line|disable-line|enable)\b/u;
            for (const comment of sourceCode.getAllComments()) {
              const value = comment.value.trim();
              if (!directive.test(value)) continue;
              const descriptionIndex = value.indexOf("--");
              if (descriptionIndex < 0 || value.slice(descriptionIndex + 2).trim().length === 0) {
                context.report({ loc: comment.loc, messageId: "missingDescription" });
              }
            }
          },
        };
      },
    },
    "no-network-interval": {
      meta: {
        type: "problem",
        docs: { description: "Disallow intervals in modules that perform network calls." },
        messages: { found: "Use a self-rescheduling timeout instead of an interval in a networking module." },
        schema: [],
      },
      create(context) {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        if (!/\b(?:requestUrl|fetch|XMLHttpRequest|sendBeacon)\b/u.test(sourceCode.text)) return {};
        return {
          CallExpression(node) {
            const callee = node.callee;
            const name = callee.type === "Identifier"
              ? callee.name
              : callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier"
                ? callee.property.name
                : null;
            if (name === "setInterval") context.report({ node: callee, messageId: "found" });
          },
        };
      },
    },
    "no-codemirror-theme-styles": {
      meta: {
        type: "problem",
        docs: { description: "Keep static CodeMirror styling in CSS." },
        messages: { found: "Move CodeMirror theme styling from TypeScript to the plugin stylesheet." },
        schema: [],
      },
      create(context) {
        return {
          CallExpression(node) {
            const callee = node.callee;
            if (
              callee.type === "MemberExpression"
              && !callee.computed
              && callee.object.type === "Identifier"
              && callee.object.name === "EditorView"
              && callee.property.type === "Identifier"
              && callee.property.name === "theme"
            ) context.report({ node: callee, messageId: "found" });
          },
        };
      },
    },
  },
};

const obsidianRecommendedConfig = obsidianmd.configs.recommended.map((config) => {
  const hasUnscopedRules = config.files === undefined
    && Object.keys(config.rules ?? {}).some((name) => name.startsWith("obsidianmd/"));
  return hasUnscopedRules ? { ...config, files: sourceFilePatterns } : config;
});

export default [
  {
    ignores: [
      "node_modules/**",
      "main.js",
      ".test-dist/**",
      "test/**",
      "scripts/**",
      "copy-files.mjs",
      "esbuild.config.mjs",
      "version-bump.mjs",
    ],
  },
  js.configs.recommended,
  ...obsidianRecommendedConfig,
  {
    files: sourceFilePatterns,
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: "./tsconfig.json", sourceType: "module" },
      globals: { ...globals.browser, ...globals.node, ...globals.es2021 },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "plugin-review": pluginReviewRules,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
      "no-prototype-builtins": "error",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/ban-ts-comment": ["warn", {
        "ts-expect-error": "allow-with-description",
        "ts-ignore": "allow-with-description",
        "ts-nocheck": "allow-with-description",
        "ts-check": false,
        minimumDescriptionLength: 10,
      }],
      "@typescript-eslint/no-explicit-any": ["warn", { fixToUnknown: true }],
      "@typescript-eslint/no-inferrable-types": "warn",
      "no-constant-condition": "warn",
      "no-case-declarations": "warn",
      // TypeScript resolves type-space globals (such as AsyncGenerator) more
      // accurately than ESLint's JavaScript-only no-undef rule.
      "no-undef": "off",
      "no-new-func": "error",
      "plugin-review/require-eslint-directive-description": "warn",
      "plugin-review/no-network-interval": "warn",
      "plugin-review/no-codemirror-theme-styles": "warn",
      "obsidianmd/no-static-styles-assignment": "warn",
      "obsidianmd/rule-custom-message": "warn",
      "obsidianmd/ui/sentence-case": ["warn", sentenceCaseOptions],
      "obsidianmd/no-forbidden-elements": "warn",
      "obsidianmd/settings-tab": "off",
      "obsidianmd/platform": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-misused-promises": "warn",
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "@typescript-eslint/no-deprecated": "warn",
      "@typescript-eslint/no-base-to-string": "warn",
      "@typescript-eslint/no-redundant-type-constituents": "warn",
      "@typescript-eslint/restrict-template-expressions": "warn",
      "@typescript-eslint/prefer-promise-reject-errors": "warn",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "import/no-nodejs-modules": "warn",
    },
  },
  {
    files: ["src/connectSync.ts"],
    rules: {
      // The sync protocol uses `document` as a domain field name; these are not
      // references to the browser global that this rule is designed to catch.
      "obsidianmd/prefer-active-doc": "off",
    },
  },
  {
    files: ["src/trailingDebouncer.ts"],
    rules: {
      // This utility is deliberately DOM-independent and also runs in the Node
      // test harness; callers do not provide an element with an active window.
      "obsidianmd/prefer-window-timers": "off",
    },
  },
  prettier,
];
