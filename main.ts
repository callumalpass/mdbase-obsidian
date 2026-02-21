import {
  App,
  ItemView,
  Modal,
  Notice,
  parseYaml,
  Plugin,
  PluginSettingTab,
  Setting,
  SuggestModal,
  TFile,
  WorkspaceLeaf,
  normalizePath,
  stringifyYaml,
} from "obsidian";
import {
  MdbaseConfig,
  MdbaseFieldDef,
  MdbaseIssue,
  MdbaseTypeDef,
  buildInitialFrontmatter,
  buildUniqueNotePath,
  coerceFieldInput,
  createNoteFromType,
  ensureCollectionInitialized,
  formatMarkdown,
  getPromptFields,
  loadMdbaseConfig,
  loadTypeDefinitions,
  parseFrontmatter,
  validateCollection,
  validateFile,
} from "./src/mdbaseCore";
import { TypeEditorField, TypeEditorModal, TypeEditorModel } from "./src/typeEditorModal";

const MDBASE_ISSUES_VIEW = "mdbase-issues-view";

interface MdbasePluginSettings {
  validateOnSave: boolean;
  validateOnOpen: boolean;
  showNoticeOnSave: boolean;
}

const DEFAULT_SETTINGS: MdbasePluginSettings = {
  validateOnSave: true,
  validateOnOpen: true,
  showNoticeOnSave: false,
};

function createDefaultTypeModel(): TypeEditorModel {
  return {
    name: "",
    description: "",
    extendsType: "",
    displayNameKey: "",
    strictMode: false,
    pathPattern: "",
    filenamePattern: "",
    matchPathGlob: "",
    matchFieldsPresent: "",
    matchWhere: "",
    fields: [
      {
        name: "title",
        definition: {
          type: "string",
          required: true,
        },
      },
    ],
    body: "# Type\n\nDescribe the type and intended usage.",
    extraFrontmatter: {},
  };
}

function toTypeEditorFields(fieldsValue: unknown): TypeEditorField[] {
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

function toTypeEditorModel(
  frontmatter: Record<string, unknown>,
  body: string,
  fallbackName: string,
): TypeEditorModel {
  const fields = toTypeEditorFields(frontmatter.fields);
  const strictRaw = frontmatter.strict;
  const strictMode = strictRaw === "warn" ? "warn" : strictRaw === true;

  const match = frontmatter.match && typeof frontmatter.match === "object" && !Array.isArray(frontmatter.match)
    ? (frontmatter.match as Record<string, unknown>)
    : {};

  const knownTopLevel = new Set([
    "name",
    "description",
    "extends",
    "display_name_key",
    "strict",
    "path_pattern",
    "filename_pattern",
    "match",
    "fields",
  ]);

  const extraFrontmatter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (knownTopLevel.has(key)) continue;
    extraFrontmatter[key] = value;
  }

  let matchWhere = "";
  if (match.where !== undefined) {
    try {
      matchWhere = stringifyYaml(match.where).trim();
    } catch {
      matchWhere = "";
    }
  }

  return {
    name: typeof frontmatter.name === "string" && frontmatter.name.trim().length > 0 ? frontmatter.name : fallbackName,
    description: typeof frontmatter.description === "string" ? frontmatter.description : "",
    extendsType: typeof frontmatter.extends === "string" ? frontmatter.extends : "",
    displayNameKey: typeof frontmatter.display_name_key === "string" ? frontmatter.display_name_key : "",
    strictMode,
    pathPattern: typeof frontmatter.path_pattern === "string" ? frontmatter.path_pattern : "",
    filenamePattern: typeof frontmatter.filename_pattern === "string" ? frontmatter.filename_pattern : "",
    matchPathGlob: typeof match.path_glob === "string" ? match.path_glob : "",
    matchFieldsPresent: Array.isArray(match.fields_present)
      ? match.fields_present.map((entry) => String(entry)).join(", ")
      : "",
    matchWhere,
    fields: fields.length > 0 ? fields : createDefaultTypeModel().fields,
    body: body.trim() || `# ${fallbackName}\n\nType definition for ${fallbackName}.`,
    extraFrontmatter,
  };
}

