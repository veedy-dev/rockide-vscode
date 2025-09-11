import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { exec } from "child_process";
import { getPlatformInfo } from "./platform";
import { logger } from "./logger";

const execAsync = promisify(exec);
const mkdirAsync = promisify(fs.mkdir);
const chmodAsync = promisify(fs.chmod);

export class Extractor {
  async extractTarGz(archivePath: string, destDir: string): Promise<string> {
    await this.ensureDirectoryExists(destDir);

    const platformInfo = getPlatformInfo();
    const extractedPath = path.join(destDir, platformInfo.executableName);

    try {
      if (platformInfo.isWindows) {
        await this.extractWindows(archivePath, destDir);
      } else {
        await this.extractUnix(archivePath, destDir);
      }

      if (!platformInfo.isWindows) {
        await this.setExecutablePermissions(extractedPath);
      }

      return extractedPath;
    } catch (error) {
      logger.error("Extraction failed", error);
      throw new Error(`Failed to extract archive: ${error}`);
    }
  }

  private async extractWindows(archivePath: string, destDir: string): Promise<void> {
    try {
      await execAsync(`tar -xzf "${archivePath}" -C "${destDir}"`, {
        shell: "cmd.exe",
      });
    } catch (error) {
      logger.error("tar command failed on Windows, trying PowerShell", error);
      await this.extractWithPowerShell(archivePath, destDir);
    }
  }

  private async extractWithPowerShell(archivePath: string, destDir: string): Promise<void> {
    // Windows 10 1803+ has tar built-in, use it through PowerShell
    const command = `tar -xzf "${archivePath}" -C "${destDir}"`;
    
    await execAsync(command, {
      shell: "powershell.exe",
    });
  }

  private async extractUnix(archivePath: string, destDir: string): Promise<void> {
    await execAsync(`tar -xzf "${archivePath}" -C "${destDir}"`);
  }

  private async setExecutablePermissions(filePath: string): Promise<void> {
    try {
      await chmodAsync(filePath, 0o755);
    } catch (error) {
      logger.warn(`Failed to set executable permissions: ${error}`);
    }
  }

  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      await mkdirAsync(dirPath, { recursive: true });
    } catch (error: any) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
  }

  async cleanup(filePath: string): Promise<void> {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      logger.warn(`Failed to cleanup ${filePath}: ${error}`);
    }
  }
}