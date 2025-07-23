import { ExtensionContext, Uri } from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions } from "vscode-languageclient/node";
import { getProjectPaths, isMinecraftWorkspace } from "./project";

let client: LanguageClient;

export async function activate(context: ExtensionContext) {
  if (!(await isMinecraftWorkspace())) {
    return;
  }
  const serverOptions: ServerOptions = {
    command: "rockide",
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
  client.start();
}

export function deactivate() {
  return client?.stop();
}
