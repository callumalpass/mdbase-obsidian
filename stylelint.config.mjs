import selectorParser from "postcss-selector-parser";
import stylelint from "stylelint";

const { createPlugin, utils } = stylelint;
const noHasRuleName = "mdbase/no-has";
const browserSupportRuleName = "mdbase/obsidian-browser-support";
const scopedSelectorsRuleName = "mdbase/scoped-selectors";
const noFixedPositionRuleName = "mdbase/no-fixed-position";

const noHasRule = createPlugin(noHasRuleName, (enabled) => (root, result) => {
  if (!enabled) return;
  root.walkRules((rule) => {
    const index = (rule.selector ?? "").indexOf(":has(");
    if (index >= 0) utils.report({
      message: "Avoid :has() because broad selector invalidation can make Obsidian sluggish.",
      node: rule,
      result,
      ruleName: noHasRuleName,
      index,
      endIndex: index + 4,
    });
  });
});

const partialFeatures = [
  ["css-display-contents", (declaration) => declaration.prop.toLowerCase() === "display" && /\bcontents\b/iu.test(declaration.value)],
  ["multicolumn", (declaration) => declaration.prop === "columns" || declaration.prop.startsWith("column-") || declaration.prop === "break-inside"],
  ["text-decoration", (declaration) => ["text-decoration-line", "text-decoration-thickness"].includes(declaration.prop)],
];

const browserSupportRule = createPlugin(browserSupportRuleName, (enabled) => (root, result) => {
  if (!enabled) return;
  root.walkDecls((declaration) => {
    for (const [feature, matches] of partialFeatures) {
      if (matches(declaration)) utils.report({
        message: `Unexpected browser feature "${feature}" is only partially supported by Obsidian's supported runtimes.`,
        node: declaration,
        result,
        ruleName: browserSupportRuleName,
      });
    }
  });
});

const scopedSelectorsRule = createPlugin(scopedSelectorsRuleName, (enabled) => (root, result) => {
  if (!enabled) return;
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && rule.parent.name === "keyframes") return;
    let parsed;
    try {
      parsed = selectorParser().astSync(rule.selector);
    } catch {
      return;
    }
    parsed.each((selector) => {
      let owned = false;
      selector.walkClasses((classNode) => {
        if (classNode.value.startsWith("mdbase-")) owned = true;
      });
      selector.walkAttributes((attribute) => {
        if (attribute.attribute === "data-type" && attribute.value === "mdbase-workspace-view") owned = true;
      });
      // State and Obsidian host classes are safe once the selector contains an
      // mdbase-owned class; the owned class provides the actual scope boundary.
      if (owned) return;
      utils.report({
        message: "Scope plugin CSS with an mdbase-owned selector.",
        node: rule,
        result,
        ruleName: scopedSelectorsRuleName,
      });
    });
  });
});

const noFixedPositionRule = createPlugin(noFixedPositionRuleName, (enabled) => (root, result) => {
  if (!enabled) return;
  root.walkDecls("position", (declaration) => {
    if (declaration.value.toLowerCase() === "fixed") utils.report({
      message: "Avoid fixed positioning in plugin CSS without a narrowly reviewed exception.",
      node: declaration,
      result,
      ruleName: noFixedPositionRuleName,
    });
  });
});

const warning = { severity: "warning" };

export default {
  plugins: [noHasRule, browserSupportRule, scopedSelectorsRule, noFixedPositionRule],
  rules: {
    "color-hex-length": ["long", { ...warning, message: "Use full 6-digit hex colors." }],
    "declaration-block-no-duplicate-properties": [true, warning],
    "declaration-no-important": [true, warning],
    "no-duplicate-selectors": [true, warning],
    "property-no-unknown": [true, warning],
    "selector-pseudo-class-no-unknown": [true, warning],
    "selector-type-no-unknown": [true, warning],
    [noHasRuleName]: [true, warning],
    [browserSupportRuleName]: [true, warning],
    [scopedSelectorsRuleName]: [true, warning],
    [noFixedPositionRuleName]: [true, warning],
  },
};
