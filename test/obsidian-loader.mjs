import { pathToFileURL } from "node:url";

const mockUrl = pathToFileURL(new URL("./obsidian-mock.cjs", import.meta.url).pathname).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "obsidian") {
    return {
      url: mockUrl,
      shortCircuit: true,
    };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!specifier.match(/\.[a-z0-9]+$/i)) {
      return nextResolve(`${specifier}.js`, context);
    }
    throw error;
  }
}
