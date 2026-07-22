import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror, { type Extension } from "@uiw/react-codemirror";

export default function CodeEditor({
  path,
  value,
  onChange
}: {
  path: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme={oneDark}
      extensions={languageFor(path)}
      height="100%"
      style={{ height: "100%" }}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: true,
        autocompletion: false
      }}
    />
  );
}

function languageFor(path: string): Extension[] {
  const name = path.toLowerCase();
  const ext = name.slice(name.lastIndexOf(".") + 1);
  if (ext === "md" || ext === "markdown") return [markdown()];
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return [javascript({ jsx: true })];
  if (["ts", "tsx", "mts", "cts"].includes(ext)) return [javascript({ jsx: true, typescript: true })];
  if (ext === "json") return [javascript()];
  if (ext === "py") return [python()];
  if (["sh", "bash", "zsh"].includes(ext) || name.endsWith("justfile") || name.endsWith("makefile")) {
    return [StreamLanguage.define(shell)];
  }
  return [];
}
