// import { getLanguageService } from 'vscode-html-languageservice';
import {
  CompletionItem,
  createConnection,
  InitializeParams,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  TextEdit,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager. The text document manager
// supports full document sync only
const documents = new TextDocuments(TextDocument);

// const htmlLanguageService = getLanguageService();

connection.onInitialize((_params: InitializeParams) => {
  const allCharacters: string[] = [];
  for (let i = 0; i < 256; i++) {
    if (String.fromCharCode(i) === "\n" || String.fromCharCode(i) === "\t") {
      continue;
    }
    allCharacters.push(String.fromCharCode(i));
  }
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full,
      // Tell the client that the server supports code completion
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: allCharacters,
      },
    },
  };
});

connection.onCompletion(async (params, _token) => {
  console.log("onCompletion called");
  const item = CompletionItem.create("hi");
  item.textEdit = TextEdit.insert(params.position, "hi");
  return [item];
});

documents.listen(connection);
connection.listen();
