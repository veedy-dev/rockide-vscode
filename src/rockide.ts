import { chmod } from "fs/promises";
import { unpackTar } from "modern-tar";
import { isAbsolute, resolve } from "path";
import * as semver from "semver";
import * as vscode from "vscode";
import which from "which";
import { GitHubRelease, downloadAsset, getLatestRelease } from "./github";
import { startClient, stopClient } from "./lsp";
import { platform } from "./platform";
import { execFileAsync, exists, gunzipAsync } from "./utils";

const UPDATE_CHECK_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours

async function getCustomRockidePath() {
	const config = vscode.workspace.getConfiguration("rockide");
	const path = config.get<string>("path");
	if (!path || path.trim().length === 0) {
		return null;
	}
	if (isAbsolute(path)) {
		return vscode.Uri.file(path);
	}

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		return null;
	}
	for (const workspace of workspaceFolders) {
		const uri = vscode.Uri.file(resolve(workspace.uri.fsPath, path));
		if (await exists(uri)) {
			return uri;
		}
	}
	throw new Error(`Invalid Rockide path: ${path}`);
}

export function getDefaultRockidePath(ctx: vscode.ExtensionContext) {
	return vscode.Uri.joinPath(ctx.globalStorageUri, platform.exe);
}

export async function getInstalledRockideExe(ctx: vscode.ExtensionContext) {
	const path = await getCustomRockidePath();
	if (path) {
		return path;
	}

	const rockideExe = await which("rockide", { nothrow: true });
	if (rockideExe) {
		return vscode.Uri.file(rockideExe);
	}

	const defaultExe = getDefaultRockidePath(ctx);
	if (await exists(defaultExe)) {
		return defaultExe;
	}

	return null;
}

export async function promptInstallRockide(dest: vscode.Uri) {
	const res = await vscode.window.showInformationMessage(
		"Rockide language server is not installed. Do you want to install it now?",
		"Yes",
		"No",
	);
	if (res !== "Yes") {
		throw new Error("Rockide language server is not installed.");
	}
	await installRockide(dest);
}

export async function installRockide(dest: vscode.Uri, release?: GitHubRelease) {
	release ??= await getLatestRelease();
	const target = `rockide_${release.tag_name}_${platform.os}_${platform.arch}.tar.gz`;
	const asset = release.assets.find((v) => v.name === target);
	if (!asset) {
		throw new Error(`Unsupported target platform: ${platform.os} ${platform.arch}.`);
	}

	const entries = await downloadAsset(asset)
		.then(gunzipAsync)
		.then(unpackTar);
	const exe = entries.find((e) => e.header.name === platform.exe);
	if (!exe || !exe.data) {
		throw new Error("Failed to get Rockide executable data.");
	}

	if (await exists(dest)) {
		const old = vscode.Uri.file(dest.fsPath + ".old");
		if (await exists(old)) {
			await vscode.workspace.fs.delete(old);
		}
		await vscode.workspace.fs.rename(dest, old);
	}
	await vscode.workspace.fs.writeFile(dest, exe.data);
	await chmod(dest.fsPath, 0o755);

	vscode.window.showInformationMessage(`Rockide ${release.tag_name} successfully installed!`);
}

export async function updateRockide(ctx: vscode.ExtensionContext, silent?: boolean) {
	const now = Date.now();
	if (silent) {
		const lastUpdate = ctx.globalState.get<number>("lastUpdate", 0);
		const elapsed = now - lastUpdate;
		if (elapsed < UPDATE_CHECK_INTERVAL) {
			return;
		}
	}
	await ctx.globalState.update("lastUpdate", now);

	const rockideExe = await getInstalledRockideExe(ctx);
	if (!rockideExe) {
		const defaultExe = getDefaultRockidePath(ctx);
		return promptInstallRockide(defaultExe);
	}

	const { stdout } = await execFileAsync(rockideExe.fsPath, ["--version"]);
	const currentVersion = semver.clean(stdout);
	if (!currentVersion) {
		// don't prompt update when using dev build
		return;
	}

	const release = await getLatestRelease();
	if (semver.eq(release.tag_name, currentVersion)) {
		if (!silent) {
			vscode.window.showInformationMessage("Rockide is already up to date.");
		}
		return;
	}

	const res = await vscode.window.showInformationMessage(
		"A new version of Rockide is available. Would you like to update?",
		"Update",
		"Later",
	);
	if (res !== "Update") {
		return;
	}

	await stopClient();
	await installRockide(rockideExe, release);
	await startClient(rockideExe);
}
