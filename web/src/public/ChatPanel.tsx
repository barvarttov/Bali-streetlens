import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowCounterClockwise, Info, PaperPlaneRight, Signpost, Warning, X } from "@phosphor-icons/react";
import { useLang } from "../i18n.tsx";
import type { StringKey } from "../i18n.tsx";
import type { Corridor, JunctionState, LngLat } from "../lib/liveSchema.ts";
import { StateMark } from "./parts.tsx";
import type { Endpoint } from "./route.ts";

// "Tanya lalu lintas": a chat about today's traffic, answered by a free model (Groq, else NVIDIA)
// through the backend, which feeds it our own live data, today's history and the route planner.
// Desktop: a ruled panel on the right of the sheet. Phone: a full-screen page.
// Junction names in answers are buttons to their card; a route answer can open on the map.

interface RouteAction {
  type: "route";
  from: { name: string; lnglat: LngLat; kind: "place" | "junction" };
  to: { name: string; lnglat: LngLat; kind: "place" | "junction" };
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  junctions?: string[];
  actions?: RouteAction[];
  provider?: string;
  error?: { code: string; message: string };
}

interface Props {
  corridor: Corridor;
  states: Map<string, JunctionState>;
  synthetic: boolean;
  fullScreen: boolean;
  onClose: () => void;
  onOpenJunction: (id: string) => void;
  onOpenRoute: (from: Endpoint, to: Endpoint) => void;
}

const SUGGESTIONS: StringKey[] = ["chatSuggest1", "chatSuggest2", "chatSuggest3", "chatSuggest4"];
const ERROR_KEYS = ["no_key", "busy", "bad_key", "offline", "too_long", "network"] as const;

