import { Bot, Braces, CircleAlert, Clock3, Server, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { UiEvent } from "../src/types.js";

const EVENT_LABELS: Record<string, string> = {
  agent: "Agent",
  model: "Model",
  tool: "Agent",
  runtime: "Runtime",
  preview: "Preview",
  compaction: "Context",
  error: "Error",
  cancel: "Agent"
};

function eventIcon(event: UiEvent) {
  if (event.isError || event.type === "error") return <CircleAlert size={15} />;
  if (event.type === "model") return <Bot size={15} />;
  if (event.type === "tool") return <Braces size={15} />;
  if (event.type === "runtime") return <Server size={15} />;
  return <Sparkles size={15} />;
}

function prettyDetail(detail: string): string {
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
}

export function TimelinePane({ events, isRunning }: { events: UiEvent[]; isRunning: boolean }) {
  const timeline = useMemo(
    () => events.filter((event) => !(event.type === "tool" && event.title.endsWith(" update"))).reverse(),
    [events]
  );
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [timeline.length]);

  return (
    <section className="timeline-pane">
      <header className="inspector-heading">
        <div>
          <span className="pane-kicker">The agent loop</span>
          <h2>What happens in the background</h2>
        </div>
        <span className="inspector-count">{timeline.length}</span>
      </header>
      <p className="inspector-note">The model requests tools. Agent Mom runs them and returns each result.</p>
      {timeline.length === 0 ? (
        <div className="timeline-empty"><Clock3 size={22} /><span>Activity will appear here.</span></div>
      ) : (
        <ol className="event-timeline">
          {timeline.map((event) => (
            <li className={event.isError ? "event-row error" : "event-row"} key={event.id}>
              <span className={`event-icon ${event.type}`}>{eventIcon(event)}</span>
              <article>
                <header>
                  <span>{EVENT_LABELS[event.type] ?? event.type}</span>
                  <time>{new Date(event.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</time>
                </header>
                <strong>{event.title}</strong>
                {event.detail && (
                  <details>
                    <summary>View details</summary>
                    <pre><code>{prettyDetail(event.detail)}</code></pre>
                  </details>
                )}
              </article>
            </li>
          ))}
          {isRunning && (
            <li className="event-row live">
              <span className="event-icon agent"><Sparkles size={15} /></span>
              <article><strong>Working…</strong></article>
            </li>
          )}
        </ol>
      )}
      <div ref={endRef} />
    </section>
  );
}
