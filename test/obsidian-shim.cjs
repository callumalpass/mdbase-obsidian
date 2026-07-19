const Module = require("module");
const mock = require("./obsidian-mock.cjs");

const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "obsidian") {
    return mock;
  }
  return originalLoad(request, parent, isMain);
};
