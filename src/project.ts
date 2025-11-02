import stripJsonComments from "strip-json-comments";
import * as vscode from "vscode";

const projectGlob = "{behavior_pack,*BP,BP_*,*bp,bp_*,resource_pack,*RP,RP_*,*rp,rp_*}";

export async function isMinecraftWorkspace() {
	const manifestPaths = await vscode.workspace.findFiles(
		`**/${projectGlob}/manifest.json`,
		"{.*,build,dist,out}",
	);
	if (manifestPaths.length === 0) {
		return false;
	}
	for (const path of manifestPaths) {
		const document = await vscode.workspace.openTextDocument(path);
		const text = stripJsonComments(document.getText());
		const json = JSON.parse(text);
		if ("format_version" in json && "header" in json && "modules" in json) {
			continue;
		}
		return false;
	}
	return true;
}

export function getProjectPaths() {
	const config = vscode.workspace.getConfiguration("rockide");
	const projectPaths = config.get("projectPaths");
	console.log(projectPaths);
	if (projectPaths && typeof projectPaths === "object") {
		if (!("behaviorPack" in projectPaths) || !("resourcePack" in projectPaths)) {
			vscode.window.showErrorMessage("Invalid project paths configuration.");
			return;
		}
		return projectPaths;
	}
}
