export type TypeEditorStrictMode = boolean | "warn";

export interface TypeEditorField {
  name: string;
  definition: Record<string, unknown>;
}

export interface TypeEditorContractImplementation {
  contract: string;
  version: string;
  fields: Record<string, string>;
  binding?: Record<string, unknown>;
}

export interface TypeEditorModel {
  specProfile?: "v0.2" | "v0.3";
  originalFrontmatter?: Record<string, unknown>;
  readOnlyReason?: string;
  name: string;
  description: string;
  extendsType: string;
  displayNameKey: string;
  strictMode: TypeEditorStrictMode;
  pathPattern: string;
  filenamePattern: string;
  matchPathGlob: string;
  matchFieldsPresent: string;
  matchWhere: string;
  fields: TypeEditorField[];
  implementations: TypeEditorContractImplementation[];
  body: string;
  extraFrontmatter: Record<string, unknown>;
  /** Revision of the exact source document this draft was loaded from. */
  sourceRevision?: string;
}

export interface StoredTypeDraft {
  version: 1;
  path: string | null;
  sourceRevision: string | null;
  model: TypeEditorModel;
  editorMode?: "design" | "yaml";
  yamlDraft?: string;
  updatedAt: string;
}
