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
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient";

function LOGHERE(...args) {
  console.log("[LAHACKS]", ...args);
}

// ==============================
//  Globals
// ==============================
const documentAttachments = new Map<Uri, TextDocumentAttachments>();
const virtualDocumentContents = new Map<string, string>();
let theClient: LanguageClient;
const converter = new showdown.Converter();
let lastFixContext: string;
let fixes: CodeAction[];
let ai: GoogleGenAI;
let quickfixProvider: DiagnosticAggregatorViewProvider;
let AIPoweredDiagnostics: vscode.DiagnosticCollection;

// ==============================
//  Language server code
// ==============================
interface TextDocumentAttachments {
  injections?: Region[];
  lang2vdoc?: Record<string, Uri>;
}

function canonUri(uri: Uri): string {
  const preStrip = uri.path.slice(1);
  const postStrip = preStrip.slice(0, preStrip.lastIndexOf("."));
  return decodeURIComponent(postStrip);
}

interface Region {
  language: string;
  start: number;
  end: number;
}

function filterDocContent(doc: string, regions: Iterable<Region>): string {
  let content = doc.replace(/[^\n]/g, " ");
  for (const r of regions) {
    content =
      content.slice(0, r.start) +
      doc.slice(r.start, r.end) +
      content.slice(r.end);
  }
  return content;
}

function parseInjections(doc: string): Region[] {
  const rx = /@LANGUAGE:([^@]*)@/g;
  let match: RegExpExecArray;
  const regions: Region[] = [];
  while ((match = rx.exec(doc)) !== null) {
    const sbegRx = /R"""\(/g;
    sbegRx.lastIndex = match.index;
    const sbeg = sbegRx.exec(doc);
    if (!sbeg) {
      return regions;
    }

    const sendRx = /\)"""/g;
    sendRx.lastIndex = sbeg.index;
    const send = sendRx.exec(doc);
    if (!send) {
      return regions;
    }

    regions.push({
      language: match[1],
      start: sbeg.index + sbeg[0].length,
      end: send.index,
    });
    // Look for injection annotation after this snippet
    rx.lastIndex = send.index;
  }
  return regions;
}

function getAttachments(
  uri: Uri,
  doc: string,
  recompute: boolean
): TextDocumentAttachments {
  let res = documentAttachments.get(uri);
  if (res && !recompute) {
    return res;
  }
  res = {};
  documentAttachments.set(uri, res);
  res.injections = parseInjections(doc);
  return res;
}

function getInjectionAtPosition(
  regions: Region[],
  offset: number
): Region | null {
  for (const region of regions) {
    if (region.start <= offset) {
      if (offset <= region.end) {
        return region;
      }
    } else {
      break;
    }
  }
  return null;
}

