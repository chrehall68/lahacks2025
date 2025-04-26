import { GoogleGenAI, Type } from "@google/genai";
import * as vscode from "vscode";
import {
  CancellationToken,
  CodeAction,
  CodeActionContext,
  CodeActionKind,
  CodeActionProvider,
  CodeLens,
  CodeLensProvider,
  commands,
  Diagnostic,
  ExtensionContext,
  languages,
  Range,
  TextDocument,
  Uri,
  window,
  workspace,
} from "vscode";

import { Mutex } from "async-mutex";
import { spawn } from "child_process";
import * as path from "path";
import * as showdown from "showdown";
import { JSONRPCEndpoint } from "ts-lsp-client";
import {
  InitializeParams,
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient";

function LOGHERE(...args) {
  console.log("[LAHACKS]", ...args);
}

// ==============================
//  Globals
// ==============================
const documentInitialized = new Map<string, boolean>();
const lastDocumentVersion = new Map<string, number>();
const lastDocumentLength = new Map<
  string,
  { line: number; character: number }
>();
const documentAttachments = new Map<Uri, TextDocumentAttachments>();
const virtualDocumentContents = new Map<string, string>();
const documentToVirtual = new Map<string, string[]>();
const converter = new showdown.Converter();
let lastFixContext: string;
let fixes: CodeAction[];
let ai: GoogleGenAI;
let quickfixProvider: DiagnosticAggregatorViewProvider;
let AIPoweredDiagnostics: vscode.DiagnosticCollection;
let pyrightEndpoint: JSONRPCEndpoint;
let clangdEndpoint: JSONRPCEndpoint;
let mutex = new Mutex();

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

function withExtensionUri(uri: Uri): string {
  const preStrip = uri.path.slice(1);
  return decodeURIComponent(preStrip);
}

// js, py, cpp, etc.
// The thing that is put into @LANGUAGE:__@ and into vdoc Uri
type LangFileExtension = string;
// javascript, python, cpp, etc.
// The thing extensions & syntaxes registers to provide
type LangId = string;

interface Region {
  langFileExt: LangFileExtension;
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

interface FragmentDelims {
  sbeg: RegExp;
  send: RegExp;
}

// HERE BE DRAGON: RegExp.lastIndex is the only state of the matching machinery, and since this is single-threaded, we don't care about sharing RegExp objects
const fragdelimsFor: Record<LangId, FragmentDelims> = {
  cpp: { sbeg: /R"""\(/g, send: /\)"""/g },
  python: { sbeg: /"""/g, send: /"""/g },
  // HERE BE DRAGON: just ignore escaped \` for this demo...
  javascript: { sbeg: /`/g, send: /`/g },
  typescript: { sbeg: /`/g, send: /`/g },
};

// TODO support only parse for begin delimiter on the next line, to prevent misuses
function parseInjections(doc: string, rx: FragmentDelims): Region[] {
  const rxInjectionTag = /@LANGUAGE:([^@]*)@/g;
  let match: RegExpExecArray;
  const regions: Region[] = [];
  while ((match = rxInjectionTag.exec(doc)) !== null) {
    rx.sbeg.lastIndex = match.index + match[0].length;
    const sbeg = rx.sbeg.exec(doc);
    if (!sbeg) {
      break;
    }

    rx.send.lastIndex = sbeg.index + sbeg[0].length;
    const send = rx.send.exec(doc);
    if (!send) {
      break;
    }

    regions.push({
      langFileExt: match[1],
      start: sbeg.index + sbeg[0].length,
      end: send.index,
    });
    // Look for injection annotation after this snippet
    rxInjectionTag.lastIndex = send.index;
  }
  return regions;
}

function parseMarkdownInjections(doc: string): Region[] {
  const rxInjectionBeg = /```([^\n]+)\n/g;
  let match: RegExpExecArray;
  const regions: Region[] = [];
  while ((match = rxInjectionBeg.exec(doc)) !== null) {
    // FIXME(rtk0c): markdown probably has a way to escape ``` inside a codeblock
    const rxInjectionEnd = /```/g;
    rxInjectionEnd.lastIndex = match.index + match[0].length;
    const end = rxInjectionEnd.exec(doc);
    if (!end) {
      break;
    }

    regions.push({
      langFileExt: match[1],
      start: match.index + match[0].length,
      end: end.index,
    });
  }
  return regions;
}

function getAttachments(uri: Uri): TextDocumentAttachments {
  let res = documentAttachments.get(uri);
  if (res) {
    return res;
  }
  res = {};
  documentAttachments.set(uri, res);
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

class InjectionCodeLensProvider implements CodeLensProvider {
  onDidChangeCodeLenses?: vscode.Event<void>;

  provideCodeLenses(
    document: TextDocument,
    token: CancellationToken
  ): vscode.ProviderResult<vscode.CodeLens[]> {
    const att = getAttachments(document.uri);
    const codeLenses = [];
    for (const injection of att.injections) {
      const range = new Range(
        document.positionAt(injection.start),
        document.positionAt(injection.end)
      );
      codeLenses.push(
        new CodeLens(range, {
          title: "New Tab",
          tooltip: "Open injected fragment in a new buffer",
          command: "lahacks2025.openFragment",
          arguments: [att.lang2vdoc[injection.langFileExt]],
        })
      );
    }
    return codeLenses;
  }
}

class InjectionCodeCompleteProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext,
  ) {
    const attachments = getAttachments(document.uri);
    const injection = getInjectionAtPosition(
      attachments.injections,
      document.offsetAt(position)
    );

    // If not in an injection fragment, forward the request to primary LS directly
    if (!injection) {
      if (document.uri.scheme === "embedded-content") {
        let endpoint: JSONRPCEndpoint;
        let extension: string;
        if (document.languageId === "python") {
          endpoint = pyrightEndpoint;
          extension = "py";
        } else if (document.languageId === "cpp") {
          endpoint = clangdEndpoint;
          extension = "cpp";
        } else {
          return null;
        }

        // call language server
        const doc = document.getText();
        const muxResult = await mutex.runExclusive(async () => {
          if (!documentInitialized.get(document.uri.toString())) {
            console.log("Sending textDocument/didOpen");
            documentInitialized.set(document.uri.toString(), true);
            lastDocumentVersion.set(document.uri.toString(), 0);
            endpoint.notify("textDocument/didOpen", {
              textDocument: {
                uri: canonUri(document.uri) + "." + extension,
                languageId: document.languageId,
                version: document.version,
                text: doc,
              },
            });
          } else {
            console.log(
              "Sending didChange with version",
              lastDocumentVersion.get(document.uri.toString())
            );
            endpoint.notify("textDocument/didChange", {
              textDocument: {
                uri: canonUri(document.uri) + "." + extension,
                version: lastDocumentVersion.get(document.uri.toString()),
              },
              contentChanges: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: {
                      line:
                        lastDocumentLength.get(document.uri.toString())
                          .line - 1,
                      character: lastDocumentLength.get(
                        document.uri.toString()
                      ).character,
                    },
                  },
                  text: doc,
                },
              ],
            });
            lastDocumentVersion.set(
              document.uri.toString(),
              lastDocumentVersion.get(document.uri.toString()) + 1
            );
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          const lines = doc.split("\n");
          lastDocumentLength.set(document.uri.toString(), {
            line: lines.length,
            character: lines[lines.length - 1].length,
          });
          console.log("Sent textDocument/didOpen and didChange");
          console.log("Trying to get language server response");
          const completionResult: { items: vscode.CompletionItem[] } =
            await endpoint.send("textDocument/completion", {
              textDocument: {
                uri: canonUri(document.uri) + "." + extension,
              },
              position: position,
              context: context,
            });
          console.log(
            "Language server completion result",
            completionResult
          );
          return completionResult;
        });

        if (muxResult) {
          const results: vscode.CompletionItem[] = [];
          for (const item of muxResult.items) {
            const it = new vscode.CompletionItem(item.label);
            it.kind = item.kind;
            it.sortText = item.sortText;
            results.push(it);
          }
          return results;
        }
      }

      return null;
    }

    // const d = await workspace.openTextDocument(
    //   attachments.lang2v c[injection.language]
    // );
    // await window.showTextDocument(d, { preview: false });

    // Otherwise, forward to minion LS
    const otherDoc = await workspace.openTextDocument(
      attachments.lang2vdoc[injection.language]
    );
    const res = await commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      attachments.lang2vdoc[injection.langFileExt],
      position,
      context.triggerCharacter
    );
    return res;
  }
}

function charsBetween(a: string, b: string): string[] {
  const res = [];
  for (let n = a.charCodeAt(0); n <= b.charCodeAt(0); ++n) {
    res.push(String.fromCharCode(n));
  }
  return res;
}

// ==============================
// Extension code
// ==============================
function initPyright() {
  const serverProcess = spawn(
    "/home/eliot/.local/share/nvim/mason/bin/pyright-langserver",
    //"/home/eliot/Documents/GitHub/lahacks2025/pyright.sh",
    ["--stdio"]
  );
  console.log("starting pyright");
  pyrightEndpoint = new JSONRPCEndpoint(
    serverProcess.stdin!,
    serverProcess.stdout!
  );

  pyrightEndpoint.notify("initialized");

  console.log("finished starting pyright");
}

function initClangd() {
  const serverProcess = spawn(
    //"/home/eliot/Documents/GitHub/lahacks2025/clangd.sh",
    "/usr/bin/clangd",
    ["--limit-results=20"]
  );
  console.log("starting clangd");
  clangdEndpoint = new JSONRPCEndpoint(
    serverProcess.stdin!,
    serverProcess.stdout!,
    {
      captureRejections: true,
      autoDestroy: true,
    }
  );
  clangdEndpoint.send("initialize", {
    processId: process.pid,
    capabilities: {
      textDocument: {
        completion: {
          completionItem: {
            snippetSupport: false,
          },
          contextSupport: false,
        },
      },
    },
  } as InitializeParams);
  clangdEndpoint.on("textDocument/publishDiagnostics", (params) => {
    LOGHERE("textDocument/publishDiagnostics", params);
  });

  clangdEndpoint.notify("initialized");

  console.log("finished starting clangd");
}

export function activate(context: ExtensionContext) {
  initPyright();
  initClangd();
  // ========== Language server ==========
  const contentProvider = new (class
    implements vscode.TextDocumentContentProvider {
    onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
    onDidChange = this.onDidChangeEmitter.event;

    provideTextDocumentContent(uri) {
      return virtualDocumentContents.get(withExtensionUri(uri));
    }
  })();
  workspace.registerTextDocumentContentProvider(
    "embedded-content",
    contentProvider
  );

  const refreshDocument = (document: TextDocument) => {
    const doc = document.getText();
    const att = getAttachments(document.uri);

    if (document.languageId == "markdown") {
      att.injections = parseMarkdownInjections(doc);
    } else {
      att.injections = parseInjections(doc, fragdelimsFor[document.languageId]);
    }

    att.lang2vdoc = {};
    const originalUri = encodeURIComponent(document.uri.toString(true));
    for (const injection of att.injections) {
      const vdocUriString = `embedded-content://${injection.langFileExt}/${originalUri}.${injection.langFileExt}`;
      const vdocUri = Uri.parse(vdocUriString);
      att.lang2vdoc[injection.langFileExt] = vdocUri;
    }

    // clear out anything existing
    for (const prevVirtual of documentToVirtual.get(document.uri.toString()) ||
      []) {
      virtualDocumentContents.delete(prevVirtual);
    }
    // then set new ones
    documentToVirtual.set(document.uri.toString(), []);
    console.log(canonUri(Object.values(att.lang2vdoc)[0]));
    for (const [language, vdocUri] of Object.entries(att.lang2vdoc)) {
      virtualDocumentContents.set(
        withExtensionUri(vdocUri),
        filterDocContent(
          doc,
          att.injections.filter((x) => x.langFileExt === language)
        )
      );
      documentToVirtual
        .get(document.uri.toString())
        ?.push(withExtensionUri(vdocUri));
      contentProvider.onDidChangeEmitter.fire(vdocUri);
    }
  };
  workspace.onDidOpenTextDocument(refreshDocument);
  workspace.onDidChangeTextDocument((e) => refreshDocument(e.document));

  workspace.onDidCloseTextDocument((e) => {
    documentAttachments.delete(e.uri);
    for (const vdocUri of documentToVirtual.get(e.uri.toString())) {
      virtualDocumentContents.delete(vdocUri);
    }
    documentToVirtual.delete(e.uri.toString());
  });
  
  // TODO(rtk0c): this is a pretty good default for most languages, but e.g. haskell or lisp won't like this
  const triggerCharacters = charsBetween('a', 'z')
    .concat(charsBetween('A', 'Z'))
    .concat(["."]);
  context.subscriptions.push(
    languages.registerCompletionItemProvider("*", new InjectionCodeCompleteProvider(), ...triggerCharacters)
  );

  context.subscriptions.push(
    languages.registerCodeLensProvider("*", new InjectionCodeLensProvider())
  );
  context.subscriptions.push(
    commands.registerCommand("lahacks2025.openFragment", async (vdocUri) => {
      const document = await workspace.openTextDocument(vdocUri);
      await window.showTextDocument(document);
    })
  );

  // ========== AI Linting ==========
  // FIXME(rtk0c): don't read env var in prod, here in dev it's easier than changing a json config file in the slave vscode
  const geminiApiKey: string =
    workspace.getConfiguration().get("lahacks2025.geminiApiKey") ||
    process.env["GEMINI_KEY"];
  ai = new GoogleGenAI({ apiKey: geminiApiKey });

  context.subscriptions.push(
    languages.registerCodeActionsProvider("*", new MyCodeActionProvider(), {
      providedCodeActionKinds: MyCodeActionProvider.providedCodeActionKinds,
    })
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
        quickfixProvider.currentWebview?.postMessage({
          command: "showAddChangesButton",
        });
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
  // also listen for saved files and then come up with
  // ai-powered diagnostics for them
  AIPoweredDiagnostics = languages.createDiagnosticCollection("ai-powered");
  context.subscriptions.push(AIPoweredDiagnostics);

  // Listen for saves
  context.subscriptions.push(
    workspace.onDidSaveTextDocument(async (e) => {
      if (e.uri.scheme != "embedded-content") {
        await makeAIPoweredDiagnostics(e);
      }
    })
  );

  // Listen for file opens
  // context.subscriptions.push(
  //   workspace.onDidOpenTextDocument(async (e) => {
  //     if (e.uri.scheme != "embedded-content") {
  //       await makeAIPoweredDiagnostics(e);
  //     }
  //   })
  // );

  // handle documents already open when extension activates
  const activeDocument = window.activeTextEditor?.document;
  if (activeDocument) {
    makeAIPoweredDiagnostics(activeDocument);
  }
}

class DiagnosticAggregatorViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly _extensionUri: vscode.Uri) { }

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
        case "addChanges":
          {
            if (!lastFixContext) {
              vscode.window.showErrorMessage(
                "No file context available for applying changes."
              );
              return;
            }

            const document = await vscode.workspace.openTextDocument(
              vscode.Uri.parse(lastFixContext)
            );
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
            vscode.window.showInformationMessage(
              "File successfully updated with AI suggestions!"
            );
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
    return fixes.filter(
      (fix) =>
        fix.command.arguments[0].uri === document.uri.toString() &&
        fix.diagnostics[0].range.isEqual(range)
    );
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
  be optimized into one loop if some trick is used. Furthermore, Python classes
  shouldn't use getters and setters, or any other thing that a senior developer 
  would know about and a normal language server wouldn't). DO NOT include trivial notes, 
  such as poor naming and the like. Only include notes regarding significant optimization 
  and significant readability improvements.
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
          required: [
            "toHighlight",
            "message",
            "severity",
            "lineStart",
            "lineEnd",
          ],
        },
      },
    },
  });
  const diagnosticsText = response.text;
  console.log("diagnosticsText", diagnosticsText);
  const preDiagnostics: {
    toHighlight: string;
    message: string;
    severity: number;
    lineStart: number;
    lineEnd: number;
  }[] = JSON.parse(diagnosticsText);

  const diagnostics = createDiagnostics(doc, preDiagnostics);
  console.log("diagnostics", diagnostics);

  AIPoweredDiagnostics.set(doc.uri, diagnostics);
}

