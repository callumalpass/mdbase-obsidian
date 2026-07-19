function normalizePath(path) {
  return String(path).replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

function parseYaml(raw) {
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Mock parseYaml expects JSON-compatible YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stringifyYaml(value) {
  return JSON.stringify(value, null, 2);
}

class TFile {
  constructor(path) {
    this.path = normalizePath(path);
    const segments = this.path.split("/");
    const filename = segments[segments.length - 1] || "";
    const dotIndex = filename.lastIndexOf(".");
    this.basename = dotIndex >= 0 ? filename.slice(0, dotIndex) : filename;
    this.extension = dotIndex >= 0 ? filename.slice(dotIndex + 1) : "";
  }
}

class Vault {}

module.exports = {
  normalizePath,
  parseYaml,
  stringifyYaml,
  TFile,
  Vault,
};
