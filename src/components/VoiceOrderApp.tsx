'use client';

/**
 * The call.
 *
 * Orchestrates four things and owns no ordering logic of its own:
 *
 *   microphone -> utterance -> POST /turn -> spoken reply
 *
 * The server is the single source of truth for the order; this component only
 * renders what comes back. Turns are queued rather than dropped, and the
 * microphone is muted while the agent speaks so it never transcribes itself.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { CallSnapshot, TurnResponse } from '@/agent/callService';
import type { TranscriptEntry } from '@/agent/sessionStore';
import type { ConversationState } from '@/agent/agent';
import { ZERO } from '@/domain/money';
import type { Menu, PricedOrder } from '@/domain/types';
import { ApiError, endCall, sendTurn, startCall } from '@/lib/apiClient';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { useSpeechSynthesis } from '@/hooks/useSpeechSynthesis';
import { Inspector } from './Inspector';
import { MenuBoard } from './MenuBoard';
import { OrderTicket } from './OrderTicket';
import { TranscriptPane } from './TranscriptPane';

interface VoiceOrderAppProps {
  readonly menu: Menu;
}

/** Example lines, so a reviewer can exercise every required behaviour quickly. */
const SUGGESTIONS = [
  'A spicy zinger with extra cheese and no onions',
  'Two large fries and a coke',
  'Actually make it two zingers',
  'Cancel the fries',
  'Do you have pizza?',
  "What's my total?",
  "That's everything",
] as const;

const emptyOrder = (menu: Menu): PricedOrder => ({
  orderId: 'pending',
  status: 'draft',
  currency: menu.currency,
  lines: [],
  totals: {
    subtotal: ZERO,
    vatRatePercent: menu.pricing.vatRatePercent,
    vat: ZERO,
    total: ZERO,
    itemCount: 0,
    lineCount: 0,
  },
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});

type Notice = { readonly tone: 'warn' | 'error'; readonly message: string } | null;

