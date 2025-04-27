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
import * as showdown from "showdown";
import { JSONRPCEndpoint } from "ts-lsp-client";
import { InitializeParams } from "vscode-languageclient";
import {
  canonOrigUri,
  Fragment,
  FragmentsFS,
  FS_SCHEME,
  LangId,
  orig2vdoc,
  vdoc2orig,
} from "./injectedDocs";

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
const converter = new showdown.Converter();
let lastFixContext: string;
let fixes: CodeAction[];
let ai: GoogleGenAI;
let quickfixProvider: DiagnosticAggregatorViewProvider;
let AIPoweredDiagnostics: vscode.DiagnosticCollection;
let pyrightEndpoint: JSONRPCEndpoint;
let clangdEndpoint: JSONRPCEndpoint;
let mutex = new Mutex();
let fs: FragmentsFS;

// ==============================
//  Language server code
// ==============================

function getInjectionAtPosition(
  regions: Fragment[],
  offset: number
): [Fragment, number] | null {
  let idx = 0;
  for (const region of regions) {
    if (region.start <= offset) {
      if (offset <= region.end) {
        return [region, idx];
      }
    } else {
      break;
    }
    idx++;
  }
  return null;
}

class InjectionCodeLensProvider implements CodeLensProvider {
  onDidChangeCodeLenses?: vscode.Event<void>;

  provideCodeLenses(
    document: TextDocument,
    token: CancellationToken
  ): vscode.ProviderResult<vscode.CodeLens[]> {
    const att = fs.files.get(canonOrigUri(document.uri));
    const codeLenses = [];
    Array.from(att.fragments.values()).forEach((fragment, i) => {
      const range = new Range(
        document.positionAt(fragment.start),
        document.positionAt(fragment.end)
      );
      codeLenses.push(
        new CodeLens(range, {
          title: "New Tab",
          tooltip: "Open injected fragment in a new buffer",
          command: "lahacks2025.openFragment",
          arguments: [orig2vdoc(document.uri, i, fragment.langFileExt)],
        })
      );
    });
    return codeLenses;
  }
}

function translate(
  doc: TextDocument,
  vdoc: string,
  range: Range,
  origin: number
): Range {
  const pos = range.start;
  let l = 0,
    c = 0;
  let off = 0;
  for (; l !== pos.line || c !== pos.character; off++) {
    if (vdoc[off] === "\n") {
      l++;
      c = 0;
    } else {
      c++;
    }
  }

  const { line, character } = doc.positionAt(origin + off);
  return new Range(
    line,
    character,
    line,
    character + range.end.character - range.start.character
  );
}

function translateCompletionResults(
  doc: TextDocument,
  vdoc: string,
  res: vscode.CompletionList,
  off: number
): vscode.CompletionList {
  console.log(res);
  for (const item of res.items) {
    // certain LSPs still use this
    if (item.textEdit) {
      item.textEdit.range = translate(doc, vdoc, item.textEdit.range, off);
    }
    // primary API
    const r = item.range;
    if (!r) {
      continue;
    }
    if (r instanceof Range) {
      item.range = translate(doc, vdoc, r, off);
    } else {
      // {inserting, replacing} struct
      item.range = {
        inserting: translate(doc, vdoc, r.inserting, off),
        replacing: translate(doc, vdoc, r.replacing, off),
      };
    }
  }
  console.log(res);
  return res;
}

class InjectionCodeCompleteProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ) {
    const att = fs.files.get(canonOrigUri(document.uri));
    const [fragment, idx] = getInjectionAtPosition(
      att.fragments,
      document.offsetAt(position)
    );

    console.log(idx, fragment.langFileExt);

    // shift backwards to the start of the virtual document
    console.log("pre pos: ", position);
    const fragmentText = document.getText(
      new Range(
        document.positionAt(fragment.start),
        document.positionAt(fragment.end)
      )
    );
    const p = document.offsetAt(position) - fragment.start;
    // Go p characters forward from fragmentText, calc line&column
    let line = 0;
    let column = 0;
    for (let i = 0; i < p; i++) {
      if (fragmentText[i] === "\n") {
        line++;
        column = 0;
      } else {
        column++;
      }
    }
    position = new vscode.Position(line, column);

