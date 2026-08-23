import { Braces, Cloud, Globe2, Server } from "lucide-react";
import { useEffect, useState } from "react";
import type { ToolSummary } from "../src/types.js";

const EXECUTOR_LABELS = {
  fly: "Fly sandbox",
  host: "Agent Mom server",
  external: "External service"
} as const;

export function ToolsPane({ tools }: { tools: ToolSummary[] }) {
  const [selectedName, setSelectedName] = useState<string | undefined>(tools[0]?.name);
  const selected = tools.find((tool) => tool.name === selectedName) ?? tools[0];

  useEffect(() => {
    if (!selected || !tools.some((tool) => tool.name === selectedName)) setSelectedName(tools[0]?.name);
  }, [selected, selectedName, tools]);

  if (!tools.length) {
    return <div className="preview-empty"><Braces size={22} /><span>No tools enabled.</span></div>;
  }

  return (
    <section className="tools-pane">
      <header className="inspector-heading">
        <div>
          <span className="pane-kicker">What the model sees</span>
          <h2>Tools in this chat</h2>
        </div>
        <span className="inspector-count">{tools.length}</span>
      </header>
      <p className="inspector-note">Each contract tells the model what it can request. Agent Mom runs the chosen tool.</p>
      <div className="tools-pane-body">
        <nav className="tool-list" aria-label="Enabled tools">
          {tools.map((tool) => (
            <button
              type="button"
              className={tool.name === selected?.name ? "tool-row active" : "tool-row"}
              key={tool.name}
              onClick={() => setSelectedName(tool.name)}
            >
              <Braces size={15} />
              <span><strong>{tool.name}</strong><small>{tool.label}</small></span>
            </button>
          ))}
        </nav>
        {selected && (
          <article className="tool-contract">
            <header>
              <div><span className="pane-kicker">Tool contract</span><h3>{selected.name}</h3></div>
              <span className="tool-executor">
                {selected.executor === "fly" ? <Cloud size={13} /> : selected.executor === "external" ? <Globe2 size={13} /> : <Server size={13} />}
                {EXECUTOR_LABELS[selected.executor]}
              </span>
            </header>
            <p>{selected.description}</p>
            <section>
              <span className="pane-kicker">Argument schema</span>
              <pre><code>{JSON.stringify(selected.parameters, null, 2)}</code></pre>
            </section>
          </article>
        )}
      </div>
    </section>
  );
}
