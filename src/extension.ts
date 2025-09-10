import { ExtensionContext, Uri, window, workspace, commands } from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions } from "vscode-languageclient/node";
import { getProjectPaths, isMinecraftWorkspace } from "./project";
import { RockideInstaller } from "./installer";
import { isValidPlatform } from "./platform";
import { logger } from "./logger";
import * as fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

let client: LanguageClient;
let installer: RockideInstaller;

export async function activate(context: ExtensionContext) {
  if (!(await isMinecraftWorkspace())) {
    return;
  }

  if (!isValidPlatform()) {
    window.showErrorMessage("Your platform is not supported by Rockide");
    return;
  }

  installer = new RockideInstaller(context);

  const binaryPath = await ensureRockideBinary(context);
  if (!binaryPath) {
    window.showErrorMessage("Failed to initialize Rockide. Please check the extension output for details.");
    return;
  }

  const serverOptions: ServerOptions = {
    command: binaryPath,
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "json" },
      { scheme: "file", language: "jsonc" },
    ],
    uriConverters: {
      code2Protocol: (uri) => uri.toString(true),
      protocol2Code: (path) => Uri.parse(path),
    },
    initializationOptions: getProjectPaths(),
  };
  client = new LanguageClient("rockide", "Rockide", serverOptions, clientOptions);
  client.onNotification("shutdown", () => {
    client.stop();
  });
  client.start();

  registerCommands(context);
}

async function ensureRockideBinary(context: ExtensionContext): Promise<string | null> {
  const config = workspace.getConfiguration("rockide");
  const customPath = config.get<string>("binaryPath");

  if (customPath && fs.existsSync(customPath)) {
    logger.log(`Using custom Rockide binary: ${customPath}`);
    return customPath;
  }

  let binaryPath = await installer.getActiveBinaryPath();
  
  if (!binaryPath || !(await verifyBinary(binaryPath))) {
    const preferredVersion = config.get<string>("version");
    const installOptions = preferredVersion && preferredVersion !== "latest" 
      ? { version: preferredVersion } 
      : {};
    
    binaryPath = await installer.install(installOptions);
  } else if (config.get<boolean>("checkForUpdates", true)) {
    checkForUpdatesInBackground();
  }

  if (!binaryPath) {
    binaryPath = await findRockideInPath();
    if (binaryPath) {
      window.showInformationMessage("Using Rockide from system PATH");
    }
  }

  return binaryPath;
}

async function verifyBinary(binaryPath: string): Promise<boolean> {
  try {
    await execAsync(`"${binaryPath}" --version`);
    return true;
  } catch {
    return false;
  }
}

async function findRockideInPath(): Promise<string | null> {
  try {
    const { stdout } = await execAsync("where rockide");
    const paths = stdout.trim().split("\n").filter(Boolean);
    return paths[0] || null;
  } catch {
    try {
      const { stdout } = await execAsync("which rockide");
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
}

async function checkForUpdatesInBackground(): Promise<void> {
  const config = workspace.getConfiguration("rockide");
  const autoUpdate = config.get<boolean>("autoUpdate", true);

  if (!autoUpdate) {
    return;
  }

  const hasUpdate = await installer.checkForUpdates();
  if (hasUpdate) {
    const choice = await window.showInformationMessage(
      "A new version of Rockide is available. Would you like to update?",
      "Update",
      "Later"
    );

    if (choice === "Update") {
      await updateRockide();
    }
  }
}

async function updateRockide(): Promise<void> {
  const newPath = await installer.install({ forceReinstall: true });
  if (newPath) {
    const choice = await window.showInformationMessage(
      "Rockide has been updated. Please reload the window to use the new version.",
      "Reload"
    );

    if (choice === "Reload") {
      commands.executeCommand("workbench.action.reloadWindow");
    }
  }
}

function registerCommands(context: ExtensionContext): void {
  context.subscriptions.push(
    commands.registerCommand("rockide.update", () => updateRockide()),
    commands.registerCommand("rockide.selectVersion", async () => {
      const githubClient = await import("./github.js").then(m => new m.GitHubClient());
      const releases = await githubClient.getAllReleases();
      const selected = await githubClient.selectRelease(releases);
      
      if (selected) {
        const newPath = await installer.install({ 
          version: selected.tag_name, 
          forceReinstall: true 
        });
        
        if (newPath) {
          window.showInformationMessage(`Rockide ${selected.tag_name} installed. Please reload the window.`);
        }
      }
    })
  );
}

export function deactivate() {
  return client?.stop();
}