function buildTypeFrontmatterFromModel(model: TypeEditorModel): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {
    name: model.name,
  };

  if (model.description) frontmatter.description = model.description;
  if (model.extendsType) frontmatter.extends = model.extendsType;
  if (model.displayNameKey) frontmatter.display_name_key = model.displayNameKey;
  frontmatter.strict = model.strictMode;
  if (model.pathPattern) frontmatter.path_pattern = model.pathPattern;
  if (model.filenamePattern) frontmatter.filename_pattern = model.filenamePattern;

  const match: Record<string, unknown> = {};
  if (model.matchPathGlob) match.path_glob = model.matchPathGlob;

  const fieldsPresent = model.matchFieldsPresent
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (fieldsPresent.length > 0) match.fields_present = fieldsPresent;

  if (model.matchWhere.trim()) {
    match.where = parseYaml(model.matchWhere.trim());
  }

  if (Object.keys(match).length > 0) {
    frontmatter.match = match;
  }

  const fields: Record<string, MdbaseFieldDef> = {};
  for (const field of model.fields) {
    fields[field.name] = field.definition as MdbaseFieldDef;
  }
  frontmatter.fields = fields;

  for (const [key, value] of Object.entries(model.extraFrontmatter)) {
    if (!(key in frontmatter)) frontmatter[key] = value;
  }

  return frontmatter;
}

class TextPromptModal extends Modal {
  private resolvePromise: ((value: string | null) => void) | null = null;
  private settled = false;
  private readonly title: string;
  private readonly placeholder: string;
  private readonly defaultValue: string;

  constructor(app: App, title: string, placeholder = "", defaultValue = "") {
    super(app);
    this.title = title;
    this.placeholder = placeholder;
    this.defaultValue = defaultValue;
  }

  openAndGetValue(): Promise<string | null> {
    return new Promise((resolve) => {
      this.settled = false;
      this.resolvePromise = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.title });

    const input = contentEl.createEl("input", { type: "text" });
    input.placeholder = this.placeholder;
    input.value = this.defaultValue;
    input.addClass("prompt-input");

    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    const submitButton = actions.createEl("button", { text: "OK" });
    submitButton.addClass("mod-cta");

    cancelButton.onclick = () => {
      this.finish(null);
      this.close();
    };

    submitButton.onclick = () => {
      this.finish(input.value.trim());
      this.close();
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.finish(input.value.trim());
        this.close();
      }

      if (event.key === "Escape") {
        event.preventDefault();
        this.finish(null);
        this.close();
      }
    });

    window.setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    if (!this.settled) this.finish(null);
    this.contentEl.empty();
  }

  private finish(value: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.resolvePromise?.(value);
    this.resolvePromise = null;
  }
}

type TypePickerResult =
  | { type: "selected"; typeDef: MdbaseTypeDef }
  | { type: "cancelled" };

class TypeSuggestModal extends SuggestModal<MdbaseTypeDef> {
  private readonly typeDefs: MdbaseTypeDef[];
  private readonly onResult: (result: TypePickerResult) => void;
  private resultHandled = false;

  constructor(app: App, typeDefs: MdbaseTypeDef[], onResult: (result: TypePickerResult) => void) {
    super(app);
    this.typeDefs = [...typeDefs].sort((a, b) => a.name.localeCompare(b.name));
    this.onResult = onResult;
    this.setPlaceholder("Type to search...");
    this.setInstructions([
      { command: "↑↓", purpose: "navigate" },
      { command: "↵", purpose: "select" },
      { command: "esc", purpose: "cancel" },
    ]);
    this.containerEl.addClass("mdbase-type-picker-modal");
    this.titleEl.setText("Select type definition");
  }