// ==============================
// Extension code
// ==============================
export function activate(context: ExtensionContext) {
  testParseInjections();

  // ========== Language server ==========
  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  const serverOptions: ServerOptions = {
    command: "clangd",
  };
  workspace.registerTextDocumentContentProvider("embedded-content", {
    provideTextDocumentContent: (uri) => {
      return virtualDocumentContents.get(canonUri(uri));
    },
  });

  workspace.onDidOpenTextDocument((document) => {
    LOGHERE("opened document");
    const doc = document.getText();
    const att = getAttachments(document.uri, doc, true);

    att.lang2vdoc = {};
    const originalUri = encodeURIComponent(document.uri.toString(true));
    for (const injection of att.injections) {
      const vdocUriString = `embedded-content://${injection.language}/${originalUri}.${injection.language}`;
      const vdocUri = Uri.parse(vdocUriString);
      att.lang2vdoc[injection.language] = vdocUri;
    }
    for (const [language, vdocUri] of Object.entries(att.lang2vdoc)) {
      virtualDocumentContents.set(
        canonUri(vdocUri),
        filterDocContent(
          doc,
          att.injections.filter((x) => x.language === language)
        )
      );
    }
  });
  workspace.onDidChangeTextDocument((e) => {
    const document = e.document;
    const doc = document.getText();
    const att = getAttachments(document.uri, doc, true);

    att.lang2vdoc = {};
    const originalUri = encodeURIComponent(document.uri.toString(true));
    for (const injection of att.injections) {
      const vdocUriString = `embedded-content://${injection.language}/${originalUri}.${injection.language}`;
      const vdocUri = Uri.parse(vdocUriString);
      att.lang2vdoc[injection.language] = vdocUri;
    }
    for (const [language, vdocUri] of Object.entries(att.lang2vdoc)) {
      virtualDocumentContents.set(
        canonUri(vdocUri),
        filterDocContent(
          doc,
          att.injections.filter((x) => x.language === language)
        )
      );
    }
    // TODO(rtk0c): optimized incremental reparse
    // for (const ch of e.contentChanges) {
    //   const st = e.document.offsetAt(ch.range.start);
    //   const ed = e.document.offsetAt(ch.range.end);
    // }
  });

  workspace.onDidCloseTextDocument((e) => {
    documentAttachments.delete(e.uri);
    virtualDocumentContents.delete(canonUri(e.uri));
  });
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "cpp" }],
    middleware: {
      provideCompletionItem: async (
        document,
        position,
        context,
        token,
        next
      ) => {
        const doc = document.getText();

        const attachments = getAttachments(document.uri, doc, false);
        const injection = getInjectionAtPosition(
          attachments.injections,
          document.offsetAt(position)
        );

        // If not in an injection fragment, forward the request to primary LS directly
        if (!injection) {
          return await next(document, position, context, token);
        }

        // Otherwise, forward to minion LS
        return await commands.executeCommand<vscode.CompletionList>(
          "vscode.executeCompletionItemProvider",
          attachments.lang2vdoc[injection.language],
          position,
          context.triggerCharacter
        );
      },
    },
  };

  // Create the language client and start the client.
  theClient = new LanguageClient(
    "lahacksDemo",
    "C++ (Fancy)",
    serverOptions,
    clientOptions
  );

  // Start the client. This will also launch the server
  theClient.start();

  // ========== AI Linting ==========
  // FIXME(rtk0c): don't read env var in prod, here in dev it's easier than changing a json config file in the slave vscode
  const geminiApiKey: string =
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
  languages.onDidChangeDiagnostics((_) => {
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

  const prompt = `You are acting as a senior developer giving diagnostics. Your role is to output diagnostics based on the following code. The diagnostics should take into account things that a normal language server can't take into account (IE doing \`in\` on a python list is much slower than doing it on a set, suggesting that two nested for loops might be able to be optimized into one loop if some trick is used, suggesting that Python classes shouldn't use getters and setters, or any other thing that a senior developer would know about and a normal language server wouldn't). The diagnostics should be of the format:
type Position {
  line: number,
  character: number
}
type Range {
  start: Position,
  end: Position,
}
type Diagnostic {
  range: Range,
  message: string,
}

Please note that the line numbers and column numbers are zero indexed, and that the code has been formatted to make it easy to read. Each line is in the format {line}|{lineText}

Code:
\`\`\`
${processedText}
\`\`\`
`;

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            range: {
              type: Type.OBJECT,
              properties: {
                start: {
                  type: Type.OBJECT,
                  properties: {
                    line: { type: Type.NUMBER },
                    character: { type: Type.NUMBER },
                  },
                  required: ["line", "character"],
                },
                end: {
                  type: Type.OBJECT,
                  properties: {
                    line: { type: Type.NUMBER },
                    character: { type: Type.NUMBER },
                  },
                  required: ["line", "character"],
                },
              },
              required: ["start", "end"],
            },
            message: { type: Type.STRING },
          },
          required: ["range", "message"],
        },
      },
    },
  });
  const diagnosticsText = response.text;
  console.log("diagnosticsText", diagnosticsText);
  const preDiagnostics: { range: Range; message: string }[] =
    JSON.parse(diagnosticsText);

  const diagnostics: Diagnostic[] = preDiagnostics.map((d) => {
    return {
      range: d.range,
      message: d.message,
      severity: vscode.DiagnosticSeverity.Warning,
    };
  });
  console.log("diagnostics", diagnostics);

  AIPoweredDiagnostics.set(doc.uri, diagnostics);
}

export async function deactivate(): Promise<void> {
  if (!theClient) {
    return undefined;
  }
  return theClient.stop();
}

function testParseInjections() {
  const i = '// @LANGUAGE: sql@\nauto s = R"""(some code here)"""';
  const pp = parseInjections(i);
  const sec = i.substring(pp[0].start, pp[0].end);
  return sec;
}
