import { GoogleGenAI } from "@google/genai";
import * as vscode from "vscode";
import {
  CancellationToken,
  CodeAction,
  CodeActionContext,
  CodeActionKind,
  CodeActionProvider,
  commands,
  Diagnostic,
  DocumentSelector,
  ExtensionContext,
  languages,
  Range,
  TextDocument,
  Uri,
  window,
  workspace,
} from "vscode";

import * as showdown from "showdown";
import { LanguageClient } from "vscode-languageclient";
const converter = new showdown.Converter();

function LOGHERE(...args) {
  console.log("[LAHACKS2025]", ...args);
}

let client: LanguageClient;

// Globals
// const htmlLanguageService = getLanguageService();

let geminiApiKey: string;
let ai: GoogleGenAI;
let lastFixContext: string;
let fixes: CodeAction[];
let quickfixProvider: DiagnosticAggregatorViewProvider;

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
    process.env["GEMINI_KEY"];
  ai = new GoogleGenAI({ apiKey: geminiApiKey });

  const selector: DocumentSelector = "*";
  context.subscriptions.push(
    languages.registerCodeActionsProvider(
      selector,
      new MyCodeActionProvider(),
      {
        providedCodeActionKinds: MyCodeActionProvider.providedCodeActionKinds,
      }
    )
  );
  quickfixProvider = new DiagnosticAggregatorViewProvider(context.extensionUri);
  context.subscriptions.push(
    window.registerWebviewViewProvider("quickfixSidebarView", quickfixProvider)
  );

  // callback for the command
  context.subscriptions.push(
    commands.registerCommand(
      "quickfixSidebar.show",
      async (contextArg: { uri: string; diagnostic: vscode.Diagnostic }) => {
        lastFixContext = contextArg.uri;
        LOGHERE("lastFixContext", lastFixContext, contextArg.diagnostic);
        // Call Gemini API using the ai client
        // TODO(rtk0c): prompt engineer better
        const result = await ai.models.generateContent({
          model: "gemini-2.0-flash",
          contents:
            "Explain this diagnostic. Keep your response to roughly 1 paragraph. Diagnostic: " +
            contextArg.diagnostic.message,
        });
        const explanation = result.candidates[0].content.parts[0].text;

        // Set the content of the view
        const html = converter.makeHtml(explanation);
        quickfixProvider.currentWebview.html = `<p>${html}</p>`;
        // Open the view
        await vscode.commands.executeCommand(
          "workbench.view.extension.quickfixSidebar"
        );
      }
    )
  );

  // this fn is called whenever diagnostics change
  // so inside we want to get the list of diagnostics and
  // get an explanation for why each of them occurred
  // we should probably do thi as send a message to
  // gemini to explain the diagnostics
  languages.onDidChangeDiagnostics((e) => {
    explainDiag(languages.getDiagnostics());
  });
}

class DiagnosticAggregatorViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ) {
    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    // Save reference for updating later
    this.currentWebview = webviewView.webview;
  }

  getHtmlForWebview(webview: vscode.Webview): string {
    return "<div>Press The QuickFix Explain item to see the explanation for a diagnostic here</div>";
  }

  public currentWebview?: vscode.Webview;
}

class MyCodeActionProvider implements CodeActionProvider {
  static readonly providedCodeActionKinds = [CodeActionKind.QuickFix];

  provideCodeActions(
    document: TextDocument,
    range: Range,
    context: CodeActionContext,
    token: CancellationToken
  ): CodeAction[] {
    console.log("this was called, and fixes is");
    console.log(fixes);
    return fixes;
  }
}

async function explainDiag(diagnostics: [Uri, Diagnostic[]][]): Promise<void> {
  fixes = [];
  for (const v of diagnostics) {
    const [uri, diags] = v;
    // const coll = languages.createDiagnosticCollection();
    for (const diagnostic of diags) {
      const doc = await workspace.openTextDocument(uri);
      const contextSrcCode: string = doc.getText();
      // LOGHERE("thingggggg");
      // LOGHERE(contextSrcCode);
      // TODO:
      // - have the option to explain something as a quick fix - DONE
      // - have an option to refactor it to fix the diagnostic - TODO later

      // explain something as a quick fix
      const fix = new CodeAction("Explain", CodeActionKind.QuickFix);
      fix.diagnostics = [diagnostic];
      fix.command = {
        title: "Explain",
        command: "quickfixSidebar.show",
        arguments: [{ uri: uri.toString(), diagnostic: diagnostic }],
      };
      LOGHERE("made fix", fix);
      fixes.push(fix);
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
