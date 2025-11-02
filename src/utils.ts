import { execFile } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";
import { gunzip } from "zlib";

export const execFileAsync = promisify(execFile);

export const gunzipAsync = promisify(gunzip);

export async function exists(uri: vscode.Uri) {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}
