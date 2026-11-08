import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
export const dataRoot = join(projectRoot, "data");
export const latestResearchPath = join(dataRoot, "latest-research.json");
