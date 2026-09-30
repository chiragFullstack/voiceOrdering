'use client';

/**
 * Speech-to-text, via the browser.
 *
 * The recogniser is deliberately restarted by hand rather than left in
 * `continuous` mode forever: Chrome ends a session after a pause, and a
 * hand-rolled restart loop is the only reliable way to keep a "call" open. A
 * `wantsToListen` ref — not React state — drives that loop, because the `onend`
 * handler fires outside React's render cycle and would otherwise see a stale
 * value.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

export type MicrophoneStatus = 'idle' | 'listening' | 'denied' | 'unsupported' | 'error';

export interface SpeechRecognitionState {
  readonly supported: boolean;
  readonly status: MicrophoneStatus;
  /** Words heard so far in the current phrase, before it is finalised. */
  readonly interim: string;
  readonly error: string | null;
  readonly start: () => void;
  readonly stop: () => void;
  /** Temporarily deafen the mic while the agent speaks, to avoid echo. */
  readonly suspend: () => void;
  readonly resume: () => void;
}

interface Options {
  readonly onFinalResult: (transcript: string) => void;
  readonly language?: string;
}

/**
 * Feature detection is a property of the environment, not React state, so it is
 * read through `useSyncExternalStore`. That keeps the server render (always
 * `false`) and the first client render in agreement, with no effect and no
 * hydration mismatch.
 */
const subscribeToNothing = () => () => {};
const readRecognitionSupport = () =>
  typeof window !== 'undefined' &&
  Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition);
const noRecognitionOnServer = () => false;

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  'not-allowed':
    'Microphone access was blocked. Allow it in your browser settings, or type your order instead.',
  'service-not-allowed':
    'Speech recognition is unavailable in this browser. You can type your order instead.',
  'audio-capture': 'No microphone was found. Plug one in, or type your order instead.',
  network: 'The speech service could not be reached. Check your connection, or type instead.',
  'language-not-supported': 'This language is not supported for speech recognition.',
};

export function useSpeechRecognition({
  onFinalResult,
  language = 'en-US',
}: Options): SpeechRecognitionState {
  const supported = useSyncExternalStore(
    subscribeToNothing,
    readRecognitionSupport,
    noRecognitionOnServer,
  );

  const [rawStatus, setStatus] = useState<MicrophoneStatus>('idle');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  // An unsupported browser can never leave the 'unsupported' state.
  const status: MicrophoneStatus = supported ? rawStatus : 'unsupported';

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const wantsToListenRef = useRef(false);
  const suspendedRef = useRef(false);
  /** Kept in a ref so the recogniser's handlers never close over a stale prop. */
  const onFinalResultRef = useRef(onFinalResult);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onFinalResultRef.current = onFinalResult;
  }, [onFinalResult]);

  /* --- Construction ------------------------------------------------------ */

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) return;

    let recognition: SpeechRecognition;
    try {
      recognition = new Recognition();
    } catch {
      return; // constructor exists but is unusable (e.g. an insecure origin)
    }

    recognition.lang = language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setStatus('listening');
      setError(null);
    };

    recognition.onresult = (event) => {
      let pending = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result) continue;
        const transcript = result[0]?.transcript ?? '';
        if (result.isFinal) {
          const finalText = transcript.trim();
          if (finalText.length > 0) onFinalResultRef.current(finalText);
        } else {
          pending += transcript;
        }
      }
      setInterim(pending.trim());
    };

    recognition.onerror = (event) => {
      // Silence between phrases is normal; the restart loop handles it.
      if (event.error === 'no-speech' || event.error === 'aborted') return;

      const message = ERROR_MESSAGES[event.error] ?? 'Speech recognition stopped unexpectedly.';
      setError(message);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        wantsToListenRef.current = false;
        setStatus('denied');
      } else {
        setStatus('error');
      }
    };

    recognition.onend = () => {
      setInterim('');
      if (!wantsToListenRef.current || suspendedRef.current) {
        setStatus((current) => (current === 'denied' || current === 'error' ? current : 'idle'));
        return;
      }
      // Chrome ends the session after a pause. Restart on the next tick;
      // restarting synchronously inside `onend` throws InvalidStateError.
      restartTimerRef.current = setTimeout(() => {
        if (!wantsToListenRef.current || suspendedRef.current) return;
        try {
          recognition.start();
        } catch {
          // Already starting — the next `onend` will retry.
        }
      }, 120);
    };

    recognitionRef.current = recognition;

    return () => {
      wantsToListenRef.current = false;
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onstart = null;
      try {
        recognition.abort();
      } catch {
        // Nothing to abort.
      }
      recognitionRef.current = null;
    };
  }, [language]);

  /* --- Controls ---------------------------------------------------------- */

  const start = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    wantsToListenRef.current = true;
    suspendedRef.current = false;
    setError(null);
    try {
      recognition.start();
    } catch {
      // `start()` throws if the recogniser is already running — harmless.
    }
  }, []);

  const stop = useCallback(() => {
    const recognition = recognitionRef.current;
    wantsToListenRef.current = false;
    suspendedRef.current = false;
    setInterim('');
    setStatus('idle');
    if (!recognition) return;
    try {
      recognition.stop();
    } catch {
      // Already stopped.
    }
  }, []);

  const suspend = useCallback(() => {
    if (!wantsToListenRef.current) return;
    suspendedRef.current = true;
    setInterim('');
    try {
      recognitionRef.current?.stop();
    } catch {
      // Already stopped.
    }
  }, []);

  const resume = useCallback(() => {
    if (!wantsToListenRef.current) return;
    suspendedRef.current = false;
    try {
      recognitionRef.current?.start();
    } catch {
      // Already running.
    }
  }, []);

  return useMemo(
    () => ({ supported, status, interim, error, start, stop, suspend, resume }),
    [supported, status, interim, error, start, stop, suspend, resume],
  );
}
