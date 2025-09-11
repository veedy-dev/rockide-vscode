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
          
          // Add timeout to prevent hanging during binary resolution
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
          
          // Clear the timeout to prevent spurious warnings
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          
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
            // Don't await - let it start in background to prevent blocking activation
            client.start().then(() => {
              logger.log("Language server started successfully");
            }).catch((error) => {
              logger.error("Language server failed to start", error);
            });
            logger.log("Language server starting in background...");
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
  logger.log("ensureRockideBinary: Starting binary resolution...");
  
  const config = workspace.getConfiguration("rockide");
  const customPath = config.get<string>("binaryPath");

  if (customPath && fs.existsSync(customPath)) {
    logger.log(`ensureRockideBinary: Using custom Rockide binary: ${customPath}`);
    return customPath;
  }

  logger.log("ensureRockideBinary: Getting active binary path from installer...");
  let binaryPath = await installer.getActiveBinaryPath();
  logger.log(`ensureRockideBinary: Active binary path: ${binaryPath || "none"}`);
  
  if (!binaryPath || !(await verifyBinary(binaryPath))) {
    logger.log("ensureRockideBinary: No valid binary found, attempting installation...");
    const preferredVersion = config.get<string>("version");
    const installOptions = preferredVersion && preferredVersion !== "latest" 
      ? { version: preferredVersion } 
      : {};
    logger.log(`ensureRockideBinary: Installing with options: ${JSON.stringify(installOptions)}`);
    
    binaryPath = await installer.install(installOptions);
    logger.log(`ensureRockideBinary: Installation complete, binary path: ${binaryPath || "none"}`);
  } else if (config.get<boolean>("checkForUpdates", true)) {
    logger.log("ensureRockideBinary: Binary valid, checking for updates in background...");
    checkForUpdatesInBackground(context);
  }

  if (!binaryPath) {
    logger.log("ensureRockideBinary: No binary from installer, checking system PATH...");
    binaryPath = await findRockideInPath();
    if (binaryPath) {
      logger.log(`ensureRockideBinary: Found in PATH: ${binaryPath}`);
      window.showInformationMessage("Using Rockide from system PATH");
    }
  }

  logger.log(`ensureRockideBinary: Final binary path: ${binaryPath || "none"}`);
  return binaryPath;
}

async function verifyBinary(binaryPath: string): Promise<boolean> {
  logger.log(`verifyBinary: Checking binary at ${binaryPath}`);
  // Since rockide is a language server, we just check if the file exists
  // instead of trying to execute it with --version
  const exists = fs.existsSync(binaryPath);
  logger.log(`verifyBinary: Binary exists: ${exists}`);
  return exists;
}

async function findRockideInPath(): Promise<string | null> {
  logger.log("findRockideInPath: Searching for Rockide in system PATH...");
  try {
    const { stdout } = await execAsync("where rockide", { timeout: 3000 });
    const paths = stdout.trim().split("\n").filter(Boolean);
    if (paths[0]) {
      logger.log(`findRockideInPath: Found in PATH (where): ${paths[0]}`);
      return paths[0];
    }
  } catch (error) {
    logger.log(`findRockideInPath: 'where' command failed: ${error instanceof Error ? error.message : String(error)}`);
    try {
      const { stdout } = await execAsync("which rockide", { timeout: 3000 });
      const path = stdout.trim();
      if (path) {
        logger.log(`findRockideInPath: Found in PATH (which): ${path}`);
        return path;
      }
    } catch (error2) {
      logger.log(`findRockideInPath: 'which' command failed: ${error2 instanceof Error ? error2.message : String(error2)}`);
    }
  }
  logger.log("findRockideInPath: Rockide not found in system PATH");
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
  
  logger.log("Checking for Rockide updates...");
  
  // Check if update is available
  const hasUpdate = await installer.checkForUpdates();
  if (!hasUpdate) {
    logger.log("Rockide is already up to date");
    window.showInformationMessage("Rockide is already up to date");
    return;
  }
  
  // Stop language server if running
  if (client) {
    logger.log("Stopping language server for update...");
    await client.stop();
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
