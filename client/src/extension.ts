/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { GoogleGenAI } from "@google/genai";
import {
  Diagnostic,
  ExtensionContext,
  languages,
  Uri,
  window,
  workspace,
} from "vscode";
import { LanguageClient } from "vscode-languageclient";

function LOGHERE(...args) {
  console.log("[LAHACKS2025]", ...args);
}

let client: LanguageClient;

// Globals
// const htmlLanguageService = getLanguageService();

let geminiApiKey: string;
let ai: GoogleGenAI;

export function activate(context: ExtensionContext) {
  // // The server is implemented in node
  // const serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));

  // // If the extension is launched in debug mode then the debug server options are used
  // // Otherwise the run options are used
  // const serverOptions: ServerOptions = {
  // 	run: { module: serverModule, transport: TransportKind.ipc },
  // 	debug: {
  // 		module: serverModule,
  // 		transport: TransportKind.ipc,
  // 	}
  // };

  // const virtualDocumentContents = new Map<string, string>();

  // workspace.registerTextDocumentContentProvider('embedded-content', {
  // 	provideTextDocumentContent: uri => {
  // 		const originalUri = uri.path.slice(1).slice(0, -4);
  // 		const decodedUri = decodeURIComponent(originalUri);
  // 		return virtualDocumentContents.get(decodedUri);
  // 	}
  // });

  // const clientOptions: LanguageClientOptions = {
  // 	documentSelector: [{ scheme: 'file', language: 'html1' }],
  // 	middleware: {
  // 		provideCompletionItem: async (document, position, context, token, next) => {
  // 			// If not in `<style>`, do not perform request forwarding
  // 			if (!isInsideStyleRegion(htmlLanguageService, document.getText(), document.offsetAt(position))) {
  // 				return await next(document, position, context, token);
  // 			}

  // 			const originalUri = document.uri.toString(true);
  // 			virtualDocumentContents.set(originalUri, getCSSVirtualContent(htmlLanguageService, document.getText()));

  // 			const vdocUriString = `embedded-content://css/${encodeURIComponent(
  // 				originalUri
  // 			)}.css`;
  // 			const vdocUri = Uri.parse(vdocUriString);
  // 			return await commands.executeCommand<CompletionList>(
  // 				'vscode.executeCompletionItemProvider',
  // 				vdocUri,
  // 				position,
  // 				context.triggerCharacter
  // 			);
  // 		}
  // 	}
  // };

  // // Create the language client and start the client.
  // client = new LanguageClient(
  // 	'languageServerExample',
  // 	'Language Server Example',
  // 	serverOptions,
  // 	clientOptions
  // );

  // // Start the client. This will also launch the server
  // client.start();

  // FIXME(rtk0c): don't read env var in prod, here in dev it's easier than changing a json config file in the slave vscode
  geminiApiKey =
    workspace.getConfiguration().get("lahacks2025.geminiApiKey") ||
    process.env["GEMINI_API"];
  ai = new GoogleGenAI({ apiKey: geminiApiKey });

  // this fn is called whenever diagnostics change
  // so inside we want to get the list of diagnostics and
  // get an explanation for why each of them occurred
  // we should probably do thi as send a message to
  // gemini to explain the diagnostics
  languages.onDidChangeDiagnostics((e) => {
    explainDiag(languages.getDiagnostics());
  });
}

async function explainDiag(diagnostics: [Uri, Diagnostic[]][]): Promise<void> {
  for (const v of diagnostics) {
    const [uri, diagnostics] = v;
    // const coll = languages.createDiagnosticCollection();
    for (const diagnostic of diagnostics) {
      // TODO(rtk0c): prompt engineer better
      const question = `Explain this diagnostic: ${diagnostic.message} (Source: ${diagnostic.source}, Code: ${diagnostic.code})`;
      const answer = await window.showInformationMessage(question, "Explain");
      if (answer === "Explain") {
        try {
          // Call Gemini API using the ai client
          const result = await ai.models.generateContent({
            model: "gemini-2.0-flash",
            contents: question,
          });
          LOGHERE("diagnostic", diagnostic);
          LOGHERE(result);
          const explanation = result.candidates[0].content.parts[0].text;
          window.showInformationMessage(
            `Explanation for: ${diagnostic.message} - ${explanation}`
          );
        } catch (error) {
          window.showErrorMessage(`Error explaining diagnostic: ${error}`);
        }
      }
    }
  }
}

export async function deactivate(): Promise<void> {
  // if (!client) {
  // 	return undefined;
  // }
  // return client.stop();
  return undefined;
}
