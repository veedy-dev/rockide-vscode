import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { promisify } from "util";
import { GitHubClient } from "./github";
import { Downloader } from "./downloader";
import { Extractor } from "./extractor";
import { getPlatformInfo } from "./platform";

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
    const customPath = vscode.workspace.getConfiguration("rockide").get<string>("binaryPath");
    if (customPath && fs.existsSync(customPath) && !options.forceReinstall) {
      return customPath;
    }

    const release = await this.getReleaseOrLatest(options.version);
    if (!release) {
      return null;
    }

    const installedPath = await this.getInstalledBinaryPath(release.tag_name);
    if (installedPath && !options.forceReinstall) {
      return installedPath;
    }

    const asset = this.githubClient.getAssetForPlatform(release);
    if (!asset) {
      vscode.window.showErrorMessage(
        `No Rockide binary available for your platform (${getPlatformInfo().archiveName})`
      );
      return null;
    }

    try {
      const checksumAsset = this.githubClient.getChecksumAssetForPlatform(release);
      const binaryPath = await this.downloadAndInstall(
        release.tag_name, 
        asset.browser_download_url,
        checksumAsset?.browser_download_url
      );
      
      await this.cleanupOldVersions();
      await this.verifyInstallation(binaryPath);

      vscode.window.showInformationMessage(`Rockide ${release.tag_name} installed successfully`);
      return binaryPath;
    } catch (error: any) {
      console.error("Installation failed:", error);
      vscode.window.showErrorMessage(`Failed to install Rockide: ${error.message}`);
      return null;
    }
  }

  private async getReleaseOrLatest(version?: string): Promise<any> {
    try {
      const release = version
        ? await this.githubClient.getRelease(version)
        : await this.githubClient.getLatestRelease();

      if (!release) {
        vscode.window.showErrorMessage("Failed to fetch Rockide release information");
        return null;
      }

      return release;
    } catch (error) {
      console.error("Failed to fetch release:", error);
      vscode.window.showErrorMessage("Failed to fetch Rockide release information");
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
      console.error("Failed to check for updates:", error);
      return false;
    }
  }

  async getCurrentVersion(): Promise<string | null> {
    try {
      const binaryPath = await this.getActiveBinaryPath();
      if (!binaryPath) return null;

      const match = binaryPath.match(/binaries[/\\](v?\d+\.\d+\.\d+)[/\\]/);
      if (match) {
        return match[1];
      }
      const versions = await this.getInstalledVersions();
      return versions.length > 0 ? versions[0] : null;
    } catch (error) {
      console.error("Failed to get current version:", error);
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

  private async downloadAndInstall(version: string, downloadUrl: string, checksumUrl?: string): Promise<string> {
    const platformInfo = getPlatformInfo();
    const tempDir = path.join(this.context.globalStorageUri.fsPath, "temp");
    const archivePath = path.join(tempDir, platformInfo.archiveName);
    const versionDir = path.join(this.getBinariesDir(), version);

    try {
      if (fs.existsSync(versionDir)) {
        await this.cleanup(versionDir);
      }

      await this.downloader.downloadWithProgress({
        url: downloadUrl,
        destPath: archivePath,
        progressTitle: `Downloading Rockide ${version}`,
        checksumUrl: checksumUrl,
        verifyChecksum: !!checksumUrl,
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
    if (!fs.existsSync(binaryPath)) {
      throw new Error(`Binary not found at ${binaryPath}`);
    }
    
    const stats = fs.statSync(binaryPath);
    if (stats.size < 1000000) {
      throw new Error(`Binary appears to be invalid (size: ${stats.size} bytes)`);
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
          try {
            await unlinkAsync(filePath);
          } catch (error: any) {
            // Handle locked files gracefully
            if (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES') {
              console.warn(`File is locked and will be cleaned on next restart: ${filePath}`);
              // Continue with other files instead of stopping
              continue;
            }
            throw error; // Re-throw other errors
          }
        }
      }
      
      // Try to remove directory, but don't fail if it contains locked files
      try {
        await rmdirAsync(dirPath);
      } catch (error: any) {
        if (error.code === 'ENOTEMPTY') {
          console.warn(`Directory contains locked files and will be cleaned on next restart: ${dirPath}`);
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.warn(`Failed to cleanup ${dirPath}:`, error);
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