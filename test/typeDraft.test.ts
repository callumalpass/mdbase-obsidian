import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultTypeModel } from "../src/typeModel";
import {
  describeTypeChanges,
  sourceRevision,
  typeModelsEqual,
  validateTypeDraft,
} from "../src/typeDraft";

test("type draft revisions are stable and distinguish source changes", () => {
  assert.equal(sourceRevision("hello"), sourceRevision("hello"));
  assert.notEqual(sourceRevision("hello"), sourceRevision("hello\n"));
});

test("type draft validation reports actionable field and identity errors", () => {
  const model = createDefaultTypeModel();
  model.name = "task";
  model.displayNameKey = "missing";
  model.fields.push({ name: "", definition: { type: "list" } });
  model.fields.push({ name: "status", definition: { type: "enum", values: [] } });
  const diagnostics = validateTypeDraft(model, { knownTypes: ["task"] });
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "display_field_missing"));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "field_name_required"));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "list_items_missing"));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "enum_without_values"));
});

test("type draft changes identify high-impact schema edits", () => {
  const original = createDefaultTypeModel();
  original.name = "task";
  const current = structuredClone(original);
  current.name = "work-item";
  current.fields[0].definition.type = "integer";
  current.matchPathGlob = "Tasks/**/*.md";
  const changes = describeTypeChanges(original, current);
  assert.ok(changes.some((change) => change.code === "rename_type" && change.risk === "high"));
  assert.ok(changes.some((change) => change.code === "membership" && change.risk === "high"));
  assert.ok(changes.some((change) => change.code === "change_field_type" && change.risk === "high"));
  assert.equal(typeModelsEqual(original, current), false);
  assert.equal(typeModelsEqual(original, structuredClone(original)), true);
});
