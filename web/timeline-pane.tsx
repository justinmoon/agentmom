import { ArrowDown, ArrowRight, Bot, Check, CircleAlert, Clock3, Cpu } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { UiEvent } from "../src/types.js";
import { buildAgentLoop, prettyDetail, requestSummary, resultSummary } from "./agent-loop.js";

function shortCallId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

export function TimelinePane({ events, isRunning }: { events: UiEvent[]; isRunning: boolean }) {
  const exchanges = useMemo(() => buildAgentLoop(events), [events]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [exchanges.length]);

  return (
    <section className="timeline-pane">
      <header className="inspector-heading">
        <div>
          <span className="pane-kicker">The agent loop</span>
          <h2>Model ↔ Agent Mom</h2>
        </div>
        <span className="inspector-count">{exchanges.length}</span>
      </header>
      <p className="inspector-note">
        Each row is a real tool call: the model sends a structured request, Agent Mom runs it, then sends the result back.
      </p>
      {exchanges.length === 0 ? (
        <div className="timeline-empty">
          <Clock3 size={22} />
          <span>Tool calls will appear here.</span>
        </div>
      ) : (
        <ol className="agent-loop-list">
          {exchanges.map((exchange, index) => (
            <li className={exchange.isError ? "agent-loop-step error" : "agent-loop-step"} key={exchange.id}>
              <header className="agent-loop-step-head">
                <span>Tool call {index + 1}</span>
                <code>{shortCallId(exchange.id)}</code>
              </header>
              <div className="agent-loop-lanes" aria-label={`${exchange.toolName} tool exchange`}>
                <article className="loop-card model-request">
                  <header><Bot size={15} /><span>Model → Agent Mom</span></header>
                  <strong>Requests <code>{exchange.toolName}</code></strong>
                  <p>{requestSummary(exchange)}</p>
                  {exchange.requestDetail && (
                    <details>
                      <summary>View exact request</summary>
                      <pre><code>{prettyDetail(exchange.requestDetail)}</code></pre>
                    </details>
                  )}
                </article>
                <span className="loop-forward" aria-hidden="true"><ArrowRight size={18} /></span>
                <span className="loop-forward-mobile" aria-hidden="true"><ArrowDown size={18} /></span>
                <article className="loop-card agent-execution">
                  <header><Cpu size={15} /><span>Agent Mom</span></header>
                  <strong>{exchange.startedAt ? `Runs ${exchange.toolName}` : "Waiting for Agent Mom"}</strong>
                  {exchange.argumentsDetail && (
                    <details>
                      <summary>View execution input</summary>
                      <pre><code>{prettyDetail(exchange.argumentsDetail)}</code></pre>
                    </details>
                  )}
                </article>
              </div>
              <div className={exchange.isError ? "loop-return error" : "loop-return"}>
                {exchange.isError ? <CircleAlert size={15} /> : <Check size={15} />}
                <div>
                  <strong>{exchange.isError ? "Agent Mom → Model: error" : "Agent Mom → Model: result"}</strong>
                  <p>{resultSummary(exchange)}</p>
                  {exchange.resultDetail && (
                    <details>
                      <summary>View exact result</summary>
                      <pre><code>{prettyDetail(exchange.resultDetail)}</code></pre>
                    </details>
                  )}
                </div>
              </div>
            </li>
          ))}
          {isRunning && exchanges.at(-1)?.finishedAt && (
            <li className="loop-waiting">The model is deciding what to do next…</li>
          )}
        </ol>
      )}
      <div ref={endRef} />
    </section>
  );
}
