// The images .github/workflows/images.yml builds (D379): one entry per image in tools/production.json, built from its
// production branch's files (publish-production.mjs --export), so an image holds exactly what Coolify builds from the branch today.
//   node tools/image-matrix.mjs            prints matrix=[{branch, image, context, dockerfile, args, coolify, setting}, ...]
//     coolify and setting: the Coolify application and the setting the deploy job writes the image's digest to, or ""
//   node tools/image-matrix.mjs --args     reads VARS (the Actions variables as JSON) and ARGS, prints the build arguments
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function matrix(config) {
  return config.components.flatMap(c =>
    (c.images ?? []).map(i => ({
      branch: c.name,
      image: i.name,
      context: i.context,
      dockerfile: i.dockerfile,
      args: Object.entries(i.buildArgs ?? {}).map(([arg, variable]) => `${arg}=${variable}`).join(","),
      coolify: i.deploy?.coolify ?? "",
      setting: i.deploy?.setting ?? "",
    })),
  );
}

/** "ARG=VARIABLE,..." with the variables' values: build-args lines, and the variables that are not set. */
export function buildArgs(args, vars) {
  const lines = [];
  const missing = [];
  for (const pair of args.split(",").filter(Boolean)) {
    const [arg, variable] = pair.split("=");
    const value = String(vars[variable] ?? "").trim();
    if (!value) missing.push(variable);
    lines.push(`${arg}=${value}`);
  }
  return { lines, missing };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--args")) {
    const { lines, missing } = buildArgs(process.env.ARGS ?? "", JSON.parse(process.env.VARS || "{}"));
    if (missing.length) console.error(`Not set as repository Actions variables: ${missing.join(", ")}`);
    console.log(`missing=${missing.join(",")}`);
    console.log(`args<<EOF\n${lines.join("\n")}\nEOF`);
  } else {
    const config = JSON.parse(readFileSync(join(here, "production.json"), "utf8"));
    console.log(`matrix=${JSON.stringify(matrix(config))}`);
  }
}
