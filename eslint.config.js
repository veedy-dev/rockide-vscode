import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
	eslint.configs.recommended,
	tseslint.configs.recommended,
	{
		rules: {
			curly: "warn",
			eqeqeq: "warn",
			"no-throw-literal": "warn",
		},
	},
	globalIgnores(["esbuild.js"]),
);
