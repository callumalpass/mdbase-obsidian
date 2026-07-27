import {
  ItemView,
  Notice,
  Platform,
  setIcon,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import type { MirrorInitializationPreview, MirrorProgress, MirrorStatus } from "@mdbase/connect-sync/mirror";
import type {
  ConnectSyncController,
  MirrorProfile,
} from "./connectSync";
import type {
  MdbaseConfig,
  MdbaseIssue,
  MdbaseTypeDef,
} from "./mdbaseCore";
import { formatMarkdown, parseFrontmatter } from "./mdbaseCore";
import type { V02MigrationPlan } from "./migration";
import { MDBASE_ICON_ID } from "./mdbaseIcon";
import type { TypeEditorField, TypeEditorModel } from "./typeEditorTypes";
import {
  createDefaultTypeModel,
  frontmatterFromTypeModel,
  typeModelFromDocument,
} from "./typeModel";

export const MDBASE_WORKSPACE_VIEW = "mdbase-workspace-view";

export interface MdbaseWorkspaceSchema {
  config: MdbaseConfig;
  types: Map<string, MdbaseTypeDef>;
}

export interface MdbaseWorkspaceHost {
  readonly connectSync: ConnectSyncController;
  getMirrorProfile(): MirrorProfile | null;
  loadWorkspaceSchema(forceReload?: boolean): Promise<MdbaseWorkspaceSchema | null>;
  loadTypeModel(path: string): Promise<TypeEditorModel>;
  saveTypeModel(model: TypeEditorModel, existingPath: string | null): Promise<TFile>;
  initializeCollection(): Promise<void>;
  getIssues(): MdbaseIssue[];
  validateCollection(): Promise<void>;
  openFileByPath(path: string, field?: string): Promise<void>;
  analyzeMigration(): Promise<V02MigrationPlan>;
  applyMigration(plan: V02MigrationPlan, allowLossy: boolean): Promise<void>;
}

type Destination = "types" | "sync" | "issues";
type EditorMode = "design" | "yaml";

const FIELD_TYPES = [
  "string",
  "integer",
  "number",
  "boolean",
  "date",
  "datetime",
  "time",
  "enum",
  "link",
  "list",
  "object",
  "any",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function definitionType(definition: Record<string, unknown>): string {
  return typeof definition.type === "string" ? definition.type : "any";
}

function nextNestedFieldName(fields: Record<string, unknown>): string {
  if (!Object.prototype.hasOwnProperty.call(fields, "field")) return "field";
  let suffix = 2;
  while (Object.prototype.hasOwnProperty.call(fields, `field${suffix}`)) suffix += 1;
  return `field${suffix}`;
}

function setOwnField(
  fields: Record<string, unknown>,
  name: string,
  definition: Record<string, unknown>,
): void {
  Object.defineProperty(fields, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: definition,
  });
}

function changeSummary(original: TypeEditorModel | null, current: TypeEditorModel): string[] {
  if (!original) return ["A new type definition will be created."];
  const changes: string[] = [];
  if (original.name !== current.name) changes.push(`Rename type from ${original.name} to ${current.name}.`);
  if (original.matchPathGlob !== current.matchPathGlob
    || original.matchFieldsPresent !== current.matchFieldsPresent
    || original.matchWhere !== current.matchWhere) {
    changes.push("Membership rules changed; different records may match this type.");
  }
  const before = new Map(original.fields.map((field) => [field.name, field]));
  const after = new Map(current.fields.map((field) => [field.name, field]));
  const removed = [...before.keys()].filter((name) => !after.has(name));
  const added = [...after.keys()].filter((name) => !before.has(name));
  if (added.length) changes.push(`Add ${added.length} field${added.length === 1 ? "" : "s"}: ${added.join(", ")}.`);
  if (removed.length) changes.push(`Remove ${removed.length} field${removed.length === 1 ? "" : "s"}: ${removed.join(", ")}.`);
  const newlyRequired = [...after.entries()]
    .filter(([name, field]) => field.definition.required === true && before.get(name)?.definition.required !== true)
    .map(([name]) => name);
  if (newlyRequired.length) changes.push(`New required fields may invalidate records: ${newlyRequired.join(", ")}.`);
  if (!changes.length) changes.push("Metadata, schema details, or documentation changed.");
  return changes;
}

function inputRow(
  container: HTMLElement,
  label: string,
  value: string,
  onInput: (value: string) => void,
  options: { description?: string; placeholder?: string; multiline?: boolean } = {},
): HTMLInputElement | HTMLTextAreaElement {
  const row = container.createDiv({ cls: "mdbase-form-row" });
  const labelEl = row.createEl("label", { text: label });
  const id = `mdbase-${Math.random().toString(36).slice(2)}`;
  labelEl.htmlFor = id;
  if (options.description) row.createDiv({ cls: "mdbase-form-description", text: options.description });
  const control = options.multiline
    ? row.createEl("textarea")
    : row.createEl("input", { type: "text" });
  control.id = id;
  control.value = value;
  control.placeholder = options.placeholder ?? "";
  control.addEventListener("input", () => onInput(control.value));
  return control;
}

function renderStatus(container: HTMLElement, label: string, value: string): void {
  const row = container.createDiv({ cls: "mdbase-status-row" });
  row.createSpan({ cls: "mdbase-status-label", text: label });
  row.createSpan({ cls: "mdbase-status-value", text: value });
}

function compactCount(value: number): string {
  if (value < 1_000) return String(value);
  const digits = value < 10_000 ? 1 : 0;
  return `${(value / 1_000).toFixed(digits)}k`;
}

export class MdbaseWorkspaceView extends ItemView {
  private destination: Destination = "types";
  private editorMode: EditorMode = "design";
  private schema: MdbaseWorkspaceSchema | null = null;
  private query = "";
  private selectedPath: string | null = null;
  private model: TypeEditorModel | null = null;
  private originalModel: TypeEditorModel | null = null;
  private yamlDraft = "";
  private dirty = false;
  private busy = false;
  private migrationPlan: V02MigrationPlan | null = null;
  private allowLossy = false;
  private mirrorStatus: MirrorStatus | null = null;
  private mirrorPreview: MirrorInitializationPreview | null = null;
  private mirrorProgress: MirrorProgress | null = null;
  private transientMessage = "";
  private issueQuery = "";
  private issueSeverity: "all" | "error" | "warn" = "all";
  private issueLimit = 250;
  private enrollmentVerification = "";
  private enrollmentAbort: AbortController | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly host: MdbaseWorkspaceHost) {
    super(leaf);
  }

  getViewType(): string {
    return MDBASE_WORKSPACE_VIEW;
  }

  getDisplayText(): string {
    return "mdbase";
  }

  getIcon(): string {
    return MDBASE_ICON_ID;
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("mdbase-workspace");
    await this.refresh(true);
  }

  async onClose(): Promise<void> {
    this.enrollmentAbort?.abort();
    this.enrollmentAbort = null;
  }

  async refresh(forceReload = false): Promise<void> {
    try {
      this.schema = await this.host.loadWorkspaceSchema(forceReload);
      if (this.selectedPath && !this.typeEntries().some((entry) => entry.filePath === this.selectedPath)) {
        this.selectedPath = null;
        this.model = null;
        this.originalModel = null;
      }
      if (!this.selectedPath && this.typeEntries().length && !Platform.isMobile) {
        this.selectedPath = this.typeEntries()[0].filePath;
      }
      if (this.selectedPath && (!this.model || forceReload)) {
        await this.selectType(this.selectedPath, false);
      }
      if (this.destination === "sync") await this.refreshMirrorStatus();
      this.render();
    } catch (error) {
      this.transientMessage = error instanceof Error ? error.message : String(error);
      this.render();
    }
  }

  showDestination(destination: Destination): void {
    this.destination = destination;
    if (destination === "sync") void this.refreshMirrorStatus().then(() => this.render());
    else this.render();
  }

  private typeEntries(): MdbaseTypeDef[] {
    return this.schema
      ? [...this.schema.types.values()].sort((a, b) => a.name.localeCompare(b.name))
      : [];
  }

  private render(): void {
    const root = this.containerEl;
    root.empty();
    root.addClass("mdbase-workspace");
    const shell = root.createDiv({ cls: "mdbase-shell" });
    this.renderTopbar(shell);
    if (this.transientMessage) {
      const message = shell.createDiv({ cls: "mdbase-inline-message", text: this.transientMessage });
      message.setAttr("role", "status");
    }
    const content = shell.createDiv({ cls: "mdbase-workspace-content" });
    if (this.destination === "types") this.renderTypes(content);
    else if (this.destination === "sync") this.renderSync(content);
    else this.renderIssues(content);
  }

  private renderTopbar(container: HTMLElement): void {
    const topbar = container.createDiv({ cls: "mdbase-topbar" });
    const identity = topbar.createDiv({ cls: "mdbase-identity" });
    const mark = identity.createSpan({ cls: "mdbase-mark" });
    mark.setAttr("aria-hidden", "true");
    setIcon(mark, MDBASE_ICON_ID);
    identity.createSpan({ cls: "mdbase-title", text: "mdbase" });
    const nav = topbar.createDiv({ cls: "mdbase-nav" });
    nav.setAttr("role", "tablist");
    for (const [destination, label] of [["types", "Types"], ["sync", "Sync"], ["issues", "Issues"]] as const) {
      const button = nav.createEl("button", { text: label });
      button.addClass("mdbase-nav-button");
      button.setAttr("role", "tab");
      button.setAttr("aria-selected", String(this.destination === destination));
      if (this.destination === destination) button.addClass("is-active");
      if (destination === "issues" && this.host.getIssues().length) {
        const issueCount = this.host.getIssues().length;
        const count = button.createSpan({ cls: "mdbase-count", text: compactCount(issueCount) });
        count.setAttr("title", `${issueCount} issues`);
      }
      button.onclick = () => this.showDestination(destination);
    }
  }

  private renderTypes(container: HTMLElement): void {
    if (!this.schema) {
      const empty = container.createDiv({ cls: "mdbase-empty-state" });
      empty.createEl("h2", { text: "Start an mdbase collection" });
      empty.createEl("p", {
        text: "Initialize this vault as a local v0.3 collection, or use Sync to connect an empty vault to a collection authority.",
      });
      const actions = empty.createDiv({ cls: "mdbase-actions" });
      const initialize = actions.createEl("button", { text: "Initialize local collection" });
      initialize.addClass("mod-cta");
      initialize.disabled = this.busy || this.host.getMirrorProfile() !== null;
      initialize.onclick = () => void this.perform(async () => {
        await this.host.initializeCollection();
        await this.refresh(true);
      });
      const connect = actions.createEl("button", { text: "Connect collection authority" });
      connect.onclick = () => this.showDestination("sync");
      return;
    }

    if (this.schema.config.spec_version.startsWith("0.2.")) {
      this.renderLegacyBanner(container);
    }

    const layout = container.createDiv({ cls: "mdbase-types-layout" });
    if (this.model) layout.addClass("has-selection");
    this.renderTypeList(layout);
    this.renderTypeEditor(layout);
  }

  private renderLegacyBanner(container: HTMLElement): void {
    const banner = container.createDiv({ cls: "mdbase-legacy-banner" });
    const text = banner.createDiv();
    text.createEl("strong", { text: `mdbase ${this.schema?.config.spec_version} compatibility mode` });
    text.createEl("p", {
      text: "Types are readable and validation remains available, but authoring is disabled until a reviewed v0.3 migration.",
    });
    const button = banner.createEl("button", { text: this.migrationPlan ? "Review migration" : "Analyze migration" });
    button.disabled = this.busy || this.host.getMirrorProfile() !== null;
    button.onclick = () => void this.perform(async () => {
      this.migrationPlan = await this.host.analyzeMigration();
      this.render();
    });
    if (this.host.getMirrorProfile()) {
      banner.createDiv({
        cls: "mdbase-form-description",
        text: "Hosted resources must be migrated at the collection authority.",
      });
    }
    if (this.migrationPlan) this.renderMigrationReview(container, this.migrationPlan);
  }

  private renderMigrationReview(container: HTMLElement, plan: V02MigrationPlan): void {
    const review = container.createDiv({ cls: "mdbase-migration-review" });
    const header = review.createDiv({ cls: "mdbase-section-header" });
    header.createEl("h3", { text: "Migration review" });
    header.createSpan({ cls: "mdbase-spec-badge", text: `${plan.sourceVersion} → ${plan.targetVersion}` });
    const summary = review.createDiv({ cls: "mdbase-status-list" });
    renderStatus(summary, "Files replaced", String(plan.operations.length));
    renderStatus(summary, "Type definitions", String(plan.typeSummaries.length));
    renderStatus(summary, "Record reads verified", String(plan.recordsVerified));
    if (plan.recordsSkipped) renderStatus(summary, "Records skipped", String(plan.recordsSkipped));
    renderStatus(summary, "Record files rewritten", "0");
    renderStatus(summary, "Recovery backup", plan.backupLocation);
    const warnings = review.createDiv({ cls: "mdbase-review-list" });
    if (!plan.diagnostics.length) {
      warnings.createDiv({ cls: "mdbase-review-ok", text: "No migration diagnostics." });
    }
    for (const diagnostic of plan.diagnostics.slice(0, 250)) {
      const item = warnings.createDiv({ cls: "mdbase-review-item" });
      item.setAttr("data-severity", diagnostic.severity);
      item.createDiv({ cls: "mdbase-review-code", text: `${diagnostic.severity} · ${diagnostic.path}` });
      item.createDiv({ text: diagnostic.message });
    }
    if (plan.diagnostics.length > 250) {
      warnings.createDiv({
        cls: "mdbase-form-description",
        text: `Showing 250 of ${plan.diagnostics.length} diagnostics.`,
      });
    }
    if (!plan.applicable) {
      const consent = review.createEl("label", { cls: "mdbase-consent" });
      const checkbox = consent.createEl("input", { type: "checkbox" });
      checkbox.checked = this.allowLossy;
      checkbox.onchange = () => {
        this.allowLossy = checkbox.checked;
        this.render();
      };
      consent.createSpan({ text: "I reviewed the lossy diagnostics and want to apply this migration." });
    }
    const actions = review.createDiv({ cls: "mdbase-actions" });
    const apply = actions.createEl("button", { text: "Apply migration" });
    apply.addClass("mod-warning");
    apply.disabled = this.busy || (!plan.applicable && !this.allowLossy);
    apply.onclick = () => void this.perform(async () => {
      await this.host.applyMigration(plan, this.allowLossy);
      this.migrationPlan = null;
      this.allowLossy = false;
      this.model = null;
      this.originalModel = null;
      await this.refresh(true);
    });
    const dismiss = actions.createEl("button", { text: "Close review" });
    dismiss.onclick = () => {
      this.migrationPlan = null;
      this.render();
    };
  }

  private renderTypeList(container: HTMLElement): void {
    const pane = container.createDiv({ cls: "mdbase-type-list-pane" });
    const header = pane.createDiv({ cls: "mdbase-pane-header" });
    header.createEl("h2", { text: "Types" });
    const add = header.createEl("button");
    add.setAttr("aria-label", "Create type");
    setIcon(add, "plus");
    add.disabled = (this.schema?.config.spec_version.startsWith("0.2.") ?? true)
      || this.host.getMirrorProfile()?.mode === "read_only";
    add.onclick = () => this.createType();

    const search = pane.createEl("input", { type: "search" });
    search.addClass("mdbase-type-search");
    search.placeholder = "Search types";
    search.setAttr("aria-label", "Search types");
    search.value = this.query;
    search.oninput = () => {
      this.query = search.value;
      this.render();
      const next = this.containerEl.querySelector<HTMLInputElement>(".mdbase-type-search");
      next?.focus();
      next?.setSelectionRange(next.value.length, next.value.length);
    };

    const list = pane.createDiv({ cls: "mdbase-type-list" });
    const query = this.query.trim().toLowerCase();
    const entries = this.typeEntries().filter((entry) =>
      `${entry.name} ${entry.description ?? ""} ${entry.filePath}`.toLowerCase().includes(query));
    if (!entries.length) {
      list.createDiv({ cls: "mdbase-empty-list", text: query ? "No matching types." : "No type definitions." });
      return;
    }
    for (const type of entries) {
      const button = list.createEl("button", { cls: "mdbase-type-row" });
      if (type.filePath === this.selectedPath) button.addClass("is-active");
      button.setAttr("aria-current", type.filePath === this.selectedPath ? "true" : "false");
      button.createSpan({ cls: "mdbase-type-name", text: type.name });
      button.createSpan({
        cls: "mdbase-type-meta",
        text: `${Object.keys(type.fields).length} fields · ${type.specProfile ?? "v0.2"}`,
      });
      button.onclick = () => void this.selectType(type.filePath);
    }
  }

  private renderTypeEditor(container: HTMLElement): void {
    const pane = container.createDiv({ cls: "mdbase-type-editor-pane" });
    if (!this.model) {
      const empty = pane.createDiv({ cls: "mdbase-empty-state" });
      empty.createEl("h2", { text: "Choose a type" });
      empty.createEl("p", { text: "Select a type definition from the list to inspect or edit it." });
      return;
    }
    const mirrorReadOnly = this.host.getMirrorProfile()?.mode === "read_only";
    const readOnly = this.model.specProfile === "v0.2" || mirrorReadOnly || Boolean(this.model.readOnlyReason);
    const readOnlyReason = this.model.readOnlyReason
      ?? (mirrorReadOnly
        ? "This mirror has read-only access. Re-enroll it with write access before editing types."
        : "This v0.2 type is read-only. Review and apply a collection migration before editing.");
    const header = pane.createDiv({ cls: "mdbase-editor-header" });
    const back = header.createEl("button", { cls: "mdbase-mobile-back" });
    back.setAttr("aria-label", "Back to type list");
    setIcon(back, "arrow-left");
    back.onclick = () => {
      if (this.dirty) {
        new Notice("Save or discard the current type changes before going back.");
        return;
      }
      this.selectedPath = null;
      this.model = null;
      this.originalModel = null;
      this.render();
    };
    const heading = header.createDiv();
    const titleLine = heading.createDiv({ cls: "mdbase-editor-title-line" });
    titleLine.createEl("h2", { text: this.model.name || "Untitled type" });
    titleLine.createSpan({ cls: "mdbase-spec-badge", text: this.model.specProfile ?? "v0.2" });
    if (this.dirty) titleLine.createSpan({ cls: "mdbase-dirty", text: "Unsaved" });
    heading.createDiv({ cls: "mdbase-editor-path", text: this.selectedPath ?? "New type" });

    const headerActions = header.createDiv({ cls: "mdbase-editor-actions" });
    if (this.selectedPath) {
      const source = headerActions.createEl("button", { text: "Open source" });
      source.onclick = () => void this.host.openFileByPath(this.selectedPath!);
    }
    const save = headerActions.createEl("button", { text: "Save" });
    save.addClass("mod-cta");
    save.disabled = readOnly || !this.dirty || this.busy;
    save.onclick = () => void this.saveCurrentType();

    if (readOnly) {
      pane.createDiv({
        cls: "mdbase-readonly-note",
        text: readOnlyReason,
      });
    }
    const mode = pane.createDiv({ cls: "mdbase-mode-switch" });
    mode.setAttr("role", "tablist");
    for (const [value, label] of [["design", "Design"], ["yaml", "YAML"]] as const) {
      const button = mode.createEl("button", { text: label });
      button.setAttr("role", "tab");
      button.setAttr("aria-selected", String(this.editorMode === value));
      if (this.editorMode === value) button.addClass("is-active");
      button.onclick = () => this.switchEditorMode(value);
    }

    const editor = pane.createDiv({ cls: "mdbase-editor-document" });
    if (this.editorMode === "design") this.renderDesignEditor(editor, this.model, readOnly);
    else this.renderYamlEditor(editor, readOnly);
  }

  private renderDesignEditor(container: HTMLElement, model: TypeEditorModel, readOnly: boolean): void {
    const identity = container.createEl("section", { cls: "mdbase-editor-section" });
    identity.createEl("h3", { text: "Identity" });
    const name = inputRow(identity, "Name", model.name, (value) => {
      model.name = value;
      this.markDirty();
    }, { description: "Stable type name used by collection records." });
    name.disabled = readOnly;
    const description = inputRow(identity, "Description", model.description, (value) => {
      model.description = value;
      this.markDirty();
    }, { multiline: true });
    description.disabled = readOnly;
    const display = inputRow(identity, "Display field", model.displayNameKey, (value) => {
      model.displayNameKey = value;
      this.markDirty();
    }, { placeholder: "title" });
    display.disabled = readOnly;
    const strictRow = identity.createEl("label", { cls: "mdbase-checkbox-row" });
    const strict = strictRow.createEl("input", { type: "checkbox" });
    strict.checked = model.strictMode === true;
    strict.disabled = readOnly;
    strict.onchange = () => {
      model.strictMode = strict.checked;
      this.markDirty();
    };
    strictRow.createSpan({ text: "Reject undeclared fields" });

    const membership = container.createEl("section", { cls: "mdbase-editor-section" });
    membership.createEl("h3", { text: "Membership" });
    const glob = inputRow(membership, "Path glob", model.matchPathGlob, (value) => {
      model.matchPathGlob = value;
      this.markDirty();
    }, { placeholder: "Projects/**/*.md" });
    glob.disabled = readOnly;
    const present = inputRow(membership, "Fields present", model.matchFieldsPresent, (value) => {
      model.matchFieldsPresent = value;
      this.markDirty();
    }, { description: "Comma-separated frontmatter keys." });
    present.disabled = readOnly;
    const where = inputRow(membership, "Where", model.matchWhere, (value) => {
      model.matchWhere = value;
      this.markDirty();
    }, {
      multiline: true,
      description: "YAML predicate, including contains and nested equality conditions.",
      placeholder: "tags:\n  contains: task",
    });
    where.disabled = readOnly;

    const fields = container.createEl("section", { cls: "mdbase-editor-section" });
    const fieldsHeader = fields.createDiv({ cls: "mdbase-section-header" });
    fieldsHeader.createEl("h3", { text: "Fields" });
    const addField = fieldsHeader.createEl("button", { text: "Add field" });
    addField.disabled = readOnly;
    addField.onclick = () => {
      model.fields.push({ name: "", definition: { type: "string" } });
      this.markDirty(true);
    };
    const fieldList = fields.createDiv({ cls: "mdbase-fields" });
    for (const [index, field] of model.fields.entries()) {
      this.renderFieldRow(fieldList, field, index, readOnly);
    }
    if (!model.fields.length) fieldList.createDiv({ cls: "mdbase-empty-list", text: "No fields declared." });

    const placement = container.createEl("section", { cls: "mdbase-editor-section" });
    placement.createEl("h3", { text: "Placement" });
    const path = inputRow(placement, "Path pattern", model.pathPattern, (value) => {
      model.pathPattern = value;
      this.markDirty();
    }, { placeholder: "Notes/{title}.md" });
    path.disabled = readOnly;

    const review = container.createEl("section", { cls: "mdbase-editor-section mdbase-change-review" });
    review.createEl("h3", { text: "Change review" });
    if (!this.dirty) {
      review.createEl("p", { text: "No pending changes." });
    } else {
      const list = review.createEl("ul");
      for (const change of changeSummary(this.originalModel, model)) list.createEl("li", { text: change });
    }
  }

  private renderFieldRow(container: HTMLElement, field: TypeEditorField, index: number, readOnly: boolean): void {
    this.renderFieldDefinition(container, field.definition, {
      name: field.name,
      nameLabel: `Field ${index + 1} name`,
      onNameInput: (value) => {
        field.name = value;
        this.markDirty();
      },
      required: field.definition.required === true,
      onRequiredChange: (value) => {
        field.definition.required = value;
        this.markDirty();
      },
      onRemove: () => {
        this.model?.fields.splice(index, 1);
        this.markDirty(true);
      },
      readOnly,
      depth: 0,
    });
  }

  private renderFieldDefinition(
    container: HTMLElement,
    definition: Record<string, unknown>,
    options: {
      name?: string;
      nameLabel: string;
      staticLabel?: string;
      onNameInput?: (value: string) => void;
      onNameCommit?: (value: string, input: HTMLInputElement) => void;
      required?: boolean;
      onRequiredChange?: (value: boolean) => void;
      onRemove?: () => void;
      readOnly: boolean;
      depth: number;
    },
  ): void {
    const node = container.createDiv({ cls: "mdbase-field-node" });
    node.setAttr("data-depth", String(options.depth));
    const row = node.createDiv({ cls: "mdbase-field-row" });

    if (options.staticLabel) {
      row.createDiv({ cls: "mdbase-field-role", text: options.staticLabel });
    } else {
      const name = row.createEl("input", { type: "text", cls: "mdbase-field-name-control" });
      name.setAttr("aria-label", options.nameLabel);
      name.placeholder = "fieldName";
      name.value = options.name ?? "";
      name.disabled = options.readOnly;
      if (options.onNameInput) name.oninput = () => options.onNameInput?.(name.value);
      if (options.onNameCommit) name.onchange = () => options.onNameCommit?.(name.value, name);
    }

    const type = row.createEl("select", { cls: "mdbase-field-type-control" });
    type.setAttr("aria-label", `${options.name || options.staticLabel || "Field"} type`);
    for (const value of FIELD_TYPES) {
      const label = value === "any" ? "Any value" : value[0].toUpperCase() + value.slice(1);
      type.createEl("option", { value, text: label });
    }
    type.value = definitionType(definition);
    type.disabled = options.readOnly;
    type.onchange = () => {
      definition.type = type.value;
      if (type.value === "list" && !isRecord(definition.items)) {
        definition.items = { type: "string" };
      }
      if (type.value === "object" && !isRecord(definition.fields)) {
        definition.fields = {};
      }
      if (type.value === "enum" && !Array.isArray(definition.values)) {
        definition.values = [];
      }
      this.markDirty(true);
    };

    const description = row.createEl("input", { type: "text", cls: "mdbase-field-description-control" });
    description.setAttr("aria-label", `${options.name || options.staticLabel || "Field"} description`);
    description.placeholder = "Description";
    description.value = typeof definition.description === "string" ? definition.description : "";
    description.disabled = options.readOnly;
    description.oninput = () => {
      if (description.value) definition.description = description.value;
      else delete definition.description;
      this.markDirty();
    };

    if (options.onRequiredChange) {
      const required = row.createEl("label", { cls: "mdbase-field-required" });
      const checkbox = required.createEl("input", { type: "checkbox" });
      checkbox.checked = options.required === true;
      checkbox.disabled = options.readOnly;
      checkbox.onchange = () => options.onRequiredChange?.(checkbox.checked);
      required.createSpan({ text: "Required" });
    }

    if (options.onRemove) {
      const remove = row.createEl("button", { cls: "mdbase-field-remove" });
      remove.setAttr("aria-label", `Remove ${options.name || options.staticLabel || "field"}`);
      setIcon(remove, "trash-2");
      remove.disabled = options.readOnly;
      remove.onclick = options.onRemove;
    }

    const typeName = definitionType(definition);
    if (typeName === "enum") this.renderEnumFieldDetails(node, definition, options);
    if (typeName === "link") this.renderLinkFieldDetails(node, definition, options);
    if (typeName === "list") this.renderListFieldDetails(node, definition, options);
    if (typeName === "object") this.renderObjectFieldDetails(node, definition, options);
  }

  private renderEnumFieldDetails(
    node: HTMLElement,
    definition: Record<string, unknown>,
    options: { name?: string; staticLabel?: string; readOnly: boolean },
  ): void {
    const details = node.createDiv({ cls: "mdbase-field-details mdbase-field-options" });
    const label = details.createEl("label", { text: "Allowed values" });
    const values = details.createEl("input", { type: "text" });
    values.setAttr("aria-label", `${options.name || options.staticLabel || "Enum"} allowed values`);
    values.placeholder = "draft, published, archived";
    values.value = Array.isArray(definition.values) ? definition.values.map(String).join(", ") : "";
    values.disabled = options.readOnly;
    values.oninput = () => {
      definition.values = values.value.split(",").map((value) => value.trim()).filter(Boolean);
      this.markDirty();
    };
    label.htmlFor = values.id = `mdbase-${Math.random().toString(36).slice(2)}`;
  }

  private renderLinkFieldDetails(
    node: HTMLElement,
    definition: Record<string, unknown>,
    options: { name?: string; staticLabel?: string; readOnly: boolean },
  ): void {
    const details = node.createDiv({ cls: "mdbase-field-details mdbase-field-options" });
    const targetLabel = details.createEl("label", { text: "Target type" });
    const target = details.createEl("input", { type: "text" });
    target.setAttr("aria-label", `${options.name || options.staticLabel || "Link"} target type`);
    target.placeholder = "Any type";
    target.value = typeof definition.target === "string" ? definition.target : "";
    target.disabled = options.readOnly;
    target.oninput = () => {
      if (target.value.trim()) definition.target = target.value.trim();
      else delete definition.target;
      this.markDirty();
    };
    targetLabel.htmlFor = target.id = `mdbase-${Math.random().toString(36).slice(2)}`;
    const existsLabel = details.createEl("label", { cls: "mdbase-field-required" });
    const exists = existsLabel.createEl("input", { type: "checkbox" });
    exists.checked = definition.validate_exists === true;
    exists.disabled = options.readOnly;
    exists.onchange = () => {
      definition.validate_exists = exists.checked;
      this.markDirty();
    };
    existsLabel.createSpan({ text: "Validate target exists" });
  }

  private renderListFieldDetails(
    node: HTMLElement,
    definition: Record<string, unknown>,
    options: { readOnly: boolean; depth: number },
  ): void {
    const children = node.createDiv({ cls: "mdbase-field-children" });
    children.createDiv({ cls: "mdbase-field-children-label", text: "List items" });
    const items = isRecord(definition.items) ? definition.items : { type: "any" };
    if (!isRecord(definition.items) && !options.readOnly) definition.items = items;
    this.renderFieldDefinition(children, items, {
      staticLabel: "Item",
      nameLabel: "List item",
      readOnly: options.readOnly,
      depth: options.depth + 1,
    });
  }

  private renderObjectFieldDetails(
    node: HTMLElement,
    definition: Record<string, unknown>,
    options: { readOnly: boolean; depth: number },
  ): void {
    const children = node.createDiv({ cls: "mdbase-field-children" });
    const header = children.createDiv({ cls: "mdbase-field-children-header" });
    header.createDiv({ cls: "mdbase-field-children-label", text: "Object fields" });
    const add = header.createEl("button", { text: "Add nested field" });
    add.disabled = options.readOnly;
    const fields = isRecord(definition.fields) ? definition.fields : {};
    if (!isRecord(definition.fields) && !options.readOnly) definition.fields = fields;
    add.onclick = () => {
      const name = nextNestedFieldName(fields);
      setOwnField(fields, name, { type: "string" });
      this.markDirty(true);
    };
    const list = children.createDiv({ cls: "mdbase-nested-fields" });
    const entries = Object.entries(fields).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]));
    if (!entries.length) {
      list.createDiv({ cls: "mdbase-empty-list", text: "No nested fields." });
      return;
    }
    for (const [initialName, childDefinition] of entries) {
      let currentName = initialName;
      this.renderFieldDefinition(list, childDefinition, {
        name: currentName,
        nameLabel: `${currentName} nested field name`,
        onNameCommit: (value, input) => {
          const nextName = value.trim();
          if (!nextName) {
            new Notice("Nested field name is required.");
            input.value = currentName;
            return;
          }
          if (
            nextName !== currentName
            && Object.prototype.hasOwnProperty.call(fields, nextName)
          ) {
            new Notice(`Nested field already exists: ${nextName}`);
            input.value = currentName;
            return;
          }
          if (nextName === currentName) return;
          delete fields[currentName];
          setOwnField(fields, nextName, childDefinition);
          currentName = nextName;
          this.markDirty();
        },
        required: childDefinition.required === true,
        onRequiredChange: (value) => {
          childDefinition.required = value;
          this.markDirty();
        },
        onRemove: () => {
          delete fields[currentName];
          this.markDirty(true);
        },
        readOnly: options.readOnly,
        depth: options.depth + 1,
      });
    }
  }

  private renderYamlEditor(container: HTMLElement, readOnly: boolean): void {
    const section = container.createEl("section", { cls: "mdbase-editor-section mdbase-yaml-section" });
    section.createEl("h3", { text: "Canonical type document" });
    section.createEl("p", {
      cls: "mdbase-form-description",
      text: "Unknown v0.3 extensions are preserved. Invalid YAML is never normalized or saved.",
    });
    const textarea = section.createEl("textarea", { cls: "mdbase-yaml-editor" });
    textarea.setAttr("aria-label", "Type definition YAML");
    textarea.value = this.yamlDraft;
    textarea.disabled = readOnly;
    textarea.spellcheck = false;
    textarea.oninput = () => {
      this.yamlDraft = textarea.value;
      this.markDirty(false);
    };
  }

  private renderSync(container: HTMLElement): void {
    const document = container.createDiv({ cls: "mdbase-sync-document" });
    const header = document.createDiv({ cls: "mdbase-document-header" });
    header.createEl("h2", { text: "Sync" });
    header.createEl("p", { text: "Connect this vault to a collection authority and keep ordinary Markdown mirrored locally." });
    const profile = this.host.getMirrorProfile();
    if (!profile) {
      this.renderEnrollment(document);
      return;
    }
    const status = document.createEl("section", { cls: "mdbase-editor-section" });
    status.createEl("h3", { text: "Collection authority" });
    const values = status.createDiv({ cls: "mdbase-status-list" });
    renderStatus(values, "Name", profile.name);
    renderStatus(values, "Collection", profile.collectionId);
    renderStatus(values, "Access", profile.mode === "read_write" ? "Read and write" : "Read only");
    renderStatus(values, "Provider", profile.syncUrl);
    renderStatus(values, "State", this.mirrorStatus?.state.replace(/_/g, " ") ?? "Checking");
    renderStatus(values, "Last synced", this.mirrorStatus?.last_synced_at ?? "Never");
    if (this.mirrorProgress) {
      const total = this.mirrorProgress.total;
      const progress = status.createEl("progress");
      progress.max = total ?? 1;
      progress.value = total == null ? 0 : this.mirrorProgress.completed;
      if (total == null) progress.removeAttribute("value");
      status.createDiv({
        cls: "mdbase-progress-label",
        text: `${this.mirrorProgress.phase}: ${this.mirrorProgress.completed}${total == null ? "" : ` of ${total}`}`,
      });
    }
    const actions = status.createDiv({ cls: "mdbase-actions" });
    const preview = actions.createEl("button", { text: "Preview" });
    preview.disabled = this.busy;
    preview.onclick = () => void this.perform(async () => {
      this.mirrorPreview = await this.host.connectSync.preview();
      this.render();
    });
    const sync = actions.createEl("button", { text: "Sync now" });
    sync.addClass("mod-cta");
    sync.disabled = this.busy;
    sync.onclick = () => void this.perform(async () => {
      this.mirrorStatus = await this.host.connectSync.sync((progress) => {
        this.mirrorProgress = progress;
        this.render();
      });
      this.mirrorProgress = null;
      this.transientMessage = "Sync completed and the local checkpoint was verified.";
      await this.refresh(true);
    });

    if (this.mirrorPreview) this.renderMirrorPreview(document, this.mirrorPreview);
    if (this.mirrorStatus?.conflicts.length) this.renderConflicts(document, this.mirrorStatus);
    if (this.mirrorStatus?.local_issues.length) {
      this.renderLocalMirrorIssues(document, this.mirrorStatus);
    }
    const guidance = document.createEl("section", { cls: "mdbase-editor-section" });
    guidance.createEl("h3", { text: "Mirror ownership" });
    guidance.createEl("p", {
      text: "Use this plugin as the only sync owner for this vault. Obsidian protects concurrent operations inside the app; a separate desktop mirror process cannot share that mobile-safe lease.",
    });
  }

  private renderEnrollment(container: HTMLElement): void {
    const section = container.createEl("section", { cls: "mdbase-editor-section mdbase-enrollment" });
    section.createEl("h3", { text: "Connect collection authority" });
    section.createEl("p", {
      text: "Connect will open an approval page. Credentials are stored in Obsidian's secret store and never written into this vault.",
    });
    if (this.enrollmentVerification) {
      const approval = section.createDiv({ cls: "mdbase-approval-link" });
      approval.createSpan({ text: "Approval page: " });
      const link = approval.createEl("a", {
        text: "Open Connect",
        href: this.enrollmentVerification,
      });
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener noreferrer");
    }
    let controlUrl = "https://connect.mdbase.dev";
    let mirrorName = "Obsidian";
    let collectionId = "";
    let mode: "read_only" | "read_write" = "read_write";
    inputRow(section, "Connect URL", controlUrl, (value) => {
      controlUrl = value;
    }, { placeholder: "https://connect.mdbase.dev" });
    inputRow(section, "Mirror name", mirrorName, (value) => {
      mirrorName = value;
    });
    inputRow(section, "Collection ID", collectionId, (value) => {
      collectionId = value;
    }, { description: "Optional. Leave blank to choose during approval." });
    const access = section.createDiv({ cls: "mdbase-form-row" });
    access.createEl("label", { text: "Access" });
    const select = access.createEl("select");
    select.createEl("option", { value: "read_write", text: "Read and write" });
    select.createEl("option", { value: "read_only", text: "Read only" });
    select.value = mode;
    select.onchange = () => {
      mode = select.value === "read_only" ? "read_only" : "read_write";
    };
    const button = section.createEl("button", { text: "Open Connect approval" });
    button.addClass("mod-cta");
    button.disabled = this.busy;
    button.onclick = () => void this.perform(async () => {
      this.enrollmentAbort?.abort();
      const abort = new AbortController();
      this.enrollmentAbort = abort;
      try {
        await this.host.connectSync.enroll({
          controlUrl,
          mirrorName,
          mode,
          ...(collectionId.trim() ? { collectionId: collectionId.trim() } : {}),
        }, {
          signal: abort.signal,
          onVerification: (verification) => {
            this.enrollmentVerification = verification.verificationUri;
            this.transientMessage = "Approve the mirror in the Connect page. This view will keep waiting securely.";
            window.open(verification.verificationUri, "_blank", "noopener,noreferrer");
            this.render();
          },
          onStatus: (status) => {
            this.transientMessage = status.state === "waiting_for_approval"
              ? "Waiting for approval in Connect…"
              : `Connect is retrying enrollment (attempt ${status.attempt}).`;
            this.render();
          },
        });
        this.enrollmentVerification = "";
        this.transientMessage = "Mirror enrolled. Preview before the first sync.";
        await this.refreshMirrorStatus();
        this.render();
      } finally {
        if (this.enrollmentAbort === abort) this.enrollmentAbort = null;
      }
    });
  }

  private renderMirrorPreview(container: HTMLElement, preview: MirrorInitializationPreview): void {
    const section = container.createEl("section", { cls: "mdbase-editor-section" });
    section.createEl("h3", { text: "Sync preview" });
    const values = section.createDiv({ cls: "mdbase-status-list" });
    renderStatus(values, "Download documents", String(preview.download_documents));
    renderStatus(values, "Upload documents", String(preview.upload_documents));
    renderStatus(values, "Unchanged documents", String(preview.unchanged_documents));
    if (preview.collisions.length) {
      section.createDiv({
        cls: "mdbase-inline-error",
        text: `${preview.collisions.length} path collision${preview.collisions.length === 1 ? "" : "s"} must be resolved before sync.`,
      });
      const list = section.createEl("ul");
      for (const path of preview.collisions.slice(0, 100)) list.createEl("li", { text: path });
    }
    if (preview.local_issues.length) {
      section.createDiv({
        cls: "mdbase-inline-error",
        text: `${preview.local_issues.length} local file${preview.local_issues.length === 1 ? "" : "s"} cannot be uploaded until its frontmatter is fixed.`,
      });
      const list = section.createEl("ul");
      for (const issue of preview.local_issues.slice(0, 100)) {
        list.createEl("li", { text: `${issue.path}: ${issue.message}` });
      }
    }
  }

  private renderConflicts(container: HTMLElement, status: MirrorStatus): void {
    const section = container.createEl("section", { cls: "mdbase-editor-section" });
    section.createEl("h3", { text: "Conflicts" });
    for (const conflict of status.conflicts) {
      const row = section.createDiv({ cls: "mdbase-conflict-row" });
      const text = row.createDiv();
      text.createEl("strong", { text: conflict.path ?? conflict.record_id });
      text.createDiv({ text: conflict.message });
      const actions = row.createDiv({ cls: "mdbase-actions" });
      for (const resolution of ["local", "remote"] as const) {
        const button = actions.createEl("button", {
          text: resolution === "local" ? "Keep local" : "Use remote",
        });
        button.disabled = this.busy;
        button.onclick = () => void this.perform(async () => {
          this.mirrorStatus = await this.host.connectSync.resolveConflict(conflict.record_id, resolution);
          this.render();
        });
      }
    }
  }

  private renderLocalMirrorIssues(container: HTMLElement, status: MirrorStatus): void {
    const section = container.createEl("section", { cls: "mdbase-editor-section" });
    section.createEl("h3", { text: "Local files needing attention" });
    section.createEl("p", {
      text: "These files remain untouched and unsynced. Other valid Markdown continues to synchronize.",
    });
    for (const issue of status.local_issues) {
      const row = section.createDiv({ cls: "mdbase-conflict-row" });
      const text = row.createDiv();
      text.createEl("strong", { text: issue.path });
      text.createDiv({ text: issue.message });
      const actions = row.createDiv({ cls: "mdbase-actions" });
      const open = actions.createEl("button", { text: "Open file" });
      open.disabled = this.busy;
      open.onclick = () => void this.host.openFileByPath(issue.path);
    }
  }

  private renderIssues(container: HTMLElement): void {
    const document = container.createDiv({ cls: "mdbase-issues-document" });
    const allIssues = this.host.getIssues();
    const allFiles = new Set(allIssues.map((issue) => issue.path)).size;
    const header = document.createDiv({ cls: "mdbase-document-header" });
    const heading = header.createDiv();
    heading.createEl("h2", { text: "Issues" });
    heading.createEl("p", {
      text: allIssues.length
        ? `${allIssues.length.toLocaleString()} validation issues in ${allFiles.toLocaleString()} files.`
        : "The collection has no current validation issues.",
    });
    const refresh = header.createEl("button", { text: "Validate collection" });
    refresh.disabled = this.busy;
    refresh.onclick = () => void this.perform(async () => {
      await this.host.validateCollection();
      this.render();
    });
    const controls = document.createDiv({ cls: "mdbase-issue-controls" });
    const severity = controls.createEl("select");
    severity.setAttr("aria-label", "Issue severity");
    severity.createEl("option", { value: "all", text: "All severities" });
    severity.createEl("option", { value: "error", text: "Errors" });
    severity.createEl("option", { value: "warn", text: "Warnings" });
    severity.value = this.issueSeverity;
    severity.onchange = () => {
      this.issueSeverity = severity.value === "error" || severity.value === "warn" ? severity.value : "all";
      this.issueLimit = 250;
      this.render();
    };
    const query = controls.createEl("input", { type: "search" });
    query.setAttr("aria-label", "Filter issues");
    query.placeholder = "Filter by path, code, field, or message";
    query.value = this.issueQuery;
    query.oninput = () => {
      this.issueQuery = query.value;
      this.issueLimit = 250;
      this.render();
      const next = this.containerEl.querySelector<HTMLInputElement>(".mdbase-issue-controls input[type='search']");
      next?.focus();
      next?.setSelectionRange(next.value.length, next.value.length);
    };
    const normalizedQuery = this.issueQuery.trim().toLowerCase();
    const filtered = allIssues.filter((issue) => {
      if (this.issueSeverity !== "all" && issue.severity !== this.issueSeverity) return false;
      if (!normalizedQuery) return true;
      return `${issue.path} ${issue.code} ${issue.field ?? ""} ${issue.message}`.toLowerCase().includes(normalizedQuery);
    });
    const filteredFiles = new Set(filtered.map((issue) => issue.path)).size;
    document.createDiv({
      cls: "mdbase-issues-summary",
      text: filtered.length === allIssues.length
        ? `Showing ${Math.min(filtered.length, this.issueLimit).toLocaleString()} of ${filtered.length.toLocaleString()} issues`
        : `${filtered.length.toLocaleString()} matching issues in ${filteredFiles.toLocaleString()} files`,
    });
    if (!filtered.length) {
      document.createDiv({ cls: "mdbase-empty-state", text: "No validation issues." });
      return;
    }
    const issues = filtered.slice(0, this.issueLimit);
    const groups = new Map<string, MdbaseIssue[]>();
    for (const issue of issues) groups.set(issue.path, [...(groups.get(issue.path) ?? []), issue]);
    for (const [path, fileIssues] of groups) {
      const group = document.createEl("section", { cls: "mdbase-issue-group" });
      const groupHeader = group.createDiv({ cls: "mdbase-issue-group-header" });
      const fileButton = groupHeader.createEl("button", { cls: "mdbase-issue-file-button" });
      setIcon(fileButton.createSpan({ cls: "mdbase-issue-file-icon" }), "file-text");
      fileButton.createSpan({ cls: "mdbase-issue-file-path", text: path });
      fileButton.onclick = () => void this.host.openFileByPath(path);
      groupHeader.createSpan({
        cls: "mdbase-issue-file-count",
        text: `${fileIssues.length} ${fileIssues.length === 1 ? "issue" : "issues"}`,
      });
      for (const issue of fileIssues) {
        const row = group.createEl("button", { cls: "mdbase-issue-row" });
        row.setAttr("data-severity", issue.severity);
        row.setAttr("aria-label", `${issue.severity === "warn" ? "Warning" : "Error"}: ${issue.message}`);
        row.createSpan({ cls: "mdbase-issue-indicator" }).setAttr("aria-hidden", "true");
        const metadata = row.createDiv({ cls: "mdbase-issue-metadata" });
        metadata.createEl("code", { text: issue.code });
        metadata.createDiv({
          cls: "mdbase-issue-context",
          text: `${issue.severity === "warn" ? "Warning" : "Error"}${issue.field ? ` · ${issue.field}` : ""}`,
        });
        row.createDiv({ cls: "mdbase-issue-row-message", text: issue.message });
        row.onclick = () => void this.host.openFileByPath(issue.path, issue.field);
      }
    }
    if (filtered.length > issues.length) {
      const load = document.createEl("button", {
        cls: "mdbase-load-more",
        text: `Load ${Math.min(250, filtered.length - issues.length)} more`,
      });
      load.onclick = () => {
        this.issueLimit += 250;
        this.render();
      };
    }
  }

  private async selectType(path: string, confirmDirty = true): Promise<void> {
    if (confirmDirty && this.dirty && path !== this.selectedPath) {
      new Notice("Save or discard the current type changes before switching.");
      return;
    }
    const model = await this.host.loadTypeModel(path);
    this.selectedPath = path;
    this.model = model;
    this.originalModel = clone(model);
    this.yamlDraft = `${formatMarkdown(frontmatterFromReadableModel(model), model.body)}\n`;
    this.dirty = false;
    this.editorMode = "design";
    this.render();
  }

  private createType(): void {
    if (this.dirty) {
      new Notice("Save or discard the current type changes before creating another type.");
      return;
    }
    const model = createDefaultTypeModel();
    this.selectedPath = null;
    this.model = model;
    this.originalModel = null;
    this.yamlDraft = `${formatMarkdown(frontmatterFromTypeModel(model), model.body)}\n`;
    this.dirty = true;
    this.editorMode = "design";
    this.render();
  }

  private switchEditorMode(mode: EditorMode): void {
    if (!this.model || mode === this.editorMode) return;
    if (mode === "yaml") {
      try {
        this.yamlDraft = `${formatMarkdown(frontmatterFromReadableModel(this.model), this.model.body)}\n`;
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
        return;
      }
    } else if (!this.readYamlDraftIntoModel()) {
      return;
    }
    this.editorMode = mode;
    this.render();
  }

  private readYamlDraftIntoModel(): boolean {
    const parsed = parseFrontmatter(this.yamlDraft);
    if (!parsed.hasFrontmatter || parsed.error) {
      new Notice(`Invalid type YAML: ${parsed.error ?? "frontmatter is missing"}`);
      return false;
    }
    if (parsed.frontmatter.kind !== "mdbase.type") {
      new Notice("Canonical v0.3 type YAML requires kind: mdbase.type.");
      return false;
    }
    try {
      this.model = typeModelFromDocument(parsed.frontmatter, parsed.body, this.model?.name || "type");
      return true;
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private async saveCurrentType(): Promise<void> {
    if (!this.model || this.model.specProfile !== "v0.3" || this.model.readOnlyReason) return;
    if (this.editorMode === "yaml" && !this.readYamlDraftIntoModel()) return;
    if (!this.model.name.trim()) {
      new Notice("Type name is required.");
      return;
    }
    await this.perform(async () => {
      const file = await this.host.saveTypeModel(this.model!, this.selectedPath);
      this.selectedPath = file.path;
      this.originalModel = clone(this.model!);
      this.dirty = false;
      this.transientMessage = `Saved ${file.path}.`;
      await this.refresh(true);
    });
  }

  private markDirty(render = false): void {
    this.dirty = true;
    if (render) {
      this.render();
      return;
    }
    const titleLine = this.containerEl.querySelector<HTMLElement>(".mdbase-editor-title-line");
    if (titleLine && !titleLine.querySelector(".mdbase-dirty")) {
      titleLine.createSpan({ cls: "mdbase-dirty", text: "Unsaved" });
    }
    const save = this.containerEl.querySelector<HTMLButtonElement>(".mdbase-editor-actions .mod-cta");
    if (
      save
      && this.model?.specProfile === "v0.3"
      && !this.model.readOnlyReason
      && this.host.getMirrorProfile()?.mode !== "read_only"
    ) save.disabled = false;
    const review = this.containerEl.querySelector<HTMLElement>(".mdbase-change-review");
    if (review) {
      const empty = review.querySelector("p");
      if (empty) empty.setText("Pending changes. Review details after leaving the current field.");
    }
  }

  private async refreshMirrorStatus(): Promise<void> {
    try {
      this.mirrorStatus = await this.host.connectSync.status();
    } catch (error) {
      this.mirrorStatus = null;
      this.transientMessage = error instanceof Error ? error.message : String(error);
    }
  }

  private async perform(operation: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.transientMessage = "";
    this.render();
    try {
      await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.transientMessage = message;
      new Notice(message);
    } finally {
      this.busy = false;
      this.render();
    }
  }
}

function frontmatterFromReadableModel(model: TypeEditorModel): Record<string, unknown> {
  if (model.specProfile === "v0.3" && !model.readOnlyReason) return frontmatterFromTypeModel(model);
  return clone(model.originalFrontmatter ?? {
    name: model.name,
    fields: Object.fromEntries(model.fields.map((field) => [field.name, field.definition])),
  });
}
