import * as vscode from "vscode";
import { getPlatformInfo } from "./platform";
import { logger } from "./logger";

const GITHUB_API_URL = "https://api.github.com/repos/veedy-dev/rockide/releases";

export interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string;
  assets: GitHubAsset[];
  body?: string;
}

export interface GitHubAsset {
  id: number;
  name: string;
  size: number;
  download_count: number;
  created_at: string;
  updated_at: string;
  browser_download_url: string;
  content_type: string;
}

export class GitHubClient {
  private userAgent = "rockide-vscode";

  async getLatestRelease(): Promise<GitHubRelease | null> {
    try {
      const response = await fetch(`${GITHUB_API_URL}/latest`, {
        headers: {
          "User-Agent": this.userAgent,
          Accept: "application/vnd.github.v3+json",
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      return await response.json() as GitHubRelease;
    } catch (error) {
      logger.error("Failed to fetch latest release", error);
      throw error;
    }
  }

  async getAllReleases(): Promise<GitHubRelease[]> {
    try {
      const response = await fetch(GITHUB_API_URL, {
        headers: {
          "User-Agent": this.userAgent,
          Accept: "application/vnd.github.v3+json",
        },
      });

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      const releases = await response.json() as GitHubRelease[];
      return releases;
    } catch (error) {
      logger.error("Failed to fetch releases", error);
      throw error;
    }
  }

  async getRelease(version: string): Promise<GitHubRelease | null> {
    try {
      const releases = await this.getAllReleases();
      return releases.find((r) => r.tag_name === version || r.tag_name === `v${version}`) || null;
    } catch (error) {
      logger.error(`Failed to fetch release ${version}`, error);
      throw error;
    }
  }

  getAssetForPlatform(release: GitHubRelease): GitHubAsset | null {
    const platformInfo = getPlatformInfo();
    const asset = release.assets.find((a) => a.name === platformInfo.archiveName);

    if (!asset) {
      logger.warn(`No asset found for platform: ${platformInfo.archiveName}`);
      return null;
    }

    return asset;
  }

  async selectRelease(releases?: GitHubRelease[]): Promise<GitHubRelease | undefined> {
    const list = releases || (await this.getAllReleases());
    const limited = list
      .slice()
      .sort((a, b) => {
        const ad = new Date(a.published_at || a.created_at).getTime();
        const bd = new Date(b.published_at || b.created_at).getTime();
        return bd - ad;
      })
      .slice(0, 5);

    const items = limited.map((release) => ({
      label: release.tag_name,
      description: release.name || undefined,
      detail: release.prerelease ? "Pre-release" : undefined,
      release,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: "Select a Rockide version to install",
    });

    return selected?.release;
  }
}