    console.log("post pos: ", position);

    // If not in an injection fragment, forward the request to primary LS directly
    if (
      fragment &&
      (fragment.langFileExt === "py" || fragment.langFileExt === "cpp")
    ) {
      let endpoint: JSONRPCEndpoint;
      let languageId: LangId;
      if (fragment.langFileExt === "py") {
        endpoint = pyrightEndpoint;
        languageId = "python";
      } else if (fragment.langFileExt === "cpp") {
        endpoint = clangdEndpoint;
        languageId = "cpp";
      }

      // call language server
      const fragmentName = orig2vdoc(document.uri, idx, fragment.langFileExt);
      const docName = `file://${vdoc2orig(fragmentName)}${idx}.${
        fragment.langFileExt
      }`;
      const muxResult = await mutex.runExclusive(async () => {
        if (!documentInitialized.get(fragmentName.toString())) {
          console.log("Sending textDocument/didOpen");
          documentInitialized.set(fragmentName.toString(), true);
          lastDocumentVersion.set(fragmentName.toString(), 0);
          endpoint.notify("textDocument/didOpen", {
            textDocument: {
              uri: docName,
              languageId: languageId,
              version: document.version,
              text: fragmentText,
            },
          });
        } else {
          console.log(
            "Sending didChange with version",
            lastDocumentVersion.get(fragmentName.toString())
          );
          endpoint.notify("textDocument/didChange", {
            textDocument: {
              uri: docName,
              version: lastDocumentVersion.get(fragmentName.toString()),
            },
            contentChanges: [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: {
                    line:
                      lastDocumentLength.get(fragmentName.toString()).line - 1,
                    character: lastDocumentLength.get(fragmentName.toString())
                      .character,
                  },
                },
                text: fragmentText,
              },
            ],
          });
          lastDocumentVersion.set(
            fragmentName.toString(),
            lastDocumentVersion.get(fragmentName.toString()) + 1
          );
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const lines = fragmentText.split("\n");
        lastDocumentLength.set(fragmentName.toString(), {
          line: lines.length,
          character: lines[lines.length - 1].length,
        });
        console.log("Sent textDocument/didOpen and didChange");
        console.log("Trying to get language server response");
        const completionResult: { items: vscode.CompletionItem[] } =
          await endpoint.send("textDocument/completion", {
            textDocument: {
              uri: docName,
            },
            position: position,
            context: context,
          });
        console.log("Language server completion result", completionResult);
        return completionResult;
      });

      if (muxResult) {
        return translateCompletionResults(
          document,
          fragmentText,
          muxResult,
          fragment.start
        );
      }
    }

    // Otherwise, forward to minion LS
    const res = await commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      orig2vdoc(document.uri, idx, fragment.langFileExt),
      position,
      context.triggerCharacter
    );
    return translateCompletionResults(
      document,
      fragmentText,
      res,
      fragment.start
    );
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
    "/usr/bin/clangd",
    //"/home/eliot/Documents/GitHub/lahacks2025/clangd.sh",
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
  fs = new FragmentsFS();
  context.subscriptions.push(
    workspace.registerFileSystemProvider(FS_SCHEME, fs, {
      isCaseSensitive: true,
    })
  );

  workspace.onDidOpenTextDocument((document) => fs.updateDocument(document));
  workspace.onDidChangeTextDocument((e) =>
    fs.updateDocument(e.document, e.contentChanges)
  );

  workspace.onDidCloseTextDocument((e) => {
    fs.removeDocument(e.uri);
  });

  // TODO(rtk0c): this is a pretty good default for most languages, but e.g. haskell or lisp won't like this
  const triggerCharacters = charsBetween("a", "z")
    .concat(charsBetween("A", "Z"))
    .concat(["."]);
  context.subscriptions.push(
    languages.registerCompletionItemProvider(
      "*",
      new InjectionCodeCompleteProvider(),
      ...triggerCharacters
    )
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
      if (e.uri.scheme != FS_SCHEME) {
        await makeAIPoweredDiagnostics(e);
      }
    })
  );

  // handle documents already open when extension activates
  const activeDocument = window.activeTextEditor?.document;
  if (activeDocument) {
    makeAIPoweredDiagnostics(activeDocument);
  }
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