export async function deactivate(): Promise<void> {
  return null;
}

function testParseInjections() {
  const i = '// @LANGUAGE: sql@\nauto s = R"""(some code here)"""';
  const pp = parseInjections(i, fragdelimsFor["cpp"]);
  const sec = i.substring(pp[0].start, pp[0].end);
  return sec;
}
const SEVERITIES = {
  1: vscode.DiagnosticSeverity.Error,
  2: vscode.DiagnosticSeverity.Warning,
  3: vscode.DiagnosticSeverity.Information,
  4: vscode.DiagnosticSeverity.Hint,
};

function createDiagnostics(
  document: vscode.TextDocument,
  preDiagnostics
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  for (const d of preDiagnostics) {
    const startPosition = new vscode.Position(d.lineStart, 0);
    const endLine = Math.min(d.lineEnd, document.lineCount - 1);
    const endPosition = document.lineAt(endLine).range.end;

    const scopedText = document.getText(
      new vscode.Range(startPosition, endPosition)
    );

    // regex search inside the scoped text
    const regex = new RegExp(
      d.toHighlight.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "g"
    ); // escape regex
    const match = regex.exec(scopedText);

    if (match && match.index !== undefined) {
      const startOffset = match.index;
      const endOffset = startOffset + match[0].length;

      const absoluteStartOffset =
        document.offsetAt(startPosition) + startOffset;
      const absoluteEndOffset = document.offsetAt(startPosition) + endOffset;

      const absoluteStartPos = document.positionAt(absoluteStartOffset);
      const absoluteEndPos = document.positionAt(absoluteEndOffset);

      const range = new vscode.Range(absoluteStartPos, absoluteEndPos);

      diagnostics.push(
        new vscode.Diagnostic(range, d.message, SEVERITIES[d.severity])
      );
    } else {
      console.warn(
        `Could not find match for: ${d.toHighlight} between lines ${d.lineStart} and ${d.lineEnd}`
      );
    }
  }

  return diagnostics;
}

function positionAt(text: string, offset: number): vscode.Position {
  const lines = text.slice(0, offset).split("\n");
  const line = lines.length - 1;
  const character = lines[lines.length - 1].length;
  return new vscode.Position(line, character);
}