export function VoiceOrderApp({ menu }: VoiceOrderAppProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<ConversationState>('greeting');
  const [order, setOrder] = useState<PricedOrder>(() => emptyOrder(menu));
  const [transcript, setTranscript] = useState<readonly TranscriptEntry[]>([]);
  const [lastTurn, setLastTurn] = useState<TurnResponse | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [typed, setTyped] = useState('');
  const [showDerivation, setShowDerivation] = useState(false);
  const [showInspector, setShowInspector] = useState(false);

  /* --- Refs that event handlers read (never stale) ------------------------ */

  const sessionIdRef = useRef<string | null>(null);
  const queueRef = useRef<string[]>([]);
  const drainingRef = useRef(false);
  const conversationRef = useRef<ConversationState>('greeting');

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    conversationRef.current = conversation;
  }, [conversation]);

  /* --- Speech ------------------------------------------------------------ */

  const synthesis = useSpeechSynthesis();
  const synthesisRef = useRef(synthesis);
  useEffect(() => {
    synthesisRef.current = synthesis;
  }, [synthesis]);

  const enqueueUtteranceRef = useRef<(text: string) => void>(() => {});

  const recognition = useSpeechRecognition({
    onFinalResult: useCallback((text: string) => {
      enqueueUtteranceRef.current(text);
    }, []),
  });

  const recognitionRef = useRef(recognition);
  useEffect(() => {
    recognitionRef.current = recognition;
  }, [recognition]);

  /* --- Turn pipeline ----------------------------------------------------- */

  const applyResponse = useCallback((response: CallSnapshot) => {
    setOrder(response.order);
    setTranscript(response.transcript);
    setConversation(response.state);
  }, []);

  /** Speaks the reply with the microphone muted, then re-opens it. */
  const speakReply = useCallback((reply: string, callEnded: boolean) => {
    recognitionRef.current.suspend();
    synthesisRef.current.speak(reply, () => {
      if (callEnded) recognitionRef.current.stop();
      else recognitionRef.current.resume();
    });
  }, []);

  const processTurn = useCallback(
    async (utterance: string) => {
      const id = sessionIdRef.current;
      if (!id) return;

      setBusy(true);
      setNotice(null);
      // Echo the customer immediately; the server's copy replaces it below.
      setTranscript((current) => [
        ...current,
        { role: 'customer', text: utterance, at: new Date().toISOString() },
      ]);

      try {
        const response = await sendTurn(id, utterance);
        applyResponse(response);
        setLastTurn(response);
        speakReply(response.reply, response.state === 'completed');
      } catch (error) {
        const apiError =
          error instanceof ApiError
            ? error
            : new ApiError('Something went wrong. Please try again.', 500, 'UNKNOWN', null);

        if (apiError.isSessionGone) {
          setSessionId(null);
          sessionIdRef.current = null;
          setConversation('greeting');
          recognitionRef.current.stop();
        }

        setNotice({
          tone: apiError.status >= 500 || apiError.status === 0 ? 'error' : 'warn',
          message: apiError.requestId
            ? `${apiError.message} (ref ${apiError.requestId})`
            : apiError.message,
        });
      } finally {
        setBusy(false);
      }
    },
    [applyResponse, speakReply],
  );

  /**
   * Turns are serialised. Speaking a second sentence while the first is still
   * in flight must not race the order state, so extra utterances wait here.
   */
  const drainQueue = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const next = queueRef.current.shift();
        if (next) await processTurn(next);
      }
    } finally {
      drainingRef.current = false;
    }
  }, [processTurn]);

  const enqueueUtterance = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      if (!sessionIdRef.current) return;
      if (conversationRef.current === 'completed' || conversationRef.current === 'cancelled') return;

      queueRef.current.push(trimmed.slice(0, 500));
      void drainQueue();
    },
    [drainQueue],
  );

  useEffect(() => {
    enqueueUtteranceRef.current = enqueueUtterance;
  }, [enqueueUtterance]);

  /* --- Call lifecycle ---------------------------------------------------- */

  const beginCall = useCallback(async () => {
    setConnecting(true);
    setNotice(null);
    try {
      const snapshot = await startCall();
      setSessionId(snapshot.sessionId);
      sessionIdRef.current = snapshot.sessionId;
      setOrder(snapshot.order);
      setTranscript(snapshot.transcript);
      setConversation(snapshot.state);
      setLastTurn(null);
      queueRef.current = [];

      // Started from a click, so speech synthesis is allowed to begin here.
      recognitionRef.current.start();
      speakReply(snapshot.greeting, false);
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : 'Could not start the call. Please try again.';
      setNotice({ tone: 'error', message });
    } finally {
      setConnecting(false);
    }
  }, [speakReply]);

  const hangUp = useCallback(async () => {
    const id = sessionIdRef.current;
    recognitionRef.current.stop();
    synthesisRef.current.cancel();
    queueRef.current = [];

    setSessionId(null);
    sessionIdRef.current = null;
    setConversation('greeting');
    setOrder(emptyOrder(menu));
    setTranscript([]);
    setLastTurn(null);

    if (id) {
      // Best effort: the session expires on its own regardless.
      await endCall(id).catch(() => undefined);
    }
  }, [menu]);

  // Release the session if the tab closes mid-call.
  useEffect(() => {
    const onUnload = () => {
      const id = sessionIdRef.current;
      if (!id) return;
      navigator.sendBeacon?.(`/api/session/${encodeURIComponent(id)}`);
    };
    window.addEventListener('pagehide', onUnload);
    return () => window.removeEventListener('pagehide', onUnload);
  }, []);

  /* --- Derived view state ------------------------------------------------ */

  const callActive = sessionId !== null;
  const callFinished = conversation === 'completed';
  const inputsDisabled = !callActive || busy || callFinished;

  const flashedLineIds = useMemo(
    () =>
      (lastTurn?.events ?? [])
        .map((event) => event.lineId)
        .filter((lineId): lineId is string => Boolean(lineId)),
    [lastTurn],
  );

  const onSubmitTyped = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const text = typed.trim();
      if (text.length === 0 || inputsDisabled) return;
      setTyped('');
      enqueueUtterance(text);
    },
    [enqueueUtterance, inputsDisabled, typed],
  );

  return (
    <main className="shell">
      <header className="masthead">
        <div className="brand">
          <h1 className="brand__name">{menu.restaurant.name}</h1>
          <span className="brand__tagline">{menu.restaurant.tagline} · voice ordering</span>
        </div>

        <div className="masthead__controls">
          <StatePill conversation={conversation} active={callActive} listening={recognition.status === 'listening'} speaking={synthesis.speaking} />

          {synthesis.supported ? (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => synthesis.setEnabled(!synthesis.enabled)}
              aria-pressed={!synthesis.enabled}
            >
              {synthesis.enabled ? 'Mute agent' : 'Unmute agent'}
            </button>
          ) : null}

          <button
            type="button"
            className="btn btn--sm"
            onClick={() => setShowInspector((current) => !current)}
            aria-pressed={showInspector}
          >
            {showInspector ? 'Hide data model' : 'Data model'}
          </button>

          {callActive ? (
            <button type="button" className="btn btn--sm btn--danger" onClick={() => void hangUp()}>
              End call
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => void beginCall()}
              disabled={connecting}
            >
              {connecting ? 'Connecting…' : 'Start call'}
            </button>
          )}
        </div>
      </header>

      <div className="workspace">
        <MenuBoard menu={menu} onPick={enqueueUtterance} disabled={inputsDisabled} />

        <section className="panel panel--call" aria-label="Call">
          <header className="panel__head">
            <h2 className="panel__title">Call</h2>
            {order.lines.length > 0 ? (
              <span className="pill">
                {order.totals.itemCount} item{order.totals.itemCount === 1 ? '' : 's'}
              </span>
            ) : null}
          </header>

          <div className="panel__body">
            {notice ? (
              <div className={`notice notice--${notice.tone}`} role="alert">
                <span>{notice.message}</span>
                <button
                  type="button"
                  className="notice__close"
                  onClick={() => setNotice(null)}
                  aria-label="Dismiss"
                >
                  ×
                </button>
              </div>
            ) : null}

            {recognition.error ? (
              <div className="notice notice--warn" role="status">
                <span>{recognition.error}</span>
              </div>
            ) : null}

            {!recognition.supported && callActive ? (
              <div className="notice notice--warn" role="status">
                <span>
                  This browser has no speech recognition. Chrome or Edge will listen; meanwhile you
                  can type your order below — it runs through exactly the same agent.
                </span>
              </div>
            ) : null}

            <TranscriptPane
              entries={transcript}
              interim={recognition.interim}
              started={callActive}
            />

            <div className="composer">
              <div className="composer__mic">
                <button
                  type="button"
                  className={recognition.status === 'listening' ? 'mic mic--listening' : 'mic'}
                  onClick={() => {
                    if (!callActive) {
                      void beginCall();
                      return;
                    }
                    if (recognition.status === 'listening') recognition.stop();
                    else recognition.start();
                  }}
                  disabled={callFinished || !recognition.supported}
                  aria-label={
                    recognition.status === 'listening' ? 'Stop listening' : 'Start listening'
                  }
                >
                  <MicIcon muted={recognition.status !== 'listening'} />
                </button>

                <p className="mic__hint">
                  <strong>{micHeadline(callActive, callFinished, recognition.status, busy, synthesis.speaking)}</strong>
                  {micSubtext(callActive, callFinished)}
                </p>
              </div>

              <form className="composer__form" onSubmit={onSubmitTyped}>
                <input
                  className="composer__input"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  placeholder={
                    callActive ? '…or type it here' : 'Start the call to order'
                  }
                  maxLength={500}
                  disabled={inputsDisabled}
                  aria-label="Type your order"
                />
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={inputsDisabled || typed.trim().length === 0}
                >
                  Send
                </button>
              </form>

              <div className="suggestions">
                <span className="suggestions__label">Try saying</span>
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="chip"
                    disabled={inputsDisabled}
                    onClick={() => enqueueUtterance(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <OrderTicket
            order={order}
            flashedLineIds={flashedLineIds}
            showDerivation={showDerivation}
            onToggleDerivation={() => setShowDerivation((current) => !current)}
          />

          {showInspector ? (
            <section className="panel" aria-label="Data model inspector">
              <header className="panel__head">
                <h2 className="panel__title">Data model</h2>
              </header>
              <div className="panel__body">
                <Inspector lastTurn={lastTurn} order={order} />
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Small presentational helpers                                               */
/* -------------------------------------------------------------------------- */

function StatePill({
  conversation,
  active,
  listening,
  speaking,
}: {
  conversation: ConversationState;
  active: boolean;
  listening: boolean;
  speaking: boolean;
}) {
  if (!active) return <span className="pill">Not on a call</span>;
  if (conversation === 'completed') {
    return (
      <span className="pill pill--done">
        <span className="dot" /> Order confirmed
      </span>
    );
  }
  if (conversation === 'confirming') {
    return (
      <span className="pill pill--confirming">
        <span className="dot" /> Confirming
      </span>
    );
  }
  if (speaking) {
    return (
      <span className="pill pill--live">
        <span className="dot dot--pulse" /> Agent speaking
      </span>
    );
  }
  return (
    <span className="pill pill--live">
      <span className={listening ? 'dot dot--pulse' : 'dot'} />
      {listening ? 'Listening' : 'On a call'}
    </span>
  );
}

function micHeadline(
  active: boolean,
  finished: boolean,
  status: string,
  busy: boolean,
  speaking: boolean,
): string {
  if (finished) return 'Order confirmed';
  if (!active) return 'Start the call';
  if (speaking) return 'Agent is speaking…';
  if (busy) return 'Thinking…';
  if (status === 'listening') return 'Listening — go ahead';
  if (status === 'denied') return 'Microphone blocked';
  if (status === 'unsupported') return 'Microphone unavailable';
  return 'Tap to talk';
}

function micSubtext(active: boolean, finished: boolean): string {
  if (finished) return 'Start a new call to order again.';
  if (!active) return 'Your order is taken end to end, by voice.';
  return 'Change your mind any time — say “actually, make it two”.';
}

function MicIcon({ muted }: { muted: boolean }) {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Z"
        fill="currentColor"
        opacity={muted ? 0.75 : 1}
      />
      <path
        d="M19 11a7 7 0 0 1-14 0M12 18v3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
