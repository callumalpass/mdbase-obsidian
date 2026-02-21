import { App, Modal, Notice, Setting, parseYaml, stringifyYaml } from "obsidian";

export type StrictMode = boolean | "warn";

export interface TypeEditorField {
  name: string;
  definition: Record<string, unknown>;
}

export interface TypeEditorModel {
  name: string;
  description: string;
  extendsType: string;
  displayNameKey: string;
  strictMode: StrictMode;
  pathPattern: string;
  filenamePattern: string;
  matchPathGlob: string;
  matchFieldsPresent: string;
  matchWhere: string;
  fields: TypeEditorField[];
  body: string;
  extraFrontmatter: Record<string, unknown>;
}

const FIELD_TYPES = [
  "string",
  "integer",
  "number",
  "boolean",
  "date",
  "datetime",
  "time",
  "enum",
  "list",
  "object",
  "link",
  "tags",
  "any",
];

function stringifyInlineYaml(value: unknown): string {
  try {
    return stringifyYaml(value).trim();
  } catch {
    return "";
  }
}

function parseOptionalYaml(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return parseYaml(trimmed);
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toBooleanValue(value: unknown): boolean {
  return value === true;
}

function parseCommaList(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function toNestedTypeEditorFields(fieldsValue: unknown): TypeEditorField[] {
  if (!fieldsValue || typeof fieldsValue !== "object" || Array.isArray(fieldsValue)) return [];

  const output: TypeEditorField[] = [];
  for (const [name, definition] of Object.entries(fieldsValue as Record<string, unknown>)) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) continue;
    output.push({
      name,
      definition: { ...(definition as Record<string, unknown>) },
    });
  }
  return output;
}

function toFieldRecord(fields: TypeEditorField[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const name = field.name.trim();
    if (!name) continue;
    output[name] = { ...field.definition };
  }
  return output;
}

function pickUnknownFieldOptions(definition: Record<string, unknown>): Record<string, unknown> {
  const known = new Set([
    "type",
    "required",
    "default",
    "description",
    "unique",
    "deprecated",
    "computed",
    "values",
    "items",
    "fields",
    "target",
    "validate_exists",
    "min",
    "max",
    "min_length",
    "max_length",
    "pattern",
    "generated",
  ]);

  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(definition)) {
    if (!known.has(key)) {
      unknown[key] = value;
    }
  }

  return unknown;
}

class ObjectFieldsModal extends Modal {
  private resolvePromise: ((value: TypeEditorField[] | null) => void) | null = null;
  private settled = false;
  private fields: TypeEditorField[];
  private readonly title: string;

  constructor(app: App, initialFields: TypeEditorField[], title: string) {
    super(app);
    this.fields = initialFields.map((field) => ({
      name: field.name,
      definition: { ...field.definition },
    }));
    this.title = title;
  }

