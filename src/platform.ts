export type Platform = "darwin" | "linux" | "windows";
export type Architecture = "amd64" | "arm64";

export interface PlatformInfo {
  platform: Platform;
  arch: Architecture;
  isWindows: boolean;
  executableName: string;
  archiveName: string;
}

export function getPlatform(): Platform {
  switch (process.platform) {
    case "darwin":
      return "darwin";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

export function getArchitecture(): Architecture {
  switch (process.arch) {
    case "x64":
      return "amd64";
    case "arm64":
      return "arm64";
    default:
      throw new Error(`Unsupported architecture: ${process.arch}`);
  }
}

export function getPlatformInfo(): PlatformInfo {
  const platform = getPlatform();
  const arch = getArchitecture();
  const isWindows = platform === "windows";
  const executableName = isWindows ? "rockide.exe" : "rockide";
  const archiveName = `rockide_${platform}_${arch}.tar.gz`;

  return {
    platform,
    arch,
    isWindows,
    executableName,
    archiveName,
  };
}

export function isValidPlatform(): boolean {
  try {
    getPlatformInfo();
    return true;
  } catch {
    return false;
  }
}