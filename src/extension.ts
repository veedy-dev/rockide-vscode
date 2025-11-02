import * as vscode from "vscode";
import { startClient, stopClient } from "./lsp";
import { isMinecraftWorkspace } from "./project";
import {
	getDefaultRockidePath,
	getInstalledRockideExe,
	promptInstallRockide,
	updateRockide,
} from "./rockide";

export async function activate(ctx: vscode.ExtensionContext) {
	ctx.subscriptions.push(
		vscode.commands.registerCommand("rockide.update", async () => {
			try {
				await updateRockide(ctx);
			} catch (err) {
				if (err instanceof Error) {
					vscode.window.showErrorMessage(err.message);
				}
			}
		}),
	);

	let rockideExe = await getInstalledRockideExe(ctx);
	if (!rockideExe) {
		try {
			rockideExe = getDefaultRockidePath(ctx);
			await promptInstallRockide(rockideExe);
		} catch (err) {
			if (err instanceof Error) {
				vscode.window.showErrorMessage(err.message);
			}
			return;
		}
	}

	if (await isMinecraftWorkspace()) {
		await startClient(rockideExe);
		await updateRockide(ctx, true);
	}
}

export async function deactivate() {
	await stopClient();
}