  openAndGetValue(): Promise<TypeEditorField[] | null> {
    return new Promise((resolve) => {
      this.settled = false;
      this.resolvePromise = resolve;
      this.open();
    });
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mdbase-type-editor-modal");

    contentEl.createEl("h3", { text: this.title });
    contentEl.createEl("div", {
      cls: "mdbase-empty",
      text: "Define nested fields for this object schema.",
    });

    const fieldsListEl = contentEl.createDiv({ cls: "mdbase-type-fields" });
    if (this.fields.length === 0) {
      fieldsListEl.createDiv({ cls: "mdbase-empty", text: "No nested fields yet." });
    } else {
      this.fields.forEach((field, index) => {
        const row = fieldsListEl.createDiv({ cls: "mdbase-type-field-row" });
        const type = typeof field.definition.type === "string" ? field.definition.type : "any";
        const required = field.definition.required === true ? "required" : "optional";

        row.createDiv({
          cls: "mdbase-type-field-label",
          text: `${field.name} · ${type} · ${required}`,
        });

        const controls = row.createDiv({ cls: "mdbase-type-field-controls" });

        const editButton = controls.createEl("button", { text: "Edit" });
        editButton.onclick = async () => {
          const existingNames = new Set(this.fields.map((entry) => entry.name));
          const updated = await new FieldEditorModal(this.app, field, existingNames).openAndGetValue();
          if (!updated) return;
          this.fields[index] = updated;
          this.render();
        };

        const upButton = controls.createEl("button", { text: "Up" });
        upButton.disabled = index === 0;
        upButton.onclick = () => {
          if (index <= 0) return;
          const [entry] = this.fields.splice(index, 1);
          this.fields.splice(index - 1, 0, entry);
          this.render();
        };

        const downButton = controls.createEl("button", { text: "Down" });
        downButton.disabled = index === this.fields.length - 1;
        downButton.onclick = () => {
          if (index >= this.fields.length - 1) return;
          const [entry] = this.fields.splice(index, 1);
          this.fields.splice(index + 1, 0, entry);
          this.render();
        };

        const deleteButton = controls.createEl("button", { text: "Delete" });
        deleteButton.onclick = () => {
          this.fields.splice(index, 1);
          this.render();
        };
      });
    }

    const addFieldSetting = new Setting(contentEl)
      .setName("Add nested field")
      .setDesc("Create a nested field for this object schema.")
      .addButton((button) => {
        button.setButtonText("Add").setCta().onClick(async () => {
          const existingNames = new Set(this.fields.map((entry) => entry.name));
          const created = await new FieldEditorModal(this.app, null, existingNames).openAndGetValue();
          if (!created) return;
          this.fields.push(created);
          this.render();
        });
      });
    addFieldSetting.settingEl.addClass("mdbase-type-add-field");

    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    const saveButton = actions.createEl("button", { text: "Save schema" });
    saveButton.addClass("mod-cta");

    cancelButton.onclick = () => {
      this.finish(null);
      this.close();
    };

    saveButton.onclick = () => {
      const duplicates = new Set<string>();
      const seen = new Set<string>();
      for (const field of this.fields) {
        const trimmed = field.name.trim();
        if (!trimmed) {
          new Notice("Nested field names cannot be empty.");
          return;
        }
        if (seen.has(trimmed)) duplicates.add(trimmed);
        seen.add(trimmed);
      }

      if (duplicates.size > 0) {
        new Notice(`Duplicate nested field names: ${Array.from(duplicates).join(", ")}`);
        return;
      }

      this.finish(
        this.fields.map((field) => ({
          name: field.name.trim(),
          definition: { ...field.definition },
        })),
      );
      this.close();
    };
  }

  onClose(): void {
    if (!this.settled) this.finish(null);
    this.contentEl.empty();
  }

  private finish(value: TypeEditorField[] | null): void {
    if (this.settled) return;
    this.settled = true;
    this.resolvePromise?.(value);
    this.resolvePromise = null;
  }
}

class FieldEditorModal extends Modal {
  private resolvePromise: ((value: TypeEditorField | null) => void) | null = null;
  private settled = false;
  private readonly existingFieldNames: Set<string>;
  private readonly initialField: TypeEditorField | null;

  constructor(app: App, initialField: TypeEditorField | null, existingFieldNames: Set<string>) {
    super(app);
    this.initialField = initialField;
    this.existingFieldNames = existingFieldNames;
  }

