import * as crypto from "crypto";
import * as fs from "fs";
import { promisify } from "util";

const readFileAsync = promisify(fs.readFile);

export class CryptoUtils {
  static async calculateFileHash(filePath: string): Promise<string> {
    const fileBuffer = await readFileAsync(filePath);
    const hash = crypto.createHash("sha256");
    hash.update(fileBuffer);
    return hash.digest("hex");
  }

  static calculateBufferHash(buffer: Buffer): string {
    const hash = crypto.createHash("sha256");
    hash.update(buffer);
    return hash.digest("hex");
  }

  static parseChecksumFile(content: string, filename: string): string | null {
    const lines = content.split("\n");
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      
      const match = trimmedLine.match(/^([a-fA-F0-9]{64})\s+\*?(\S+)$/);
      if (match && match[2] === filename) {
        return match[1].toLowerCase();
      }
    }
    
    return null;
  }

  static async verifyFileHash(filePath: string, expectedHash: string): Promise<boolean> {
    try {
      const actualHash = await this.calculateFileHash(filePath);
      return actualHash.toLowerCase() === expectedHash.toLowerCase();
    } catch (error) {
      console.error("Failed to verify file hash:", error);
      return false;
    }
  }

  static normalizeHash(hash: string): string {
    return hash.trim().toLowerCase();
  }
}