  getSuggestions(query: string): MdbaseTypeDef[] {
    const lowered = query.trim().toLowerCase();
    if (!lowered) return this.typeDefs.slice(0, 100);

    return this.typeDefs
      .filter((typeDef) => {
        const desc = typeDef.match?.path_glob ?? "";
        const haystack = `${typeDef.name} ${typeDef.display_name_key ?? ""} ${typeDef.filePath} ${desc}`.toLowerCase();
        return haystack.includes(lowered);
      })
      .slice(0, 100);
  }

  renderSuggestion(typeDef: MdbaseTypeDef, el: HTMLElement): void {
    const wrap = el.createDiv({ cls: "mdbase-type-picker-suggestion" });

    wrap.createDiv({
      cls: "mdbase-type-picker-name",
      text: typeDef.name,
    });

    const meta = wrap.createDiv({ cls: "mdbase-type-picker-meta" });
    meta.createSpan({
      cls: "mdbase-type-picker-path",
      text: typeDef.filePath,
    });
    meta.createSpan({
      cls: "mdbase-type-picker-count",
      text: `${Object.keys(typeDef.fields ?? {}).length} fields`,
    });

    if (typeDef.match?.path_glob) {
      wrap.createDiv({
        cls: "mdbase-type-picker-match",
        text: `match: ${typeDef.match.path_glob}`,
      });
    }
  }

  onChooseSuggestion(typeDef: MdbaseTypeDef): void {
    this.resultHandled = true;
    this.onResult({ type: "selected", typeDef });
  }

  onClose(): void {
    // Obsidian SuggestModal can close before selection callback; defer cancellation check.
    window.setTimeout(() => {
      if (!this.resultHandled) {
        this.onResult({ type: "cancelled" });
      }
    }, 0);
    super.onClose();
  }
}

function pickType(app: App, typeDefs: MdbaseTypeDef[]): Promise<MdbaseTypeDef | null> {
  return new Promise((resolve) => {
    const modal = new TypeSuggestModal(app, typeDefs, (result) => {
      if (result.type === "selected") {
        resolve(result.typeDef);
        return;
      }
      resolve(null);
    });
    modal.open();
  });
}

class MdbaseIssuesView extends ItemView {
  plugin: MdbasePlugin;

  constructor(leaf: WorkspaceLeaf, plugin: MdbasePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return MDBASE_ISSUES_VIEW;
  }

  getDisplayText(): string {
    return "mdbase issues";
  }

  getIcon(): string {
    return "shield-alert";
  }

  async onOpen(): Promise<void> {
    this.containerEl.empty();
    this.containerEl.addClass("mdbase-issues-view");
    this.render();
  }

  render(): void {
    const container = this.containerEl;
    container.empty();
    container.addClass("mdbase-issues-view");

    const header = container.createDiv({ cls: "mdbase-issues-header" });
    header.createEl("h3", { text: "mdbase Issues" });

    const refreshButton = header.createEl("button", { text: "Refresh" });
    refreshButton.addClass("mod-cta");
    refreshButton.onclick = () => {
      void this.plugin.runCollectionValidation(false);
    };

    const issues = this.plugin.getIssues();
    container.createDiv({
      cls: "mdbase-issues-count",
      text: `${issues.length} issue${issues.length === 1 ? "" : "s"}`,
    });

    if (issues.length === 0) {
      container.createDiv({
        cls: "mdbase-empty",
        text: "No validation issues.",
      });
      return;
    }

    const grouped = new Map<string, MdbaseIssue[]>();
    for (const issue of issues) {
      const current = grouped.get(issue.path) ?? [];
      current.push(issue);
      grouped.set(issue.path, current);
    }

    for (const [path, fileIssues] of grouped.entries()) {
      container.createDiv({ cls: "mdbase-issue-file", text: path });

      for (const issue of fileIssues) {
        const item = container.createDiv({ cls: "mdbase-issue-item" });
        item.setAttr("data-severity", issue.severity);

        item.createDiv({
          cls: "mdbase-issue-code",
          text: `${issue.severity.toUpperCase()} · ${issue.code}${issue.field ? ` · ${issue.field}` : ""}`,
        });
        item.createDiv({
          cls: "mdbase-issue-message",
          text: issue.message,
        });

        item.onclick = () => {
          void this.plugin.openFileByPath(path);
        };
      }
    }
  }
}