export function ChatPanel({ corridor, states, synthetic, fullScreen, onClose, onOpenJunction, onOpenRoute }: Props) {
  const { t, lang } = useLang();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch("/api/chat/status")
      .then((r) => r.json())
      .then((d: { available: boolean }) => setAvailable(d.available))
      .catch(() => setAvailable(false));
    inputRef.current?.focus();
  }, []);

  // Keep the newest message in view.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, waiting]);

  // The textarea grows with its text, up to four lines.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
  }, [draft]);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || waiting) return;
    const history = [...turns.filter((x) => !x.error), { role: "user" as const, content: question }];
    setTurns((prev) => [...prev, { role: "user", content: question }]);
    setDraft("");
    setWaiting(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang, messages: history.map(({ role, content }) => ({ role, content })) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = (data as { detail?: { code?: string; message?: string } }).detail;
        const code = detail?.code ?? "busy";
        if (code === "no_key") setAvailable(false);
        setTurns((prev) => [...prev, { role: "assistant", content: "", error: { code, message: detail?.message ?? `HTTP ${res.status}` } }]);
      } else {
        const d = data as { reply: string; junctions: string[]; actions: RouteAction[]; provider: string };
        setTurns((prev) => [...prev, { role: "assistant", content: d.reply, junctions: d.junctions, actions: d.actions, provider: d.provider }]);
      }
    } catch {
      setTurns((prev) => [...prev, { role: "assistant", content: "", error: { code: "network", message: "" } }]);
    } finally {
      setWaiting(false);
      inputRef.current?.focus();
    }
  };

  const errorText = (e: NonNullable<Turn["error"]>) =>
    (ERROR_KEYS as readonly string[]).includes(e.code) ? t(`chatErr_${e.code}` as StringKey) : t("chatErr_busy");

  const lastAssistant = [...turns].reverse().find((x) => x.role === "assistant" && !x.error);
  return (
    <aside className={`chat-panel${fullScreen ? " is-full" : " is-side"}`} aria-label={t("chatTitle")} role="complementary">
      <header className="chat-head">
        <div>
          <h2 className="chat-title">{t("chatTitle")}</h2>
          <p className="chat-sub">{synthetic ? t("chatSubSynthetic") : t("chatSub")}</p>
        </div>
        <div className="chat-head-tools">
          {turns.length > 0 && (
            <button type="button" className="icon-btn" onClick={() => setTurns([])} aria-label={t("chatReset")} title={t("chatReset")} disabled={waiting}>
              <ArrowCounterClockwise size={20} weight="bold" aria-hidden="true" />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("chatClose")}>
            <X size={20} weight="bold" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="chat-log" ref={listRef} aria-live="polite" aria-busy={waiting}>
        {turns.length === 0 && (
          <div className="chat-empty">
            <p className="chat-intro">{t("chatIntro", { n: corridor.junctions.length })}</p>
            {available === false && (
              <p className="chat-setup" role="note">
                <Warning size={18} weight="bold" aria-hidden="true" />
                <span>{t("chatErr_no_key")}</span>
              </p>
            )}
            <p className="section-title">{t("chatTry")}</p>
            <ul className="chat-suggest">
              {SUGGESTIONS.map((k) => (
                <li key={k}>
                  <button type="button" onClick={() => void send(t(k))} disabled={waiting || available === false}>
                    {t(k)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {turns.map((turn, i) =>
          turn.role === "user" ? (
            <p key={i} className="chat-msg is-user">
              {turn.content}
            </p>
          ) : turn.error ? (
            <div key={i} className="chat-msg is-error" role="alert">
              <Warning size={18} weight="bold" aria-hidden="true" />
              <span>{errorText(turn.error)}</span>
            </div>
          ) : (
            <div key={i} className="chat-msg is-bot">
              <Answer text={turn.content} junctionIds={turn.junctions ?? []} corridor={corridor} states={states} onOpenJunction={onOpenJunction} />
              {turn.actions?.map((a, k) => (
                <button
                  key={k}
                  type="button"
                  className="btn btn-primary btn-sm chat-action"
                  onClick={() => onOpenRoute({ name: a.from.name, lnglat: a.from.lnglat, kind: a.from.kind }, { name: a.to.name, lnglat: a.to.lnglat, kind: a.to.kind })}
                >
                  <Signpost size={16} weight="bold" aria-hidden="true" />
                  {t("chatOpenRoute", { from: a.from.name, to: a.to.name })}
                </button>
              ))}
              {turn === lastAssistant && <p className="chat-by">{t("chatBy", { provider: turn.provider ?? "AI" })}</p>}
            </div>
          ),
        )}
        {waiting && (
          <p className="chat-msg is-waiting" role="status">
            <span className="chat-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            {t("chatChecking")}
          </p>
        )}
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <label htmlFor="chat-q" className="visually-hidden">
          {t("chatPlaceholder")}
        </label>
        <textarea
          id="chat-q"
          ref={inputRef}
          rows={1}
          maxLength={600}
          value={draft}
          placeholder={t("chatPlaceholder")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            } else if (e.key === "Escape") onClose();
          }}
          disabled={available === false}
        />
        <button type="submit" className="chat-send" disabled={!draft.trim() || waiting || available === false} aria-label={t("chatSend")}>
          <PaperPlaneRight size={20} weight="bold" aria-hidden="true" />
        </button>
      </form>
      <p className="chat-foot">
        <Info size={13} weight="bold" aria-hidden="true" />
        <span>{t("chatDisclaimer")}</span>
      </p>
    </aside>
  );
}

/**
 * A model answer as paragraphs and lists (the little markdown models write), with **bold** kept and
 * every watched junction it names turned into a button that opens that junction, with its live mark.
 */
function Answer({ text, junctionIds, corridor, states, onOpenJunction }: {
  text: string;
  junctionIds: string[];
  corridor: Corridor;
  states: Map<string, JunctionState>;
  onOpenJunction: (id: string) => void;
}) {
  const junctions = corridor.junctions.filter((j) => junctionIds.includes(j.id));
  // Longest names first, so "Simpang Patung Kuda" wins over "Patung Kuda".
  const names = junctions
    .flatMap((j) => [{ id: j.id, name: j.name }, { id: j.id, name: j.name.replace(/^Simpang\s+/i, "") }])
    .sort((a, b) => b.name.length - a.name.length);
  const pattern = names.length ? new RegExp(`(${names.map((n) => n.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi") : null;

  const inline = (s: string, keyBase: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*)/g).flatMap((part, i) => {
      const bold = part.startsWith("**") && part.endsWith("**");
      const body = bold ? part.slice(2, -2) : part;
      const pieces: ReactNode[] = pattern
        ? body.split(pattern).map((piece, k) => {
            const hit = names.find((n) => n.name.toLowerCase() === piece.toLowerCase());
            if (!hit) return <Fragment key={k}>{piece}</Fragment>;
            return (
              <button key={k} type="button" className="chat-junction" onClick={() => onOpenJunction(hit.id)}>
                <StateMark label={states.get(hit.id)?.label ?? "unknown"} size={13} />
                {piece}
              </button>
            );
          })
        : [body];
      return bold ? [<strong key={`${keyBase}-${i}`}>{pieces}</strong>] : pieces.map((p, k) => <Fragment key={`${keyBase}-${i}-${k}`}>{p}</Fragment>);
    });

  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={`l${blocks.length}`}>{list.map((item, i) => <li key={i}>{inline(item, `li${blocks.length}-${i}`)}</li>)}</ul>);
    list = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const item = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (item) list.push(item[1]);
    else {
      flush();
      if (line) blocks.push(<p key={`p${blocks.length}`}>{inline(line.replace(/^#+\s*/, ""), `p${blocks.length}`)}</p>);
    }
  }
  flush();
  return <div className="chat-answer">{blocks}</div>;
}
