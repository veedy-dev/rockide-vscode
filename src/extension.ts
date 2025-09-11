import { ExtensionContext, Uri, window, workspace, commands } from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions } from "vscode-languageclient/node";
import { getProjectPaths, isMinecraftWorkspace } from "./project";
import { RockideInstaller } from "./installer";
import { GitHubClient } from "./github";
import { isValidPlatform } from "./platform";
import { logger } from "./logger";
import * as fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

let client: LanguageClient;
let installer: RockideInstaller;

export async function activate(context: ExtensionContext) {
  try {
    installer = new RockideInstaller(context);
    registerCommands(context);

    try {
      const isMinecraft = await isMinecraftWorkspace();
      
      if (isMinecraft) {
        if (!isValidPlatform()) {
          window.showErrorMessage("Your platform is not supported by Rockide");
        } else {
          let timeoutId: NodeJS.Timeout | undefined;
          const timeoutPromise = new Promise<string | null>((resolve) => {
            timeoutId = setTimeout(() => {
              logger.warn("Binary resolution timed out after 30 seconds");
              resolve(null);
            }, 30000);
          });
          
          const binaryPath = await Promise.race([
            ensureRockideBinary(context),
            timeoutPromise
          ]);
          
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          
          if (!binaryPath) {
            window.showErrorMessage("Failed to initialize Rockide. Please check the extension output for details.");
          } else {
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
            client.start().catch((error) => {
              logger.error("Language server failed to start", error);
            });
          }
        }
      }
    } catch (error) {
      logger.error("Failed to initialize language server", error);
    }
  } catch (error) {
    logger.error("Error during extension activation", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    window.showErrorMessage(`Rockide extension encountered an error during activation: ${errorMessage}. Commands may still work.`);
  }
}

async function ensureRockideBinary(context: ExtensionContext): Promise<string | null> {
  const config = workspace.getConfiguration("rockide");
  const customPath = config.get<string>("binaryPath");

  if (customPath && fs.existsSync(customPath)) {
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
    checkForUpdatesInBackground(context);
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
  return fs.existsSync(binaryPath);
}

async function findRockideInPath(): Promise<string | null> {
  try {
    const { stdout } = await execAsync("where rockide", { timeout: 3000 });
    const paths = stdout.trim().split("\n").filter(Boolean);
    if (paths[0]) {
      return paths[0];
    }
  } catch {
    try {
      const { stdout } = await execAsync("which rockide", { timeout: 3000 });
      const path = stdout.trim();
      if (path) {
        return path;
      }
    } catch {
    }
  }
  return null;
}

async function checkForUpdatesInBackground(context: ExtensionContext): Promise<void> {
  const config = workspace.getConfiguration("rockide");
  const autoUpdate = config.get<boolean>("autoUpdate", true);

  if (!autoUpdate) {
    return;
  }

  // Check if 24 hours have passed since last check
  const lastCheckKey = "rockide.lastUpdateCheck";
  const lastCheck = context.globalState.get<number>(lastCheckKey, 0);
  const now = Date.now();
  const twentyFourHours = 24 * 60 * 60 * 1000;

  if (now - lastCheck < twentyFourHours) {
    return;
  }

  await context.globalState.update(lastCheckKey, now);

  try {
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
  } catch (error) {
    logger.error("Failed to check for updates", error);
  }
}

async function updateRockide(): Promise<void> {
  if (!installer) {
    throw new Error("Installer not initialized");
  }
  
  const hasUpdate = await installer.checkForUpdates();
  if (!hasUpdate) {
    window.showInformationMessage("Rockide is already up to date");
    return;
  }
  
  if (client) {
    await client.stop();
  }
  
  const newPath = await installer.install({ forceReinstall: true });
  if (newPath) {
    const choice = await window.showInformationMessage(
      "Rockide has been updated. Please reload the window to use the new version.",
      "Reload"
    );

    if (choice === "Reload") {
      commands.executeCommand("workbench.action.reloadWindow");
    }
  } else {
    window.showErrorMessage("Failed to update Rockide");
  }
}

function registerCommands(context: ExtensionContext): void {
  context.subscriptions.push(
    commands.registerCommand("rockide.update", async () => {
      try {
        if (!installer) {
          installer = new RockideInstaller(context);
        }
        
        await updateRockide();
      } catch (error) {
        logger.error("Update command failed", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        window.showErrorMessage(`Failed to update: ${errorMessage}`);
      }
    }),
    
    commands.registerCommand("rockide.selectVersion", async () => {
      try {
        if (!installer) {
          installer = new RockideInstaller(context);
        }
        
        const githubClient = new GitHubClient();
        const releases = await githubClient.getAllReleases();
        
        if (!releases || releases.length === 0) {
          window.showWarningMessage("No Rockide releases found");
          return;
        }
        
        const selected = await githubClient.selectRelease(releases);
        if (selected) {
          const newPath = await installer.install({ 
            version: selected.tag_name, 
            forceReinstall: true 
          });
          
          if (newPath) {
            window.showInformationMessage(`Rockide ${selected.tag_name} installed successfully.`);
          } else {
            window.showErrorMessage("Failed to install selected version");
          }
        }
      } catch (error) {
        logger.error("Select version command failed", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        window.showErrorMessage(`Failed to fetch releases: ${errorMessage}`);
      }
    })
  );
}

export function deactivate() {
  return client?.stop();
}
