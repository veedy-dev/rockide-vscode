function getOS() {
	switch (process.platform) {
		case "win32":
			return "windows";
		default:
			return process.platform;
	}
}

function getArch() {
	switch (process.arch) {
		case "x64":
			return "amd64";
		case "arm64":
			return "arm64";
		default:
			return process.arch;
	}
}

const os = getOS();

const arch = getArch();

export const platform = {
	os,
	arch,
	exe: "rockide" + (os === "windows" ? ".exe" : ""),
} as const;
