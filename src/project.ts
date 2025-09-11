import * as JSONC from "jsonc-parser";
import { window, workspace } from "vscode";

const projectGlob = "{behavior_pack,*BP,BP_*,*bp,bp_*,resource_pack,*RP,RP_*,*rp,rp_*}";

export async function isMinecraftWorkspace() {
  const manifestPaths = await workspace.findFiles(
    `**/${projectGlob}/manifest.json`,
    "{.*,build,dist,out}",
  );
  if (manifestPaths.length === 0) {
    return false;
  }
  for (const path of manifestPaths) {
    const document = await workspace.openTextDocument(path);
    const json = JSONC.parse(document.getText());
    if ("format_version" in json && "header" in json && "modules" in json) {
      continue;
    }
    return false;
  }
  return true;
}

export function getProjectPaths() {
  const config = workspace.getConfiguration("rockide");
  const projectPaths = config.get("projectPaths");
  if (projectPaths && typeof projectPaths === "object") {
    if (!("behaviorPack" in projectPaths) || !("resourcePack" in projectPaths)) {
      window.showErrorMessage("Invalid project paths configuration.");
      return;
    }
    return projectPaths;
  }
}
