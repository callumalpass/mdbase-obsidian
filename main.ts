import {
  App,
  addIcon,
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SuggestModal,
  TFile,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";
import {
  DEFAULT_DENY_RUNTIME_POLICY,
  InMemoryRuntimeHost,
  type MdbaseRuntimeHostApi,
  type MdbaseRuntimePolicyInfo,
} from "@callumalpass/mdbase-runtime";
import {
  MdbaseConfig,
  MdbaseIssue,
  MdbaseTypeDef,
  buildInitialFrontmatter,
  buildUniqueNotePath,
  coerceFieldInput,
  createNoteFromType,
  ensureCollectionInitialized,
  formatMarkdown,
  getPromptFields,
  getTopLevelFieldFromIssuePath,
  loadMdbaseConfig,
  loadTypeDefinitions,
  parseFrontmatter,
  validateCollection,
  validateFile,
} from "./src/mdbaseCore";
import type { TypeEditorModel } from "./src/typeEditorTypes";
import {
  loadSelectedRuntimePolicy,
  type RuntimePolicyDiagnostic,
} from "./src/runtimePolicy";
import {
  ConnectSyncController,
  type MirrorProfile,
} from "./src/connectSync";
import {
  analyzeV02Migration,
  applyV02Migration,
  type V02MigrationPlan,
} from "./src/migration";
import {
  frontmatterFromTypeModel,
  typeModelFromDocument,
} from "./src/typeModel";
import {
  MDBASE_WORKSPACE_VIEW,
  MdbaseWorkspaceView,
  type MdbaseWorkspaceSchema,
} from "./src/workspaceView";
import { MDBASE_ICON_ID, MDBASE_ICON_SVG } from "./src/mdbaseIcon";

const MDBASE_ISSUES_VIEW = "mdbase-issues-view";

interface MdbasePluginSettings {
  validateOnSave: boolean;
  validateOnOpen: boolean;
  showNoticeOnSave: boolean;
  mirrorProfile: MirrorProfile | null;
}

const DEFAULT_SETTINGS: MdbasePluginSettings = {
  validateOnSave: true,
  validateOnOpen: true,
  showNoticeOnSave: false,
  mirrorProfile: null,
};

function isMirrorProfile(value: unknown): value is MirrorProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Partial<MirrorProfile>;
  return profile.version === 1
    && typeof profile.syncUrl === "string"
    && typeof profile.controlUrl === "string"
    && typeof profile.collectionId === "string"
    && typeof profile.replicaId === "string"
    && (profile.mode === "read_only" || profile.mode === "read_write")
    && typeof profile.name === "string"
    && typeof profile.enrollmentId === "string"
    && typeof profile.accessTokenExpiresAt === "string";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  private severityFilter: "all" | "error" | "warn" = "all";
  private query = "";

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

    const headerActions = header.createDiv({ cls: "mdbase-issues-header-actions" });
    const refreshButton = headerActions.createEl("button", { text: "Refresh" });
    refreshButton.addClass("mod-cta");
    refreshButton.onclick = () => {
      void this.plugin.runCollectionValidation(false);
    };

    const controls = container.createDiv({ cls: "mdbase-issues-controls" });

    const severitySelect = controls.createEl("select");
    severitySelect.addClass("mdbase-issues-severity");
    severitySelect.createEl("option", { value: "all", text: "All severities" });
    severitySelect.createEl("option", { value: "error", text: "Errors only" });
    severitySelect.createEl("option", { value: "warn", text: "Warnings only" });
    severitySelect.value = this.severityFilter;
    severitySelect.onchange = () => {
      const next = severitySelect.value;
      if (next === "error" || next === "warn" || next === "all") {
        this.severityFilter = next;
      }
      this.render();
    };

    const queryInput = controls.createEl("input", { type: "search" });
    queryInput.addClass("mdbase-issues-query");
    queryInput.placeholder = "Filter by path, code, message, field";
    queryInput.value = this.query;
    queryInput.oninput = () => {
      this.query = queryInput.value;
      this.render();
    };

    const issues = this.plugin.getIssues();
    const normalizedQuery = this.query.trim().toLowerCase();
    const filtered = issues.filter((issue) => {
      if (this.severityFilter !== "all" && issue.severity !== this.severityFilter) return false;
      if (!normalizedQuery) return true;

      const haystack = `${issue.path} ${issue.code} ${issue.message} ${issue.field ?? ""}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });

    const visible = filtered.slice(0, 500);
    container.createDiv({
      cls: "mdbase-issues-count",
      text:
        filtered.length > visible.length
          ? `Showing ${visible.length} of ${filtered.length} matching issues`
          : filtered.length === issues.length
          ? `${filtered.length} issue${filtered.length === 1 ? "" : "s"}`
          : `${filtered.length} of ${issues.length} issue${issues.length === 1 ? "" : "s"}`,
    });

    if (filtered.length === 0) {
      container.createDiv({
        cls: "mdbase-empty",
        text: issues.length === 0 ? "No validation issues." : "No issues match current filters.",
      });
      return;
    }

    const grouped = new Map<string, MdbaseIssue[]>();
    for (const issue of visible) {
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

        const actions = item.createDiv({ cls: "mdbase-issue-actions" });
        const openButton = actions.createEl("button", {
          text: issue.field ? "Open field" : "Open file",
        });
        openButton.onclick = (event) => {
          event.stopPropagation();
          void this.plugin.openIssue(issue);
        };

        const quickFixLabel = this.plugin.getQuickFixLabel(issue);
        if (quickFixLabel) {
          const quickFixButton = actions.createEl("button", { text: quickFixLabel });
          quickFixButton.onclick = (event) => {
            event.stopPropagation();
            void this.plugin.applyQuickFix(issue);
          };
        }

        item.onclick = () => {
          void this.plugin.openIssue(issue);
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

interface LoadedSchema {
  config: MdbaseConfig;
  types: Map<string, MdbaseTypeDef>;
}

export interface MdbaseObsidianApiV1 {
  readonly apiVersion: 1;
  readonly runtime: MdbaseRuntimeHostApi;
  getRuntimeStatus(): {
    policyId: string;
    policyPath?: string;
    diagnostics: RuntimePolicyDiagnostic[];
  };
}

export default class MdbasePlugin extends Plugin {
  readonly api: MdbaseObsidianApiV1;
  readonly connectSync: ConnectSyncController;
  settings: MdbasePluginSettings;
  private issueMap = new Map<string, MdbaseIssue[]>();
  private sortedIssuesCache: MdbaseIssue[] | null = null;
  private statusBarEl: HTMLElement;
  private schemaCache: LoadedSchema | null = null;
  private schemaLoadPromise: Promise<LoadedSchema | null> | null = null;
  private pendingSaveValidations = new Map<string, number>();
  private readonly saveValidationDebounceMs = 250;
  private runtimePolicy: MdbaseRuntimePolicyInfo = {
    ...DEFAULT_DENY_RUNTIME_POLICY,
    capabilities: { ...DEFAULT_DENY_RUNTIME_POLICY.capabilities },
  };
  private runtimePolicyPath: string | undefined;
  private runtimePolicyDiagnostics: RuntimePolicyDiagnostic[] = [];
  private runtimePolicyRefreshGeneration = 0;

  constructor(app: App, manifest: import("obsidian").PluginManifest) {
    super(app, manifest);
    this.connectSync = new ConnectSyncController(app, {
      getMirrorProfile: () => this.getMirrorProfile(),
      saveMirrorProfile: async (profile) => {
        this.settings.mirrorProfile = profile;
        await this.saveSettings();
      },
    });
    this.api = {
      apiVersion: 1,
      runtime: new InMemoryRuntimeHost({ policyResolver: () => this.runtimePolicy }),
      getRuntimeStatus: () => ({
        policyId: this.runtimePolicy.id,
        policyPath: this.runtimePolicyPath,
        diagnostics: this.runtimePolicyDiagnostics.map((diagnostic) => ({ ...diagnostic })),
      }),
    };
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.refreshRuntimePolicy();
    addIcon(MDBASE_ICON_ID, MDBASE_ICON_SVG);

    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar();

    this.registerView(MDBASE_WORKSPACE_VIEW, (leaf) => new MdbaseWorkspaceView(leaf, this));
    this.registerView(MDBASE_ISSUES_VIEW, (leaf) => new MdbaseIssuesView(leaf, this));
    this.addSettingTab(new MdbaseSettingTab(this.app, this));
    this.addRibbonIcon(MDBASE_ICON_ID, "Open mdbase", () => void this.openWorkspace());

    this.addCommand({
      id: "mdbase-open",
      name: "mdbase: Open workspace",
      callback: () => void this.openWorkspace(),
    });

    this.addCommand({
      id: "mdbase-initialize-collection",
      name: "mdbase: Initialize collection",
      callback: () => void this.initializeCollectionCommand(),
    });

    this.addCommand({
      id: "mdbase-create-type",
      name: "mdbase: Create type definition",
      callback: () => void this.openWorkspace("types"),
    });

    this.addCommand({
      id: "mdbase-edit-type",
      name: "mdbase: Edit type definition",
      callback: () => void this.openWorkspace("types"),
    });

    this.addCommand({
      id: "mdbase-edit-current-type",
      name: "mdbase: Edit current type definition",
      callback: () => void this.openWorkspace("types"),
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
      callback: () => void this.openWorkspace("issues"),
    });

    this.addCommand({
      id: "mdbase-sync",
      name: "mdbase: Sync collection authority",
      callback: () => void this.syncHostedCollectionCommand(),
    });

    this.addCommand({
      id: "mdbase-open-sync",
      name: "mdbase: Open sync",
      callback: () => void this.openWorkspace("sync"),
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return;
        this.onVaultModify(file);
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        this.onVaultRename(file, oldPath);
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!(file instanceof TFile)) return;
        this.onVaultDelete(file);
      }),
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!(file instanceof TFile)) return;
        this.onVaultCreate(file);
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
    await this.api.runtime.dispose();
    this.app.workspace.getLeavesOfType(MDBASE_WORKSPACE_VIEW).forEach((leaf) => leaf.detach());
    this.app.workspace.getLeavesOfType(MDBASE_ISSUES_VIEW).forEach((leaf) => leaf.detach());
    this.clearAllPendingSaveValidations();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!isMirrorProfile(this.settings.mirrorProfile)) {
      this.settings.mirrorProfile = null;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getIssues(): MdbaseIssue[] {
    this.sortedIssuesCache ??= Array.from(this.issueMap.values())
      .flat()
      .sort((a, b) => a.path.localeCompare(b.path) || a.severity.localeCompare(b.severity) || a.code.localeCompare(b.code));
    return this.sortedIssuesCache;
  }

  getMirrorProfile(): MirrorProfile | null {
    return this.settings.mirrorProfile ? { ...this.settings.mirrorProfile } : null;
  }

  async loadWorkspaceSchema(forceReload = false): Promise<MdbaseWorkspaceSchema | null> {
    return this.getConfigAndTypes(forceReload);
  }

  async loadTypeModel(path: string): Promise<TypeEditorModel> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) throw new Error(`Type file not found: ${path}`);
    const parsed = parseFrontmatter(await this.app.vault.cachedRead(file));
    if (!parsed.hasFrontmatter || parsed.error) {
      throw new Error(`Invalid type frontmatter: ${parsed.error ?? "frontmatter is missing"}`);
    }
    return typeModelFromDocument(parsed.frontmatter, parsed.body, file.basename);
  }

  async saveTypeModel(model: TypeEditorModel, existingPath: string | null): Promise<TFile> {
    if (this.getMirrorProfile()?.mode === "read_only") {
      throw new Error("This mirror has read-only access. Re-enroll it with write access before editing types.");
    }
    const config = await loadMdbaseConfig(this.app.vault);
    if (!config) throw new Error("No mdbase.yaml found.");
    if (!config.spec_version.startsWith("0.3.")) {
      throw new Error("mdbase v0.2 type definitions are read-only. Migrate the collection first.");
    }
    const existing = existingPath
      ? this.app.vault.getAbstractFileByPath(normalizePath(existingPath))
      : null;
    if (existing != null && !(existing instanceof TFile)) {
      throw new Error(`Type file not found: ${existingPath}`);
    }
    const saved = await this.writeTypeDefinition(config, model, existing as TFile | null);
    this.refreshWorkspaceViews(true);
    return saved;
  }

  async initializeCollection(): Promise<void> {
    await this.initializeCollectionCommand();
    this.refreshWorkspaceViews(true);
  }

  async validateCollection(): Promise<void> {
    await this.runCollectionValidation(false);
  }

  analyzeMigration(): Promise<V02MigrationPlan> {
    if (this.getMirrorProfile()) {
      throw new Error("Collection authority resources must be migrated at the collection authority.");
    }
    return analyzeV02Migration(this.app.vault);
  }

  async applyMigration(plan: V02MigrationPlan, allowLossy: boolean): Promise<void> {
    if (this.getMirrorProfile()) {
      throw new Error("Collection authority resources must be migrated at the collection authority.");
    }
    const result = await applyV02Migration(this.app.vault, plan, { allowLossy });
    if (!result.applied) {
      throw new Error(
        result.restored
          ? `Migration failed and all writes were rolled back. ${result.error ?? ""}`.trim()
          : `Migration needs manual recovery. See ${result.manifestPath}. ${result.error ?? ""}`.trim(),
      );
    }
    this.invalidateSchemaCache();
    await this.refreshRuntimePolicy();
    new Notice(`Migrated to mdbase v0.3. Recovery manifest: ${result.manifestPath}`);
    this.refreshWorkspaceViews(true);
  }

  async openIssue(issue: MdbaseIssue): Promise<void> {
    await this.openFileByPath(issue.path, issue.field);
  }

  getQuickFixLabel(issue: MdbaseIssue): string | null {
    if (["unknown_field", "schema_additional_properties"].includes(issue.code) && issue.field) return "Remove field";
    if (["missing_required", "schema_required"].includes(issue.code) && issue.field) return "Add placeholder";
    return null;
  }

  async applyQuickFix(issue: MdbaseIssue): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(issue.path);
    if (!(file instanceof TFile)) {
      new Notice(`File not found: ${issue.path}`);
      return;
    }

    const raw = await this.app.vault.cachedRead(file);
    const parsed = parseFrontmatter(raw);

    if (parsed.error) {
      new Notice(`Cannot apply quick fix: invalid frontmatter (${parsed.error})`);
      return;
    }

    if (["unknown_field", "schema_additional_properties"].includes(issue.code) && issue.field) {
      const key = getTopLevelFieldFromIssuePath(issue.field);
      if (!(key in parsed.frontmatter)) {
        new Notice(`Field '${key}' not found in frontmatter.`);
        return;
      }

      delete parsed.frontmatter[key];
      await this.app.vault.modify(file, `${formatMarkdown(parsed.frontmatter, parsed.body)}\n`);
      new Notice(`Removed '${key}' from ${file.basename}`);
      await this.validateFileAndStore(file, "manual");
      return;
    }

    if (["missing_required", "schema_required"].includes(issue.code) && issue.field) {
      const key = getTopLevelFieldFromIssuePath(issue.field);
      if (parsed.frontmatter[key] === undefined) {
        parsed.frontmatter[key] = "TODO";
      }

      const body = parsed.hasFrontmatter ? parsed.body : raw;
      await this.app.vault.modify(file, `${formatMarkdown(parsed.frontmatter, body)}\n`);
      new Notice(`Added placeholder '${key}' to ${file.basename}`);
      await this.validateFileAndStore(file, "manual");
      return;
    }

    new Notice("No quick fix available for this issue.");
  }

  async openFileByPath(path: string, field?: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`File not found: ${path}`);
      return;
    }

    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
    if (field) {
      this.revealFrontmatterField(file, field);
    }
  }

  private revealFrontmatterField(file: TFile, fieldPath: string): void {
    const leaf = this.app.workspace.getMostRecentLeaf();
    if (!leaf) return;
    if (!(leaf.view instanceof MarkdownView)) return;

    const view = leaf.view;
    if (!(view.file instanceof TFile) || view.file.path !== file.path) return;

    const editor = view.editor;
    const totalLines = editor.lineCount();
    if (totalLines < 3) return;

    const targetKey = getTopLevelFieldFromIssuePath(fieldPath);
    const matcher = new RegExp(`^\\s*${escapeRegExp(targetKey)}\\s*:`);

    if (editor.getLine(0).trim() !== "---") return;
    for (let line = 1; line < totalLines; line += 1) {
      const value = editor.getLine(line);
      if (value.trim() === "---") break;
      if (matcher.test(value)) {
        editor.setCursor({ line, ch: 0 });
        editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
        return;
      }
    }
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

  async openWorkspace(destination: "types" | "sync" | "issues" = "types"): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(MDBASE_WORKSPACE_VIEW)[0];
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      const view = existing.view as MdbaseWorkspaceView;
      view.showDestination(destination);
      await view.refresh();
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: MDBASE_WORKSPACE_VIEW, active: true });
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view as MdbaseWorkspaceView;
    view.showDestination(destination);
  }

  private refreshWorkspaceViews(forceReload = false): void {
    for (const leaf of this.app.workspace.getLeavesOfType(MDBASE_WORKSPACE_VIEW)) {
      void (leaf.view as MdbaseWorkspaceView).refresh(forceReload);
    }
  }

  private refreshIssueViews(): void {
    this.updateStatusBar();
    for (const leaf of this.app.workspace.getLeavesOfType(MDBASE_ISSUES_VIEW)) {
      (leaf.view as MdbaseIssuesView).render();
    }
    this.refreshWorkspaceViews();
  }

  private setFileIssues(path: string, issues: MdbaseIssue[]): void {
    if (issues.length === 0) {
      this.issueMap.delete(path);
    } else {
      this.issueMap.set(path, issues);
    }
    this.sortedIssuesCache = null;
    this.refreshIssueViews();
  }

  private clearFileIssues(path: string): void {
    if (!this.issueMap.has(path)) return;
    this.issueMap.delete(path);
    this.sortedIssuesCache = null;
    this.refreshIssueViews();
  }

  private moveFileIssues(oldPath: string, newPath: string): void {
    const current = this.issueMap.get(oldPath);
    if (!current) return;

    this.issueMap.delete(oldPath);
    this.issueMap.set(
      newPath,
      current.map((issue) => ({
        ...issue,
        path: newPath,
      })),
    );
    this.sortedIssuesCache = null;
    this.refreshIssueViews();
  }

  private clearAllPendingSaveValidations(): void {
    for (const handle of this.pendingSaveValidations.values()) {
      window.clearTimeout(handle);
    }
    this.pendingSaveValidations.clear();
  }

  private clearPendingSaveValidation(path: string): void {
    const existing = this.pendingSaveValidations.get(path);
    if (existing != null) {
      window.clearTimeout(existing);
      this.pendingSaveValidations.delete(path);
    }
  }

  private scheduleSaveValidation(file: TFile): void {
    this.clearPendingSaveValidation(file.path);

    const handle = window.setTimeout(() => {
      this.pendingSaveValidations.delete(file.path);
      void this.validateFileAndStore(file, "save");
    }, this.saveValidationDebounceMs);

    this.pendingSaveValidations.set(file.path, handle);
  }

  private isSchemaRelevantPath(path: string): boolean {
    const normalized = normalizePath(path);
    if (normalized === "mdbase.yaml") return true;

    const possibleFolders = new Set<string>(["_types"]);
    if (this.schemaCache) {
      possibleFolders.add(normalizePath(this.schemaCache.config.settings.types_folder));
    }

    for (const folder of possibleFolders) {
      if (normalized === folder || normalized.startsWith(`${folder}/`)) return true;
    }

    return false;
  }

  private invalidateSchemaCache(): void {
    this.schemaCache = null;
    this.schemaLoadPromise = null;
  }

  private async getConfigAndTypes(forceReload = false): Promise<LoadedSchema | null> {
    if (forceReload) {
      this.invalidateSchemaCache();
    }

    if (this.schemaCache) return this.schemaCache;
    if (this.schemaLoadPromise) return this.schemaLoadPromise;

    this.schemaLoadPromise = (async () => {
      const config = await loadMdbaseConfig(this.app.vault);
      if (!config) return null;
      const types = await loadTypeDefinitions(this.app.vault, config);
      return { config, types };
    })();

    try {
      const loaded = await this.schemaLoadPromise;
      if (loaded) this.schemaCache = loaded;
      return loaded;
    } finally {
      this.schemaLoadPromise = null;
    }
  }

  private async requireConfigAndTypes(options: { background?: boolean; forceReload?: boolean } = {}): Promise<LoadedSchema | null> {
    const background = options.background ?? false;
    const loaded = await this.getConfigAndTypes(options.forceReload ?? false);
    if (!loaded) {
      if (!background) {
        new Notice("No mdbase.yaml found. Run 'mdbase: Initialize collection' first.");
      }
      return null;
    }

    if (loaded.types.size === 0 && !background) {
      new Notice(`No types found in ${loaded.config.settings.types_folder}`);
    }

    return loaded;
  }

  private onVaultModify(file: TFile): void {
    if (this.isRuntimePolicyRelevantPath(file.path)) void this.refreshRuntimePolicy();
    if (this.isSchemaRelevantPath(file.path)) {
      this.invalidateSchemaCache();
      this.refreshWorkspaceViews();
    }

    if (!this.settings.validateOnSave) return;
    if (file.extension !== "md") return;
    this.scheduleSaveValidation(file);
  }

  private onVaultRename(file: TFile, oldPath: string): void {
    if (this.isRuntimePolicyRelevantPath(oldPath) || this.isRuntimePolicyRelevantPath(file.path)) {
      void this.refreshRuntimePolicy();
    }
    if (this.isSchemaRelevantPath(oldPath) || this.isSchemaRelevantPath(file.path)) {
      this.invalidateSchemaCache();
      this.refreshWorkspaceViews();
    }

    if (file.extension !== "md") return;

    this.clearPendingSaveValidation(oldPath);
    this.moveFileIssues(oldPath, file.path);

    if (this.settings.validateOnSave) {
      this.scheduleSaveValidation(file);
    }
  }

  private onVaultDelete(file: TFile): void {
    if (this.isRuntimePolicyRelevantPath(file.path)) void this.refreshRuntimePolicy();
    if (this.isSchemaRelevantPath(file.path)) {
      this.invalidateSchemaCache();
      this.refreshWorkspaceViews();
    }

    if (file.extension !== "md") return;
    this.clearPendingSaveValidation(file.path);
    this.clearFileIssues(file.path);
  }

  private onVaultCreate(file: TFile): void {
    if (this.isRuntimePolicyRelevantPath(file.path)) void this.refreshRuntimePolicy();
    if (this.isSchemaRelevantPath(file.path)) {
      this.invalidateSchemaCache();
      this.refreshWorkspaceViews();
    }
  }

  private isRuntimePolicyRelevantPath(path: string): boolean {
    const normalized = normalizePath(path);
    return normalized === "mdbase.yaml" || normalized === this.runtimePolicyPath;
  }

  private async refreshRuntimePolicy(): Promise<void> {
    const generation = ++this.runtimePolicyRefreshGeneration;
    const config = await loadMdbaseConfig(this.app.vault);
    const selected = await loadSelectedRuntimePolicy(this.app.vault, config);
    if (generation !== this.runtimePolicyRefreshGeneration) return;
    this.runtimePolicy = selected.policy;
    this.runtimePolicyPath = selected.path;
    this.runtimePolicyDiagnostics = selected.diagnostics;
    for (const diagnostic of selected.diagnostics) {
      console.warn(`[mdbase/runtime] ${diagnostic.code}: ${diagnostic.message}`);
    }
  }

  private async validateFileAndStore(file: TFile, reason: "save" | "open" | "manual"): Promise<MdbaseIssue[]> {
    const loaded = await this.requireConfigAndTypes({ background: reason !== "manual" });
    if (!loaded) {
      if (reason !== "manual") {
        this.clearFileIssues(file.path);
      }
      return [];
    }

    const issues = await validateFile(this.app.vault, file, loaded.config, loaded.types);
    this.setFileIssues(file.path, issues);

    if (reason === "save" && this.settings.showNoticeOnSave && issues.length > 0) {
      new Notice(`mdbase: ${issues.length} issue${issues.length === 1 ? "" : "s"} in ${file.basename}`);
    }

    return issues;
  }

  private async initializeCollectionCommand(): Promise<void> {
    if (this.getMirrorProfile()) {
      new Notice("This vault is configured as a mirror. Sync it instead of initializing a local collection.");
      return;
    }
    const { created } = await ensureCollectionInitialized(this.app.vault);
    this.invalidateSchemaCache();

    if (created.length === 0) {
      new Notice("mdbase collection already initialized.");
      return;
    }

    new Notice(`Initialized mdbase collection: ${created.join(", ")}`);
  }

  private async syncHostedCollectionCommand(): Promise<void> {
    if (!this.getMirrorProfile()) {
      await this.openWorkspace("sync");
      return;
    }
    try {
      const status = await this.connectSync.sync();
      this.invalidateSchemaCache();
      this.refreshWorkspaceViews(true);
      const attentionCount = status.conflicts.length + status.local_issues.length;
      new Notice(
        attentionCount
          ? `Sync completed with ${attentionCount} item${attentionCount === 1 ? "" : "s"} needing attention.`
          : "mdbase sync completed.",
      );
    } catch (error) {
      new Notice(`mdbase sync failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.openWorkspace("sync");
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
    const loaded = await this.requireConfigAndTypes({ background: false });
    if (!loaded) return;

    const issues = await validateCollection(this.app.vault, loaded.config, loaded.types);
    const nextMap = new Map<string, MdbaseIssue[]>();
    for (const issue of issues) {
      const list = nextMap.get(issue.path) ?? [];
      list.push(issue);
      nextMap.set(issue.path, list);
    }

    this.issueMap = nextMap;
    this.sortedIssuesCache = null;
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

    if (!config.spec_version.startsWith("0.3.") || model.specProfile !== "v0.3") {
      throw new Error("mdbase v0.2 type definitions are read-only. Migrate the collection first.");
    }
    const frontmatter = frontmatterFromTypeModel(model);
    const body = model.body.trim() || `# ${typeName}\n\nType definition for ${typeName}.`;
    const content = `${formatMarkdown(frontmatter, body)}\n`;

    const typesFolder = normalizePath(config.settings.types_folder);
    const defaultTargetPath = normalizePath(`${typesFolder}/${typeName}.md`);

    if (!existingFile) {
      await this.ensureFolderExists(typesFolder);

      if (await this.app.vault.adapter.exists(defaultTargetPath)) {
        throw new Error(`Type already exists: ${defaultTargetPath}`);
      }

      const created = await this.app.vault.create(defaultTargetPath, content);
      this.invalidateSchemaCache();
      return created;
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
    this.invalidateSchemaCache();
    return updatedFile;
  }
}
