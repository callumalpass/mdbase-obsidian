export type TypeEditorStrictMode = boolean | "warn";

export interface TypeEditorField {
  name: string;
  definition: Record<string, unknown>;
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
  body: string;
  extraFrontmatter: Record<string, unknown>;
}
