import { GoogleGenAI, Type } from "@google/genai";
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
let AIPoweredDiagnostics: vscode.DiagnosticCollection;

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
      const result = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents:
          "Explain this diagnostic. Keep your response to roughly 1 paragraph. Diagnostic: " +
          contextArg.diagnostic.message,
      });

      const explanation = result.candidates[0].content.parts[0].text;

      const htmlExplanation = converter.makeHtml(explanation);
quickfixProvider.currentWebview.html = `
  <div>
    <div id="renderedExplanation">${htmlExplanation}</div> 
    <p id="explanationText" style="display: none;">${explanation}</p>
    <div id="buttonContainer"></div>

    <script>
      const vscode = acquireVsCodeApi();
      window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
          case 'showAddChangesButton':
            createAddChangesButton();
            break;
          case 'hideAddChangesButton':
            clearAddChangesButton();
            break;
        }
      });

      function createAddChangesButton() {
        const container = document.getElementById('buttonContainer');
        container.innerHTML = '<button id="addChangesButton">Add Changes</button>';
        document.getElementById('addChangesButton').addEventListener('click', () => {
          const explanationText = document.getElementById('explanationText');
          vscode.postMessage({
            command: 'addChanges',
            explanation: explanationText.innerText
          });
        });
      }

      function clearAddChangesButton() {
        const container = document.getElementById('buttonContainer');
        container.innerHTML = '';
      }
    </script>
  </div>
`;

      // Open the view
      await vscode.commands.executeCommand(
        "workbench.view.extension.quickfixSidebar"
      );

      // THEN post the message to show the button
      quickfixProvider.currentWebview?.postMessage({ command: 'showAddChangesButton' });
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

  // also listen for saved files and then come up with
  // ai-powered diagnostics for them
  AIPoweredDiagnostics = languages.createDiagnosticCollection("ai-powered");
  context.subscriptions.push(AIPoweredDiagnostics);
  context.subscriptions.push(
    workspace.onDidSaveTextDocument(makeAIPoweredDiagnostics)
  );
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
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'addChanges':
          {
            if (!lastFixContext) {
              vscode.window.showErrorMessage('No file context available for applying changes.');
              return;
            }
    
            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(lastFixContext));
            const text = document.getText(); // <-- entire file contents
    
            const prompt = `
You are an expert developer.
Given the following code and the provided recommendation, modify the code to address the recommendation with minimal changes.
KEEP the structure, styling, and remove the need for code fences.

Original Code:
${text}

Recommendation:
${message.explanation}

Please return ONLY the pure revised code WITHOUT any \`\`\` markers, markdown, or explanations.
`;
    
            const result = await ai.models.generateContent({
              model: "gemini-2.0-flash",
              contents: prompt,
            });
    
            const revisedCode = result.candidates[0].content.parts[0].text;
    
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
              document.positionAt(0),
              document.positionAt(text.length)
            );
            edit.replace(document.uri, fullRange, revisedCode);
            await vscode.workspace.applyEdit(edit);
    
            await document.save(); // save automatically
            vscode.window.showInformationMessage('File successfully updated with AI suggestions!');
          }
          break;
      }
    });
    // Save reference for updating later
    this.currentWebview = webviewView.webview;
  }

  getHtmlForWebview(webview: vscode.Webview): string {
    return `
      <div>
        <p>Press The QuickFix Explain item to see the explanation for a diagnostic here</p>
        <div id="buttonContainer"></div>
      </div>

      <script>
        const vscode = acquireVsCodeApi();

        window.addEventListener('message', event => {
          const message = event.data;
          switch (message.command) {
            case 'showAddChangesButton':
              createAddChangesButton();
              break;
            case 'hideAddChangesButton':
              clearAddChangesButton();
              break;
          }
        });

        function createAddChangesButton() {
          const container = document.getElementById('buttonContainer');
          container.innerHTML = '<button id="addChangesButton">Add Changes</button>';

          document.getElementById('addChangesButton').addEventListener('click', () => {
            vscode.postMessage({ command: 'addChanges' });
          });
        }

        function clearAddChangesButton() {
          const container = document.getElementById('buttonContainer');
          container.innerHTML = '';
        }
      </script>
    `;
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

async function makeAIPoweredDiagnostics(doc: TextDocument): Promise<void> {
  console.log("makeAIPoweredDiagnostics called");
  AIPoweredDiagnostics.delete(doc.uri);
  // need to get a list of diagnostics
  // from the given document
  // try just asking?
  const lines = doc.getText().split("\n");
  const processedText = lines
    .map((line, idx) => {
      return `${idx}|${line}`;
    })
    .join("\n");

  const prompt = `You are acting as a senior developer giving diagnostics. 
  Your role is to output diagnostics based on the following code. 
  The diagnostics should take into account things that a normal language 
  server can't take into account (IE doing \`in\` on a python list is much slower 
  than doing it on a set, suggesting that two nested for loops might be able to 
  be optimized into one loop if some trick is used, suggesting that Python classes
  shouldn't use getters and setters, or any other thing that a senior developer 
  would know about and a normal language server wouldn't). 
  The diagnostics should be of the format:

type Diagnostic {
  toHighlight: error_string,
  message: string,
  severity: severity_number
  lineStart: number,
  lineEnd: number,
}

where error_string = string where error occurs
and severity_number = number from 1 to 4, inclusive, with 1 being heighest severity and 4 being lowest

Please note that the error_string will be regex matched exactly,
so the error string in diagnostic must exactly match the string
where the error is occuring in the original text. For example, if 
the error spans multiple lines, the newLine escape character must be used.

Code:
\`\`\`
${processedText}
\`\`\`
`;

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: prompt,
    config: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            toHighlight: { type: Type.STRING },
            message: { type: Type.STRING },
            severity: { type: Type.NUMBER },
            lineStart: { type: Type.NUMBER },
            lineEnd: { type: Type.NUMBER },
          },
          required: ["toHighlight", "message", "severity", "lineStart", "lineEnd"],
        },
      },
    },
  });
  const diagnosticsText = response.text;
  console.log("diagnosticsText", diagnosticsText);
  const preDiagnostics: { toHighlight: string; message: string; severity: number, lineStart: number, lineEnd: number }[] =
    JSON.parse(diagnosticsText);

  const diagnostics = createDiagnostics(doc, preDiagnostics);
  console.log("diagnostics", diagnostics);

  AIPoweredDiagnostics.set(doc.uri, diagnostics);
}

