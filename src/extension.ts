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
    logger.log("Rockide extension activating...");
    
    // Initialize installer first - this is needed for commands to work
    logger.log("Initializing installer...");
    installer = new RockideInstaller(context);
    logger.log("Installer initialized successfully");
    
    // Register commands
    logger.log("Registering commands...");
    registerCommands(context);
    logger.log("Commands registered successfully");

    // Try to start language server if in appropriate workspace
    // This is optional and should not block activation
    try {
      logger.log("Checking workspace type...");
      const isMinecraft = await isMinecraftWorkspace();
      logger.log(`Workspace is Minecraft: ${isMinecraft}`);
      
      if (isMinecraft) {
        if (!isValidPlatform()) {
          window.showErrorMessage("Your platform is not supported by Rockide");
          logger.log("Platform not supported, language server not started");
        } else {
          logger.log("Attempting to start language server...");
          const binaryPath = await ensureRockideBinary(context);
          if (!binaryPath) {
            window.showErrorMessage("Failed to initialize Rockide. Please check the extension output for details.");
            logger.log("Failed to get binary path, language server not started");
          } else {
            logger.log(`Starting language server with binary: ${binaryPath}`);
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
            await client.start();
            logger.log("Language server started successfully");
          }
        }
      } else {
        logger.log("Not in a Minecraft workspace, language server not started");
      }
    } catch (error) {
      // Don't let language server initialization failure prevent activation
      logger.error("Failed to initialize language server", error);
    }
    
    logger.log("Rockide extension activated successfully");
  } catch (error) {
    // Log the error but don't throw - we want activation to succeed
    logger.error("Error during extension activation", error);
    logger.log("Extension activated with errors - commands should still work");
    
    // Show error to user but don't block
    const errorMessage = error instanceof Error ? error.message : String(error);
    window.showErrorMessage(`Rockide extension encountered an error during activation: ${errorMessage}. Commands may still work.`);
  }
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
  const twentyFourHours = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

  if (now - lastCheck < twentyFourHours) {
    logger.log(`Skipping update check, last checked ${Math.round((now - lastCheck) / (60 * 60 * 1000))} hours ago`);
    return;
  }

  // Update the last check timestamp
  await context.globalState.update(lastCheckKey, now);
  logger.log("Checking for Rockide updates...");

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
    } else {
      logger.log("Rockide is up to date");
    }
  } catch (error) {
    logger.error("Failed to check for updates", error);
  }
}

async function updateRockide(): Promise<void> {
  if (!installer) {
    throw new Error("Installer not initialized");
  }
  
  logger.log("Starting Rockide update...");
  const newPath = await installer.install({ forceReinstall: true });
  if (newPath) {
    logger.log(`Rockide updated successfully to: ${newPath}`);
    const choice = await window.showInformationMessage(
      "Rockide has been updated. Please reload the window to use the new version.",
      "Reload"
    );

    if (choice === "Reload") {
      logger.log("Reloading window...");
      commands.executeCommand("workbench.action.reloadWindow");
    }
  } else {
    logger.error("Update completed but no path returned");
    window.showErrorMessage("Failed to update Rockide");
  }
}

function registerCommands(context: ExtensionContext): void {
  logger.log("Registering Rockide commands...");
  
  context.subscriptions.push(
    commands.registerCommand("rockide.update", async () => {
      logger.log("Update command invoked");
      try {
        // Ensure installer is initialized
        if (!installer) {
          logger.warn("Installer not initialized, creating new instance");
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
      logger.log("Select version command invoked");
      try {
        // Ensure installer is initialized
        if (!installer) {
          logger.warn("Installer not initialized, creating new instance");
          installer = new RockideInstaller(context);
        }
        
        const githubClient = new GitHubClient();
        logger.log("Fetching releases...");
        const releases = await githubClient.getAllReleases();
        logger.log(`Found ${releases.length} releases`);
        
        if (!releases || releases.length === 0) {
          window.showWarningMessage("No Rockide releases found");
          return;
        }
        
        const selected = await githubClient.selectRelease(releases);
        if (selected) {
          logger.log(`User selected version: ${selected.tag_name}`);
          const newPath = await installer.install({ 
            version: selected.tag_name, 
            forceReinstall: true 
          });
          
          if (newPath) {
            window.showInformationMessage(`Rockide ${selected.tag_name} installed successfully.`);
          } else {
            logger.error("Installation returned no path");
            window.showErrorMessage("Failed to install selected version");
          }
        } else {
          logger.log("User cancelled version selection");
        }
      } catch (error) {
        logger.error("Select version command failed", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        window.showErrorMessage(`Failed to fetch releases: ${errorMessage}`);
      }
    })
  );
  
  logger.log("Commands registered");
}

export function deactivate() {
  return client?.stop();
}
