import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { promisify } from "util";
import { logger } from "./logger";

const writeFileAsync = promisify(fs.writeFile);

export interface DownloadOptions {
  url: string;
  destPath: string;
  progressTitle?: string;
}

export class Downloader {
  async downloadWithProgress(options: DownloadOptions): Promise<string> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: options.progressTitle || "Downloading Rockide",
        cancellable: true,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => {
          throw new Error("Download cancelled by user");
        });

        progress.report({ increment: 0, message: "Starting download..." });

        try {
          const response = await fetch(options.url);

          if (!response.ok) {
            throw new Error(`Download failed: ${response.status} ${response.statusText}`);
          }

          const contentLength = response.headers.get("content-length");
          const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;

          if (!response.body) {
            throw new Error("No response body");
          }

          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let downloadedBytes = 0;

          while (true) {
            if (token.isCancellationRequested) {
              throw new Error("Download cancelled by user");
            }

            const { done, value } = await reader.read();

            if (done) break;

            chunks.push(value);
            downloadedBytes += value.length;

            if (totalBytes > 0) {
              const percentage = Math.round((downloadedBytes / totalBytes) * 100);
              progress.report({
                increment: percentage,
                message: `${this.formatBytes(downloadedBytes)} / ${this.formatBytes(totalBytes)}`,
              });
            } else {
              progress.report({
                message: `Downloaded ${this.formatBytes(downloadedBytes)}`,
              });
            }
          }

          const buffer = Buffer.concat(chunks);
          await this.ensureDirectoryExists(path.dirname(options.destPath));
          await writeFileAsync(options.destPath, buffer);

          return options.destPath;
        } catch (error) {
          await this.cleanup(options.destPath);
          throw error;
        }
      }
    );
  }

  async download(url: string, destPath: string): Promise<void> {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    await this.ensureDirectoryExists(path.dirname(destPath));
    await writeFileAsync(destPath, Buffer.from(buffer));
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
  }

  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  private async cleanup(filePath: string): Promise<void> {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      logger.warn(`Failed to cleanup ${filePath}: ${error}`);
    }
  }
}