  openAndGetValue(): Promise<TypeEditorField | null> {
    return new Promise((resolve) => {
      this.settled = false;
      this.resolvePromise = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mdbase-type-editor-modal");

    const headerText = this.initialField ? `Edit field: ${this.initialField.name}` : "Add field";
    contentEl.createEl("h3", { text: headerText });

    const initialDef = this.initialField?.definition ?? { type: "string" };

    let fieldName = this.initialField?.name ?? "";
    let fieldType = toStringValue(initialDef.type) || "string";
    let required = toBooleanValue(initialDef.required);
    let unique = toBooleanValue(initialDef.unique);
    let deprecated = toBooleanValue(initialDef.deprecated);
    let description = toStringValue(initialDef.description);
    let computed = toStringValue(initialDef.computed);
    let defaultYaml = initialDef.default !== undefined ? stringifyInlineYaml(initialDef.default) : "";
    let generatedYaml = initialDef.generated !== undefined ? stringifyInlineYaml(initialDef.generated) : "";

    let enumValues = Array.isArray(initialDef.values)
      ? initialDef.values.map((entry) => String(entry)).join(", ")
      : "";

    let minValue = initialDef.min !== undefined ? String(initialDef.min) : "";
    let maxValue = initialDef.max !== undefined ? String(initialDef.max) : "";
    let minLength = initialDef.min_length !== undefined ? String(initialDef.min_length) : "";
    let maxLength = initialDef.max_length !== undefined ? String(initialDef.max_length) : "";
    let pattern = toStringValue(initialDef.pattern);

    let targetType = toStringValue(initialDef.target);
    let validateExists = toBooleanValue(initialDef.validate_exists);

    const initialItems = typeof initialDef.items === "object" && initialDef.items && !Array.isArray(initialDef.items)
      ? (initialDef.items as Record<string, unknown>)
      : null;

    let listItemType = toStringValue(initialItems?.type) || "string";
    let listItemOptions = initialItems
      ? stringifyInlineYaml(
          Object.fromEntries(Object.entries(initialItems).filter(([key]) => key !== "type" && key !== "fields")),
        )
      : "";
    let listItemObjectFields = toNestedTypeEditorFields(initialItems?.fields);
    let objectFields = toNestedTypeEditorFields(initialDef.fields);

    let advancedYaml = stringifyInlineYaml(pickUnknownFieldOptions(initialDef));
    let updateListItemObjectSchemaButtonState: (() => void) | null = null;
    let updateObjectSchemaButtonState: (() => void) | null = null;

    new Setting(contentEl)
      .setName("Field name")
      .setDesc("Frontmatter key written to notes. Use a stable key name to avoid later migrations.")
      .addText((text) => {
        text.setPlaceholder("title").setValue(fieldName).onChange((value) => {
          fieldName = value;
        });
      });

    new Setting(contentEl)
      .setName("Field type")
      .setDesc("Value type used for validation and coercion.")
      .addDropdown((dropdown) => {
        for (const type of FIELD_TYPES) {
          dropdown.addOption(type, type);
        }
        dropdown.setValue(fieldType).onChange((value) => {
          fieldType = value;
          updateObjectSchemaButtonState?.();
        });
      });

    new Setting(contentEl)
      .setName("Required")
      .setDesc("If enabled, notes must include a non-empty value for this field.")
      .addToggle((toggle) => {
        toggle.setValue(required).onChange((value) => {
          required = value;
        });
      });

    new Setting(contentEl)
      .setName("Unique")
      .setDesc("If enabled, values should be unique across notes of this type.")
      .addToggle((toggle) => {
        toggle.setValue(unique).onChange((value) => {
          unique = value;
        });
      });

    new Setting(contentEl)
      .setName("Deprecated")
      .setDesc("Marks the field as legacy. Keep for compatibility, but avoid in new notes.")
      .addToggle((toggle) => {
        toggle.setValue(deprecated).onChange((value) => {
          deprecated = value;
        });
      });

    new Setting(contentEl)
      .setName("Description")
      .setDesc("Human-readable documentation for this field.")
      .addTextArea((text) => {
        text.setValue(description).onChange((value) => {
          description = value;
        });
      });

    new Setting(contentEl)
      .setName("Computed expression")
      .setDesc("Advanced: expression evaluated at read time instead of stored input.")
      .addText((text) => {
        text.setValue(computed).onChange((value) => {
          computed = value;
        });
      });

    new Setting(contentEl)
      .setName("Default (YAML)")
      .setDesc("Applied when the field is missing. Use valid YAML, e.g. draft, [], or {}.")
      .addTextArea((text) => {
        text.setPlaceholder("e.g. [] or draft").setValue(defaultYaml).onChange((value) => {
          defaultYaml = value;
        });
      });

    new Setting(contentEl)
      .setName("Generated (YAML)")
      .setDesc("Auto-generation strategy. Examples: now, now_on_write, ulid, uuid, or { random: 8 }.")
      .addTextArea((text) => {
        text.setValue(generatedYaml).onChange((value) => {
          generatedYaml = value;
        });
      });

    contentEl.createEl("h4", { text: "Type-specific options" });

    new Setting(contentEl)
      .setName("Enum values")
      .setDesc("Allowed values for enum fields, comma-separated.")
      .addText((text) => {
        text.setValue(enumValues).onChange((value) => {
          enumValues = value;
        });
      });

    new Setting(contentEl)
      .setName("Min / Max")
      .setDesc("Inclusive numeric bounds for integer/number fields.")
      .addText((text) => {
        text.setPlaceholder("min").setValue(minValue).onChange((value) => {
          minValue = value;
        });
      })
      .addText((text) => {
        text.setPlaceholder("max").setValue(maxValue).onChange((value) => {
          maxValue = value;
        });
      });

    new Setting(contentEl)
      .setName("Min length / Max length")
      .setDesc("Character-count limits for string fields.")
      .addText((text) => {
        text.setPlaceholder("min_length").setValue(minLength).onChange((value) => {
          minLength = value;
        });
      })
      .addText((text) => {
        text.setPlaceholder("max_length").setValue(maxLength).onChange((value) => {
          maxLength = value;
        });
      });

    new Setting(contentEl)
      .setName("Pattern")
      .setDesc("ECMAScript regex string that values must match.")
      .addText((text) => {
        text.setValue(pattern).onChange((value) => {
          pattern = value;
        });
      });

    new Setting(contentEl)
      .setName("Link target")
      .setDesc("Target type for link fields. Toggle enables validate_exists checks.")
      .addText((text) => {
        text.setValue(targetType).onChange((value) => {
          targetType = value;
        });
      })
      .addToggle((toggle) => {
        toggle.setTooltip("validate_exists").setValue(validateExists).onChange((value) => {
          validateExists = value;
        });
      });

    new Setting(contentEl)
      .setName("List item type")
      .setDesc("Type applied to each item in a list field.")
      .addDropdown((dropdown) => {
        for (const type of FIELD_TYPES) {
          dropdown.addOption(type, type);
        }
        dropdown.setValue(listItemType).onChange((value) => {
          listItemType = value;
          updateListItemObjectSchemaButtonState?.();
        });
      });

    new Setting(contentEl)
      .setName("List item options (YAML)")
      .setDesc("Additional item-level options merged into items (for example target or validate_exists).")
      .addTextArea((text) => {
        text.setValue(listItemOptions).onChange((value) => {
          listItemOptions = value;
        });
      });

    new Setting(contentEl)
      .setName("List item object schema")
      .setDesc("When list item type is object, edit nested fields with a form.")
      .addButton((button) => {
        updateListItemObjectSchemaButtonState = (): void => {
          button.setButtonText(`Edit schema (${listItemObjectFields.length})`);
          button.setDisabled(listItemType !== "object");
        };

        updateListItemObjectSchemaButtonState();

        button.onClick(async () => {
          if (listItemType !== "object") {
            new Notice("Set list item type to 'object' first.");
            return;
          }

          const updated = await new ObjectFieldsModal(
            this.app,
            listItemObjectFields,
            "Edit list item object schema",
          ).openAndGetValue();

          if (!updated) return;
          listItemObjectFields = updated;
          updateListItemObjectSchemaButtonState?.();
        });
      });

    new Setting(contentEl)
      .setName("Object fields")
      .setDesc("For object fields, edit nested keys and their field definitions.")
      .addButton((button) => {
        updateObjectSchemaButtonState = (): void => {
          button.setButtonText(`Edit schema (${objectFields.length})`);
          button.setDisabled(fieldType !== "object");
        };

        updateObjectSchemaButtonState();

        button.onClick(async () => {
          if (fieldType !== "object") {
            new Notice("Set field type to 'object' first.");
            return;
          }

          const updated = await new ObjectFieldsModal(
            this.app,
            objectFields,
            "Edit object field schema",
          ).openAndGetValue();
          if (!updated) return;
          objectFields = updated;
          updateObjectSchemaButtonState?.();
        });
      });

    new Setting(contentEl)
      .setName("Advanced options (YAML)")
      .setDesc("Extra keys preserved verbatim, e.g. tn_role or tn_completed_values.")
      .addTextArea((text) => {
        text.setValue(advancedYaml).onChange((value) => {
          advancedYaml = value;
        });
      });

    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    const saveButton = actions.createEl("button", { text: "Save field" });
    saveButton.addClass("mod-cta");

    cancelButton.onclick = () => {
      this.finish(null);
      this.close();
    };

    saveButton.onclick = () => {
      const finalName = fieldName.trim();
      if (!finalName) {
        new Notice("Field name is required.");
        return;
      }

      if (this.initialField?.name !== finalName && this.existingFieldNames.has(finalName)) {
        new Notice(`Field '${finalName}' already exists.`);
        return;
      }

      try {
        const definition: Record<string, unknown> = { type: fieldType };

        if (required) definition.required = true;
        if (unique) definition.unique = true;
        if (deprecated) definition.deprecated = true;
        if (description.trim()) definition.description = description.trim();
        if (computed.trim()) definition.computed = computed.trim();

        const parsedDefault = parseOptionalYaml(defaultYaml);
        if (parsedDefault !== undefined) definition.default = parsedDefault;

        const parsedGenerated = parseOptionalYaml(generatedYaml);
        if (parsedGenerated !== undefined) definition.generated = parsedGenerated;

        const parsedEnumValues = parseCommaList(enumValues);
        if (fieldType === "enum" && parsedEnumValues.length > 0) {
          definition.values = parsedEnumValues;
        }

        if (minValue.trim()) {
          const numeric = Number(minValue.trim());
          if (Number.isNaN(numeric)) {
            new Notice("Invalid min value.");
            return;
          }
          definition.min = numeric;
        }

        if (maxValue.trim()) {
          const numeric = Number(maxValue.trim());
          if (Number.isNaN(numeric)) {
            new Notice("Invalid max value.");
            return;
          }
          definition.max = numeric;
        }

        if (minLength.trim()) {
          const numeric = Number.parseInt(minLength.trim(), 10);
          if (!Number.isInteger(numeric)) {
            new Notice("Invalid min_length value.");
            return;
          }
          definition.min_length = numeric;
        }

        if (maxLength.trim()) {
          const numeric = Number.parseInt(maxLength.trim(), 10);
          if (!Number.isInteger(numeric)) {
            new Notice("Invalid max_length value.");
            return;
          }
          definition.max_length = numeric;
        }

        if (pattern.trim()) definition.pattern = pattern.trim();

        if (targetType.trim()) definition.target = targetType.trim();
        if (validateExists) definition.validate_exists = true;

        if (fieldType === "list") {
          const itemDef: Record<string, unknown> = { type: listItemType || "string" };
          const parsedItemOptions = parseOptionalYaml(listItemOptions);
          if (parsedItemOptions !== undefined) {
            if (!parsedItemOptions || typeof parsedItemOptions !== "object" || Array.isArray(parsedItemOptions)) {
              new Notice("List item options must be a YAML object.");
              return;
            }
            Object.assign(itemDef, parsedItemOptions as Record<string, unknown>);
          }

          if (listItemType === "object" && listItemObjectFields.length > 0) {
            itemDef.fields = toFieldRecord(listItemObjectFields);
          }

          definition.items = itemDef;
        }

        if (fieldType === "object") {
          if (objectFields.length > 0) {
            definition.fields = toFieldRecord(objectFields);
          }
        }

        const parsedAdvanced = parseOptionalYaml(advancedYaml);
        if (parsedAdvanced !== undefined) {
          if (!parsedAdvanced || typeof parsedAdvanced !== "object" || Array.isArray(parsedAdvanced)) {
            new Notice("Advanced options must be a YAML object.");
            return;
          }
          Object.assign(definition, parsedAdvanced as Record<string, unknown>);
        }

        this.finish({
          name: finalName,
          definition,
        });

        this.close();
      } catch (error) {
        new Notice(`Failed to parse YAML: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
  }

  onClose(): void {
    if (!this.settled) this.finish(null);
    this.contentEl.empty();
  }

  private finish(value: TypeEditorField | null): void {
    if (this.settled) return;
    this.settled = true;
    this.resolvePromise?.(value);
    this.resolvePromise = null;
  }
}

export class TypeEditorModal extends Modal {
  private resolvePromise: ((value: TypeEditorModel | null) => void) | null = null;
  private settled = false;
  private model: TypeEditorModel;
  private readonly title: string;

  constructor(app: App, initialModel: TypeEditorModel, title: string) {
    super(app);
    this.model = {
      ...initialModel,
      fields: [...initialModel.fields],
      extraFrontmatter: { ...initialModel.extraFrontmatter },
    };
    this.title = title;
  }

  openAndGetValue(): Promise<TypeEditorModel | null> {
    return new Promise((resolve) => {
      this.settled = false;
      this.resolvePromise = resolve;
      this.open();
    });
  }

  onOpen(): void {
    try {
      this.render();
    } catch (error) {
      new Notice(`Failed to render type editor: ${error instanceof Error ? error.message : String(error)}`);
      this.finish(null);
      this.close();
    }
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mdbase-type-editor-modal");

    contentEl.createEl("h2", { text: this.title });

    new Setting(contentEl)
      .setName("Type name")
      .setDesc("Stable type ID used in frontmatter (type/type(s)) and as the default type filename.")
      .addText((text) => {
        text.setPlaceholder("task").setValue(this.model.name).onChange((value) => {
          this.model.name = value;
        });
      });

    new Setting(contentEl)
      .setName("Description")
      .setDesc("Human-readable summary of what this type represents.")
      .addTextArea((text) => {
        text.setValue(this.model.description).onChange((value) => {
          this.model.description = value;
        });
      });

    new Setting(contentEl)
      .setName("Extends")
      .setDesc("Optional parent type to inherit common fields and behavior.")
      .addText((text) => {
        text.setValue(this.model.extendsType).onChange((value) => {
          this.model.extendsType = value;
        });
      });

    new Setting(contentEl)
      .setName("Display key")
      .setDesc("display_name_key used for friendly labels and filename generation.")
      .addText((text) => {
        text.setValue(this.model.displayNameKey).onChange((value) => {
          this.model.displayNameKey = value;
        });
      });

    new Setting(contentEl)
      .setName("Strict mode")
      .setDesc("Unknown-field behavior. false allows extras; true/warn report unexpected fields.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("false", "false")
          .addOption("true", "true")
          .addOption("warn", "warn")
          .setValue(this.model.strictMode === "warn" ? "warn" : this.model.strictMode ? "true" : "false")
          .onChange((value) => {
            if (value === "warn") this.model.strictMode = "warn";
            else this.model.strictMode = value === "true";
          });
      });

    new Setting(contentEl)
      .setName("Path pattern")
      .setDesc("path_pattern for generated note paths. Supports placeholders like {status} or {date}.")
      .addText((text) => {
        text.setValue(this.model.pathPattern).onChange((value) => {
          this.model.pathPattern = value;
        });
      });

    new Setting(contentEl)
      .setName("Filename pattern")
      .setDesc("filename_pattern for generated filenames, e.g. {date}-{title}.md.")
      .addText((text) => {
        text.setValue(this.model.filenamePattern).onChange((value) => {
          this.model.filenamePattern = value;
        });
      });

    contentEl.createEl("h3", { text: "Match rules" });

    new Setting(contentEl)
      .setName("path_glob")
      .setDesc("Auto-match notes by path using glob syntax, e.g. tasks/**/*.md.")
      .addText((text) => {
        text.setValue(this.model.matchPathGlob).onChange((value) => {
          this.model.matchPathGlob = value;
        });
      });

    new Setting(contentEl)
      .setName("fields_present")
      .setDesc("Auto-match only when these frontmatter keys exist (comma-separated).")
      .addText((text) => {
        text.setValue(this.model.matchFieldsPresent).onChange((value) => {
          this.model.matchFieldsPresent = value;
        });
      });

    new Setting(contentEl)
      .setName("where (YAML)")
      .setDesc("Advanced match predicate in YAML, e.g. tags: { contains: task }.")
      .addTextArea((text) => {
        text.setValue(this.model.matchWhere).onChange((value) => {
          this.model.matchWhere = value;
        });
      });

    contentEl.createEl("h3", { text: "Fields" });

    const fieldsListEl = contentEl.createDiv({ cls: "mdbase-type-fields" });

    if (this.model.fields.length === 0) {
      fieldsListEl.createDiv({ cls: "mdbase-empty", text: "No fields yet." });
    } else {
      this.model.fields.forEach((field, index) => {
        const row = fieldsListEl.createDiv({ cls: "mdbase-type-field-row" });

        const type = typeof field.definition.type === "string" ? field.definition.type : "any";
        const required = field.definition.required === true ? "required" : "optional";
        row.createDiv({
          cls: "mdbase-type-field-label",
          text: `${field.name} · ${type} · ${required}`,
        });

        const controls = row.createDiv({ cls: "mdbase-type-field-controls" });

        const editButton = controls.createEl("button", { text: "Edit" });
        editButton.onclick = async () => {
          const existingNames = new Set(this.model.fields.map((entry) => entry.name));
          const updated = await new FieldEditorModal(this.app, field, existingNames).openAndGetValue();
          if (!updated) return;
          this.model.fields[index] = updated;
          this.render();
        };

        const upButton = controls.createEl("button", { text: "Up" });
        upButton.disabled = index === 0;
        upButton.onclick = () => {
          if (index <= 0) return;
          const [entry] = this.model.fields.splice(index, 1);
          this.model.fields.splice(index - 1, 0, entry);
          this.render();
        };

        const downButton = controls.createEl("button", { text: "Down" });
        downButton.disabled = index === this.model.fields.length - 1;
        downButton.onclick = () => {
          if (index >= this.model.fields.length - 1) return;
          const [entry] = this.model.fields.splice(index, 1);
          this.model.fields.splice(index + 1, 0, entry);
          this.render();
        };

        const deleteButton = controls.createEl("button", { text: "Delete" });
        deleteButton.onclick = () => {
          this.model.fields.splice(index, 1);
          this.render();
        };
      });
    }

    const addFieldSetting = new Setting(contentEl)
      .setName("Add field")
      .setDesc("Create a new field definition, then reorder fields with Up/Down.")
      .addButton((button) => {
        button.setButtonText("Add").setCta().onClick(async () => {
          const existingNames = new Set(this.model.fields.map((entry) => entry.name));
          const created = await new FieldEditorModal(this.app, null, existingNames).openAndGetValue();
          if (!created) return;
          this.model.fields.push(created);
          this.render();
        });
      });

    addFieldSetting.settingEl.addClass("mdbase-type-add-field");

    new Setting(contentEl)
      .setName("Type note body")
      .setDesc("Markdown documentation saved below frontmatter in the type file.")
      .addTextArea((text) => {
        text.setValue(this.model.body).onChange((value) => {
          this.model.body = value;
        });
      });

    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    const saveButton = actions.createEl("button", { text: "Save type" });
    saveButton.addClass("mod-cta");

    cancelButton.onclick = () => {
      this.finish(null);
      this.close();
    };

    saveButton.onclick = () => {
      const trimmedName = this.model.name.trim();
      if (!trimmedName) {
        new Notice("Type name is required.");
        return;
      }

      if (!/^[a-zA-Z0-9_-]+$/.test(trimmedName)) {
        new Notice("Type name should only contain letters, numbers, '_' or '-'.");
        return;
      }

      if (this.model.fields.length === 0) {
        new Notice("Define at least one field.");
        return;
      }

      const duplicates = new Set<string>();
      const seen = new Set<string>();
      for (const field of this.model.fields) {
        if (seen.has(field.name)) duplicates.add(field.name);
        seen.add(field.name);
      }

      if (duplicates.size > 0) {
        new Notice(`Duplicate field names: ${Array.from(duplicates).join(", ")}`);
        return;
      }

      const matchWhere = this.model.matchWhere.trim();
      if (matchWhere) {
        try {
          parseYaml(matchWhere);
        } catch (error) {
          new Notice(`Invalid match.where YAML: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
      }

      this.model.name = trimmedName;
      this.model.description = this.model.description.trim();
      this.model.extendsType = this.model.extendsType.trim();
      this.model.displayNameKey = this.model.displayNameKey.trim();
      this.model.pathPattern = this.model.pathPattern.trim();
      this.model.filenamePattern = this.model.filenamePattern.trim();
      this.model.matchPathGlob = this.model.matchPathGlob.trim();
      this.model.matchFieldsPresent = this.model.matchFieldsPresent.trim();
      this.model.body = this.model.body.trim();

      this.finish(this.model);
      this.close();
    };
  }

  onClose(): void {
    if (!this.settled) this.finish(null);
    this.contentEl.empty();
  }

  private finish(value: TypeEditorModel | null): void {
    if (this.settled) return;
    this.settled = true;
    this.resolvePromise?.(value);
    this.resolvePromise = null;
  }
}