class MdbaseSettingTab extends PluginSettingTab {
  plugin: MdbasePlugin;

  constructor(app: App, plugin: MdbasePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "mdbase settings" });

    new Setting(containerEl)
      .setName("Validate on save")
      .setDesc("Run mdbase validation when a markdown file is modified.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.validateOnSave).onChange(async (value) => {
          this.plugin.settings.validateOnSave = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Validate on file open")
      .setDesc("Validate the active note when opened.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.validateOnOpen).onChange(async (value) => {
          this.plugin.settings.validateOnOpen = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Show notices on save")
      .setDesc("Display a notice when save-time validation finds issues.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showNoticeOnSave).onChange(async (value) => {
          this.plugin.settings.showNoticeOnSave = value;
          await this.plugin.saveSettings();
        }),
      );
  }
}

export default class MdbasePlugin extends Plugin {
  settings: MdbasePluginSettings;
  private issueMap = new Map<string, MdbaseIssue[]>();
  private statusBarEl: HTMLElement;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar();

    this.registerView(MDBASE_ISSUES_VIEW, (leaf) => new MdbaseIssuesView(leaf, this));
    this.addSettingTab(new MdbaseSettingTab(this.app, this));

    this.addCommand({
      id: "mdbase-initialize-collection",
      name: "mdbase: Initialize collection",
      callback: () => void this.initializeCollectionCommand(),
    });

    this.addCommand({
      id: "mdbase-create-type",
      name: "mdbase: Create type definition",
      callback: () => void this.createTypeCommand(),
    });

    this.addCommand({
      id: "mdbase-edit-type",
      name: "mdbase: Edit type definition",
      callback: () => void this.editTypeCommand(),
    });

    this.addCommand({
      id: "mdbase-edit-current-type",
      name: "mdbase: Edit current type definition",
      callback: () => void this.editCurrentTypeCommand(),
    });

    this.addCommand({
      id: "mdbase-create-note-from-type",
      name: "mdbase: Create note from type",
      callback: () => void this.createNoteFromTypeCommand(),
    });

    this.addCommand({
      id: "mdbase-validate-current-note",
      name: "mdbase: Validate current note",
      callback: () => void this.validateCurrentNoteCommand(),
    });

    this.addCommand({
      id: "mdbase-validate-collection",
      name: "mdbase: Validate collection",
      callback: () => void this.runCollectionValidation(true),
    });

