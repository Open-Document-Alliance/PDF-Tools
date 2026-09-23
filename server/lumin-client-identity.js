import { readFileSync } from "node:fs";

const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = packageMetadata.version;
if (packageMetadata.name !== "pdf-tools" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("invalid PDF Tools package identity");
}

export const LUMIN_CLIENT_USER_AGENT = `PDF-Tools/${version}`;