export async function deactivate(): Promise<void> {
  // if (!client) {
  // 	return undefined;
  // }
  // return client.stop();
  return undefined;
}

const SEVERITIES = {
  1: vscode.DiagnosticSeverity.Error,
  2: vscode.DiagnosticSeverity.Warning,
  3: vscode.DiagnosticSeverity.Information,
  4: vscode.DiagnosticSeverity.Hint,
}

function createDiagnostics(document: vscode.TextDocument, preDiagnostics): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  for (const d of preDiagnostics) {
    
    const startPosition = new vscode.Position(d.lineStart, 0);
    const endLine = Math.min(d.lineEnd, document.lineCount - 1);
    const endPosition = document.lineAt(endLine).range.end;

    const scopedText = document.getText(new vscode.Range(startPosition, endPosition));

    // regex search inside the scoped text
    const regex = new RegExp(d.toHighlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'); // escape regex
    const match = regex.exec(scopedText);

    if (match && match.index !== undefined) {
      const startOffset = match.index;
      const endOffset = startOffset + match[0].length;

      const absoluteStartOffset = document.offsetAt(startPosition) + startOffset;
      const absoluteEndOffset = document.offsetAt(startPosition) + endOffset;

      const absoluteStartPos = document.positionAt(absoluteStartOffset);
      const absoluteEndPos = document.positionAt(absoluteEndOffset);

      const range = new vscode.Range(absoluteStartPos, absoluteEndPos);

      diagnostics.push(new vscode.Diagnostic(
        range,
        d.message,
        SEVERITIES[d.severity]
      ));
    } else {
      console.warn(`Could not find match for: ${d.toHighlight} between lines ${d.lineStart} and ${d.lineEnd}`);
    }
  }

  return diagnostics;
}

function positionAt(text: string, offset: number): vscode.Position {
  const lines = text.slice(0, offset).split('\n');
  const line = lines.length - 1;
  const character = lines[lines.length - 1].length;
  return new vscode.Position(line, character);
}