import { useState } from "react";
import { ErrorBox, PropertyLink, Section } from "../components/ui.tsx";
import { api, useApi } from "../lib/api.ts";
import { go, href } from "../lib/router.ts";
import { agentPins } from "../lib/store.ts";

type Turn = { role: "user" | "assistant"; content: string; context?: any; answer?: any };

const PROMPTS = [
  "Show me properties within 5 miles of Fort Lauderdale with roofs more than 15 years old.",
  "Which properties near that area have open roofing permits that have been open for a long time? Show the open duration, the contractor and their BBB rating if available.",
];

export function Agent() {
  const health = useApi<any>("/api/health");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [msg, setMsg] = useState(PROMPTS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function ask(e?: React.FormEvent) {
    e?.preventDefault();
    if (!msg.trim()) return;
    setBusy(true);
    setError(null);
    const history = turns.map((t) => ({
      role: t.role,
      content: t.content,
      ...(t.context ? { context: t.context } : {}),
    }));
    const mine: Turn = { role: "user", content: msg };
    setTurns((t) => [...t, mine]);
    try {
      const a = await api<any>("/api/agent", {
        method: "POST",
        body: JSON.stringify({ message: msg, history }),
      });
      setTurns((t) => [...t, { role: "assistant", content: a.text, context: a.context, answer: a }]);
      setMsg(turns.length === 0 ? PROMPTS[1] : "");
    } catch (err) {
      setError(err as Error);
      setTurns((t) => t.filter((x) => x !== mine));
    } finally {
      setBusy(false);
    }
  }

  const unavailable = health.data && health.data.agent !== "available";
  return (
    <>
      <Section title="Ask the Oracle">
        {unavailable && (
          <p className="note">
            The agent is not configured on this server. Set <code>ANTHROPIC_API_KEY</code> in{" "}
            <code>.env</code> (optionally <code>ORACLE_AGENT_MODEL</code>) and restart{" "}
            <code>oracle serve</code>. Everything else on this site works without it.
          </p>
        )}
        <div className="chat">
          {turns.map((t, i) => (
            <div key={i} className={`turn ${t.role}`}>
              {t.role === "user" ? <p>{t.content}</p> : <AnswerView a={t.answer} />}
            </div>
          ))}
        </div>
        <form onSubmit={ask} className="inline">
          <textarea
            className="grow"
            rows={2}
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            aria-label="Question"
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && ask(e)}
          />
          <button type="submit" disabled={busy || !!unavailable}>
            {busy ? "Thinking…" : "Ask"}
          </button>
        </form>
        <div className="row wrap small">
          {PROMPTS.map((p) => (
            <button key={p} className="ghost" onClick={() => setMsg(p)}>
              {p.slice(0, 60)}…
            </button>
          ))}
          {turns.length > 0 && (
            <button className="ghost" onClick={() => setTurns([])}>
              New conversation
            </button>
          )}
        </div>
        <ErrorBox error={error} />
      </Section>
    </>
  );
}

function AnswerView({ a }: { a: any }) {
  return (
    <div data-testid="agent-answer">
      <div className="answer-text">{a.text}</div>
      {a.results.length > 0 && (
        <p>
          <button
            onClick={() => {
              agentPins.set(a.results);
              go("explorer", null, {
                lat: a.context.center?.lat,
                lon: a.context.center?.lon,
                r: a.context.radiusMiles,
                name: a.context.placeName,
                pins: "agent",
              });
            }}
          >
            Show {a.results.length} on map
          </button>
        </p>
      )}
      {a.assumptions.length > 0 && (
        <div className="small">
          <strong>Assumptions</strong>
          <ul className="list">
            {a.assumptions.map((x: string) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}
      {a.missingData.length > 0 && (
        <div className="small">
          <strong>Missing data</strong>
          <ul className="list">
            {a.missingData.map((x: string) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}
      {a.citations.length > 0 && (
        <div className="small">
          <strong>Citations</strong>
          <ul className="list">
            {a.citations.map((c: any) => (
              <li key={c.permitKey ?? c.parcelId ?? c.sourceUrl}>
                {c.parcelId && <PropertyLink id={c.parcelId} />}{" "}
                {c.permitKey && <a href={href("permit", c.permitKey)}>{c.permitKey.split(":").pop()}</a>}{" "}
                <a href={c.sourceUrl} target="_blank" rel="noreferrer">
                  source
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      <details className="small" data-testid="agent-evidence">
        <summary>
          Retrieved evidence ({a.steps.length} tool calls · {a.usage.totalTokens.toLocaleString()} tokens ·{" "}
          {a.model})
        </summary>
        <ol className="list">
          {a.steps.map((s: any, i: number) => (
            <li key={i}>
              <code>{s.tool}</code> <code className="muted">{JSON.stringify(s.args)}</code> → {s.rowCount}{" "}
              rows{s.error ? ` · error: ${s.error}` : ""}
              {s.sample.length > 0 && <div className="muted">{s.sample.join(" · ")}</div>}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
