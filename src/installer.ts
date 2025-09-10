import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { promisify } from "util";
import { exec } from "child_process";
import { GitHubClient } from "./github";
import { Downloader } from "./downloader";
import { Extractor } from "./extractor";
import { getPlatformInfo } from "./platform";
import { logger } from "./logger";

const execAsync = promisify(exec);
const readdirAsync = promisify(fs.readdir);
const statAsync = promisify(fs.stat);
const rmdirAsync = promisify(fs.rmdir);
const unlinkAsync = promisify(fs.unlink);

export interface InstallOptions {
  version?: string;
  forceReinstall?: boolean;
}

export class RockideInstaller {
  private githubClient: GitHubClient;
  private downloader: Downloader;
  private extractor: Extractor;
  private context: vscode.ExtensionContext;
  private maxVersions = 5;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.githubClient = new GitHubClient();
    this.downloader = new Downloader();
    this.extractor = new Extractor();
  }

  async install(options: InstallOptions = {}): Promise<string | null> {
    try {
      const customPath = vscode.workspace.getConfiguration("rockide").get<string>("binaryPath");
      if (customPath && fs.existsSync(customPath) && !options.forceReinstall) {
        logger.log(`Using custom binary path: ${customPath}`);
        return customPath;
      }

      const release = options.version
        ? await this.githubClient.getRelease(options.version)
        : await this.githubClient.getLatestRelease();

      if (!release) {
        vscode.window.showErrorMessage("Failed to fetch Rockide release information");
        return null;
      }

      const installedPath = await this.getInstalledBinaryPath(release.tag_name);
      if (installedPath && !options.forceReinstall) {
        logger.log(`Rockide already installed: ${installedPath}`);
        return installedPath;
      }

      const asset = this.githubClient.getAssetForPlatform(release);
      if (!asset) {
        vscode.window.showErrorMessage(
          `No Rockide binary available for your platform (${getPlatformInfo().archiveName})`
        );
        return null;
      }

      const binaryPath = await this.downloadAndInstall(release.tag_name, asset.browser_download_url);
      
      await this.cleanupOldVersions();
      await this.verifyInstallation(binaryPath);

      vscode.window.showInformationMessage(`Rockide ${release.tag_name} installed successfully`);
      return binaryPath;
    } catch (error: any) {
      logger.error("Installation failed", error);
      vscode.window.showErrorMessage(`Failed to install Rockide: ${error.message}`);
      return null;
    }
  }

  async checkForUpdates(): Promise<boolean> {
    try {
      const currentVersion = await this.getCurrentVersion();
      const latestRelease = await this.githubClient.getLatestRelease();

      if (!latestRelease || !currentVersion) {
        return false;
      }

      return latestRelease.tag_name !== currentVersion;
    } catch (error) {
      logger.error("Failed to check for updates", error);
      return false;
    }
  }

  async getCurrentVersion(): Promise<string | null> {
    try {
      const binaryPath = await this.getActiveBinaryPath();
      if (!binaryPath) return null;

      const { stdout } = await execAsync(`"${binaryPath}" --version`);
      const match = stdout.match(/v?(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    } catch (error) {
      logger.error("Failed to get current version", error);
      return null;
    }
  }

  async getActiveBinaryPath(): Promise<string | null> {
    const customPath = vscode.workspace.getConfiguration("rockide").get<string>("binaryPath");
    if (customPath && fs.existsSync(customPath)) {
      return customPath;
    }

    const versions = await this.getInstalledVersions();
    if (versions.length === 0) {
      return null;
    }

    const latestVersion = versions[0];
    const platformInfo = getPlatformInfo();
    return path.join(this.getBinariesDir(), latestVersion, platformInfo.executableName);
  }

  private async downloadAndInstall(version: string, downloadUrl: string): Promise<string> {
    const platformInfo = getPlatformInfo();
    const tempDir = path.join(this.context.globalStorageUri.fsPath, "temp");
    const archivePath = path.join(tempDir, platformInfo.archiveName);
    const versionDir = path.join(this.getBinariesDir(), version);

    try {
      await this.downloader.downloadWithProgress({
        url: downloadUrl,
        destPath: archivePath,
        progressTitle: `Downloading Rockide ${version}`,
      });

      const binaryPath = await this.extractor.extractTarGz(archivePath, versionDir);
      
      await this.extractor.cleanup(archivePath);
      await this.cleanupTempDir();

      return binaryPath;
    } catch (error) {
      await this.cleanup(versionDir);
      throw error;
    }
  }

  private async verifyInstallation(binaryPath: string): Promise<void> {
    try {
      const { stdout, stderr } = await execAsync(`"${binaryPath}" --version`);
      logger.log(`Rockide version: ${stdout || stderr}`);
    } catch (error) {
      throw new Error(`Binary verification failed: ${error}`);
    }
  }

  private async getInstalledBinaryPath(version: string): Promise<string | null> {
    const platformInfo = getPlatformInfo();
    const binaryPath = path.join(this.getBinariesDir(), version, platformInfo.executableName);
    
    if (fs.existsSync(binaryPath)) {
      return binaryPath;
    }
    
    return null;
  }

  private async getInstalledVersions(): Promise<string[]> {
    const binariesDir = this.getBinariesDir();
    
    if (!fs.existsSync(binariesDir)) {
      return [];
    }

    const entries = await readdirAsync(binariesDir);
    const versions: { name: string; time: number }[] = [];

    for (const entry of entries) {
      const fullPath = path.join(binariesDir, entry);
      const stat = await statAsync(fullPath);
      
      if (stat.isDirectory()) {
        versions.push({ name: entry, time: stat.mtimeMs });
      }
    }

    return versions
      .sort((a, b) => b.time - a.time)
      .map((v) => v.name);
  }

  private async cleanupOldVersions(): Promise<void> {
    const versions = await this.getInstalledVersions();
    
    if (versions.length <= this.maxVersions) {
      return;
    }

    const versionsToRemove = versions.slice(this.maxVersions);
    
    for (const version of versionsToRemove) {
      const versionDir = path.join(this.getBinariesDir(), version);
      await this.cleanup(versionDir);
    }
  }

  private async cleanup(dirPath: string): Promise<void> {
    if (!fs.existsSync(dirPath)) {
      return;
    }

    try {
      const files = await readdirAsync(dirPath);
      
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stat = await statAsync(filePath);
        
        if (stat.isDirectory()) {
          await this.cleanup(filePath);
        } else {
          await unlinkAsync(filePath);
        }
      }
      
      await rmdirAsync(dirPath);
    } catch (error) {
      logger.warn(`Failed to cleanup ${dirPath}: ${error}`);
    }
  }

  private async cleanupTempDir(): Promise<void> {
    const tempDir = path.join(this.context.globalStorageUri.fsPath, "temp");
    await this.cleanup(tempDir);
  }

  private getBinariesDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, "binaries");
  }
}