    this.addCommand({
      id: "mdbase-open-issues-view",
      name: "mdbase: Open issues view",
      callback: () => void this.openIssuesView(),
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!this.settings.validateOnSave) return;
        if (!(file instanceof TFile) || file.extension !== "md") return;
        void this.validateFileAndStore(file, "save");
      }),
    );

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!this.settings.validateOnOpen) return;
        if (!(file instanceof TFile) || file.extension !== "md") return;
        void this.validateFileAndStore(file, "open");
      }),
    );

    const active = this.app.workspace.getActiveFile();
    if (active && this.settings.validateOnOpen) {
      void this.validateFileAndStore(active, "open");
    }
  }

  async onunload(): Promise<void> {
    this.app.workspace.getLeavesOfType(MDBASE_ISSUES_VIEW).forEach((leaf) => leaf.detach());
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getIssues(): MdbaseIssue[] {
    return Array.from(this.issueMap.values())
      .flat()
      .sort((a, b) => a.path.localeCompare(b.path) || a.severity.localeCompare(b.severity));
  }

  async openFileByPath(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`File not found: ${path}`);
      return;
    }

    await this.app.workspace.getLeaf(true).openFile(file);
  }

  private updateStatusBar(): void {
    const issues = this.getIssues();
    const errors = issues.filter((issue) => issue.severity === "error").length;
    const warnings = issues.length - errors;

    if (issues.length === 0) {
      this.statusBarEl.setText("mdbase: no issues");
      return;
    }

    this.statusBarEl.setText(`mdbase: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`);
  }

  private async openIssuesView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(MDBASE_ISSUES_VIEW)[0];
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      (existing.view as MdbaseIssuesView).render();
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
    await leaf.setViewState({
      type: MDBASE_ISSUES_VIEW,
      active: true,
    });

    this.app.workspace.revealLeaf(leaf);
  }

  private refreshIssueViews(): void {
    this.updateStatusBar();
    for (const leaf of this.app.workspace.getLeavesOfType(MDBASE_ISSUES_VIEW)) {
      (leaf.view as MdbaseIssuesView).render();
    }
  }

  private setFileIssues(path: string, issues: MdbaseIssue[]): void {
    if (issues.length === 0) {
      this.issueMap.delete(path);
    } else {
      this.issueMap.set(path, issues);
    }
    this.refreshIssueViews();
  }

  private async requireConfigAndTypes(): Promise<{ config: MdbaseConfig; types: Map<string, MdbaseTypeDef> } | null> {
    const config = await loadMdbaseConfig(this.app.vault);
    if (!config) {
      new Notice("No mdbase.yaml found. Run 'mdbase: Initialize collection' first.");
      return null;
    }

    const types = await loadTypeDefinitions(this.app.vault, config);
    if (types.size === 0) {
      new Notice(`No types found in ${config.settings.types_folder}`);
    }

    return { config, types };
  }

  private async validateFileAndStore(file: TFile, reason: "save" | "open" | "manual"): Promise<MdbaseIssue[]> {
    const loaded = await this.requireConfigAndTypes();
    if (!loaded) return [];

    const issues = await validateFile(this.app.vault, file, loaded.config, loaded.types);
    this.setFileIssues(file.path, issues);

    if (reason === "save" && this.settings.showNoticeOnSave && issues.length > 0) {
      new Notice(`mdbase: ${issues.length} issue${issues.length === 1 ? "" : "s"} in ${file.basename}`);
    }

    return issues;
  }

  private async initializeCollectionCommand(): Promise<void> {
    const { created } = await ensureCollectionInitialized(this.app.vault);
    if (created.length === 0) {
      new Notice("mdbase collection already initialized.");
      return;
    }

    new Notice(`Initialized mdbase collection: ${created.join(", ")}`);
  }

  private async createTypeCommand(): Promise<void> {
    const config = await loadMdbaseConfig(this.app.vault);
    if (!config) {
      new Notice("No mdbase.yaml found. Run 'mdbase: Initialize collection' first.");
      return;
    }

    const model = await new TypeEditorModal(this.app, createDefaultTypeModel(), "Create type definition").openAndGetValue();
    if (!model) return;

    try {
      const saved = await this.writeTypeDefinition(config, model, null);
      new Notice(`Created type: ${saved.path}`);
      await this.openFileByPath(saved.path);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private async editTypeCommand(): Promise<void> {
    try {
      const loaded = await this.requireConfigAndTypes();
      if (!loaded) return;

      const activeFile = this.app.workspace.getActiveFile();
      const typesFolderPrefix = `${normalizePath(loaded.config.settings.types_folder)}/`;
      if (activeFile instanceof TFile && activeFile.path.startsWith(typesFolderPrefix)) {
        await this.editTypeFile(loaded.config, activeFile, activeFile.basename);
        return;
      }

      if (loaded.types.size === 0) {
        new Notice("No type definitions found.");
        return;
      }

      const chosenType = await pickType(this.app, Array.from(loaded.types.values()));
      if (!chosenType) return;

      const abstractFile = this.app.vault.getAbstractFileByPath(chosenType.filePath);
      if (!(abstractFile instanceof TFile)) {
        new Notice(`Type file missing: ${chosenType.filePath}`);
        return;
      }

      await this.editTypeFile(loaded.config, abstractFile, chosenType.name);
    } catch (error) {
      new Notice(`Failed to open type editor: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async editCurrentTypeCommand(): Promise<void> {
    try {
      const config = await loadMdbaseConfig(this.app.vault);
      if (!config) {
        new Notice("No mdbase.yaml found. Run 'mdbase: Initialize collection' first.");
        return;
      }

      const activeFile = this.app.workspace.getActiveFile();
      if (!(activeFile instanceof TFile) || activeFile.extension !== "md") {
        new Notice("Open a type definition markdown file first.");
        return;
      }

      const typesFolderPrefix = `${normalizePath(config.settings.types_folder)}/`;
      if (!activeFile.path.startsWith(typesFolderPrefix)) {
        new Notice(`Current file is not in '${config.settings.types_folder}/'.`);
        return;
      }

      await this.editTypeFile(config, activeFile, activeFile.basename);
    } catch (error) {
      new Notice(`Failed to open current type editor: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async createNoteFromTypeCommand(): Promise<void> {
    const loaded = await this.requireConfigAndTypes();
    if (!loaded) return;

    if (loaded.types.size === 0) {
      new Notice("No type definitions found.");
      return;
    }

    const chosenType = await pickType(this.app, Array.from(loaded.types.values()));
    if (!chosenType) return;

    const frontmatter = buildInitialFrontmatter(chosenType, loaded.config);
    const promptFields = getPromptFields(chosenType, frontmatter);

    for (const [fieldName, fieldDef] of promptFields) {
      const prompt = `Required field: ${fieldName}`;
      const value = await new TextPromptModal(this.app, prompt, fieldDef.type ?? "string").openAndGetValue();
      if (value == null) return;
      if (value.trim().length === 0) {
        new Notice(`Field '${fieldName}' is required.`);
        return;
      }

      try {
        frontmatter[fieldName] = coerceFieldInput(value, fieldDef);
      } catch (error) {
        new Notice(`Invalid value for ${fieldName}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }

    const displayKey = chosenType.display_name_key ?? "title";
    if (frontmatter[displayKey] == null) {
      const displayValue = await new TextPromptModal(
        this.app,
        `Optional ${displayKey} (used for filename)`,
        "",
      ).openAndGetValue();
      if (displayValue && displayValue.trim().length > 0) {
        frontmatter[displayKey] = displayValue.trim();
      }
    }

    const suggestedPath = await buildUniqueNotePath(this.app.vault, chosenType, frontmatter);
    const chosenPathInput = await new TextPromptModal(
      this.app,
      "Note path",
      "Relative path in vault",
      suggestedPath,
    ).openAndGetValue();

    if (chosenPathInput == null) return;

    let finalPath = normalizePath(chosenPathInput.trim().length > 0 ? chosenPathInput.trim() : suggestedPath);
    if (!finalPath.endsWith(".md")) {
      finalPath = `${finalPath}.md`;
    }

    try {
      const file = await createNoteFromType(this.app.vault, finalPath, frontmatter);
      await this.app.workspace.getLeaf(true).openFile(file);
      new Notice(`Created note: ${file.path}`);
      await this.validateFileAndStore(file, "manual");
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private async validateCurrentNoteCommand(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!(activeFile instanceof TFile) || activeFile.extension !== "md") {
      new Notice("Open a markdown note first.");
      return;
    }

    const issues = await this.validateFileAndStore(activeFile, "manual");
    if (issues.length === 0) {
      new Notice("No issues in current note.");
    } else {
      new Notice(`Found ${issues.length} issue${issues.length === 1 ? "" : "s"} in current note.`);
      await this.openIssuesView();
    }
  }

  async runCollectionValidation(showSummary: boolean): Promise<void> {
    const loaded = await this.requireConfigAndTypes();
    if (!loaded) return;

    const issues = await validateCollection(this.app.vault, loaded.config, loaded.types);

    const nextMap = new Map<string, MdbaseIssue[]>();
    for (const issue of issues) {
      const list = nextMap.get(issue.path) ?? [];
      list.push(issue);
      nextMap.set(issue.path, list);
    }

    this.issueMap = nextMap;
    this.refreshIssueViews();

    if (showSummary) {
      if (issues.length === 0) {
        new Notice("Collection validation passed with no issues.");
      } else {
        const errors = issues.filter((issue) => issue.severity === "error").length;
        const warnings = issues.length - errors;
        new Notice(`Collection validation: ${errors} error(s), ${warnings} warning(s)`);
        await this.openIssuesView();
      }
    }
  }

  private async editTypeFile(config: MdbaseConfig, file: TFile, fallbackName: string): Promise<void> {
    const raw = await this.app.vault.cachedRead(file);
    const parsed = parseFrontmatter(raw);
    if (parsed.error) {
      new Notice(`Invalid type frontmatter: ${parsed.error}`);
      return;
    }

    const initialModel = toTypeEditorModel(parsed.frontmatter, parsed.body, fallbackName || file.basename);
    const edited = await new TypeEditorModal(this.app, initialModel, `Edit type: ${initialModel.name}`).openAndGetValue();
    if (!edited) return;

    try {
      const saved = await this.writeTypeDefinition(config, edited, file);
      if (saved.path === file.path) {
        new Notice(`Updated type: ${saved.path}`);
      } else {
        new Notice(`Updated type and renamed file: ${saved.path}`);
      }
      await this.openFileByPath(saved.path);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private async ensureFolderExists(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath).replace(/\/+$/, "");
    if (!normalized) return;

    const parts = normalized.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private async writeTypeDefinition(
    config: MdbaseConfig,
    model: TypeEditorModel,
    existingFile: TFile | null,
  ): Promise<TFile> {
    const typeName = model.name.trim();
    if (!typeName) {
      throw new Error("Type name is required.");
    }

    const frontmatter = buildTypeFrontmatterFromModel(model);
    const body = model.body.trim() || `# ${typeName}\n\nType definition for ${typeName}.`;
    const content = `${formatMarkdown(frontmatter, body)}\n`;

    const typesFolder = normalizePath(config.settings.types_folder);
    const defaultTargetPath = normalizePath(`${typesFolder}/${typeName}.md`);

    if (!existingFile) {
      await this.ensureFolderExists(typesFolder);

      if (await this.app.vault.adapter.exists(defaultTargetPath)) {
        throw new Error(`Type already exists: ${defaultTargetPath}`);
      }

      return await this.app.vault.create(defaultTargetPath, content);
    }

    const slashIndex = existingFile.path.lastIndexOf("/");
    const parentFolder = slashIndex >= 0 ? existingFile.path.slice(0, slashIndex) : "";
    const renamedPath = normalizePath(`${parentFolder ? `${parentFolder}/` : ""}${typeName}.md`);
    const targetPath = renamedPath || defaultTargetPath;

    if (targetPath !== existingFile.path && (await this.app.vault.adapter.exists(targetPath))) {
      throw new Error(`Cannot rename type file to ${targetPath}; file already exists.`);
    }

    if (targetPath !== existingFile.path) {
      await this.app.fileManager.renameFile(existingFile, targetPath);
    }

    const updatedFile = this.app.vault.getAbstractFileByPath(targetPath);
    if (!(updatedFile instanceof TFile)) {
      throw new Error(`Unable to access updated type file: ${targetPath}`);
    }

    await this.app.vault.modify(updatedFile, content);
    return updatedFile;
  }
}
