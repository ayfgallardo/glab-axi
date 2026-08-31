#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const stateFile = process.env.GLAB_AXI_FAKE_STATE;
if (!stateFile) throw new Error("GLAB_AXI_FAKE_STATE is required");

const state = JSON.parse(readFileSync(stateFile, "utf8"));
const args = process.argv.slice(2);

function optionValue(name) {
  const index = args.indexOf(name);
  if (index !== -1) return args[index + 1];
  const prefix = `${name}=`;
  const arg = args.find((candidate) => candidate.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function optionValues(name) {
  const values = [];
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name) {
      values.push(args[index + 1]);
      index++;
    } else if (args[index].startsWith(prefix)) {
      values.push(args[index].slice(prefix.length));
    }
  }
  return values;
}

function save() {
  writeFileSync(stateFile, JSON.stringify(state), "utf8");
}

function releaseByPath(path) {
  const idMatch = path.match(/^projects\/[^/]+\/releases\/([^/]+)$/);
  if (idMatch) {
    return state.releases.find(
      (release) => release.tag_name === decodeURIComponent(idMatch[1]),
    );
  }
  return undefined;
}

if (args[0] === "release" && args[1] === "create") {
  const tag = args[2];
  let release = state.releases.find((r) => r.tag_name === tag);
  if (!release) {
    release = { tag_name: tag, name: tag, description: null };
    state.releases.push(release);
  }
  const name = optionValue("--name");
  if (name !== undefined) release.name = name;
  const notes = optionValue("--notes");
  if (notes !== undefined) release.description = notes;
  save();
  console.error(`https://gitlab.com/group/project/-/releases/${tag}`);
  process.exit(0);
}

if (args[0] === "api") {
  const path = args[1];
  const method = optionValue("--method") ?? "GET";
  const release = releaseByPath(path);
  if (!release) {
    console.error("release not found");
    process.exit(1);
  }

  if (method === "PATCH" || method === "POST" || method === "PUT") {
    for (const field of optionValues("--field")) {
      const separator = field.indexOf("=");
      const key = field.slice(0, separator);
      release[key] = field.slice(separator + 1);
    }
    save();
  }

  console.log(JSON.stringify(release));
  process.exit(0);
}

console.error(`unsupported fake glab invocation: ${args.join(" ")}`);
process.exit(1);
