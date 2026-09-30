'use client';

/**
 * Text-to-speech, via the browser.
 *
 * Two details matter for a call that sounds natural:
 *
 *  - voices load asynchronously, so the list is re-read on `voiceschanged`
 *    rather than once at mount;
 *  - `onend` is not guaranteed to fire in every browser, so callers are also
 *    released by a length-based timeout. Without that, the microphone would
 *    stay muted forever if a single utterance were dropped.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

/** Environment capability, read the same way as in `useSpeechRecognition`. */
const subscribeToNothing = () => () => {};
const readSynthesisSupport = () =>
  typeof window !== 'undefined' && 'speechSynthesis' in window;
const noSynthesisOnServer = () => false;

export interface SpeechSynthesisState {
  readonly supported: boolean;
  readonly speaking: boolean;
  readonly enabled: boolean;
  readonly setEnabled: (enabled: boolean) => void;
  readonly speak: (text: string, onDone?: () => void) => void;
  readonly cancel: () => void;
}

/** Roughly how long an utterance takes, used as the safety timeout. */
function estimateDurationMs(text: string): number {
  const words = text.trim().split(/\s+/).length;
  return Math.min(60_000, 1_200 + (words / 2.6) * 1_000);
}

function pickVoice(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  const english = voices.filter((voice) => voice.lang.toLowerCase().startsWith('en'));
  const pool = english.length > 0 ? english : voices;

  // Prefer the higher-quality cloud voices browsers expose, then anything local.
  const preferred = ['google', 'microsoft', 'samantha', 'natural'];
  for (const name of preferred) {
    const match = pool.find((voice) => voice.name.toLowerCase().includes(name));
    if (match) return match;
  }
  return pool[0] ?? null;
}

export function useSpeechSynthesis(): SpeechSynthesisState {
  const supported = useSyncExternalStore(
    subscribeToNothing,
    readSynthesisSupport,
    noSynthesisOnServer,
  );

  const [speaking, setSpeaking] = useState(false);
  const [enabled, setEnabledState] = useState(true);

  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doneRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const loadVoices = () => {
      voiceRef.current = pickVoice(window.speechSynthesis.getVoices());
    };

    loadVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);

    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', loadVoices);
      window.speechSynthesis.cancel();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  /** Runs the caller's completion callback exactly once. */
  const settle = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setSpeaking(false);
    const done = doneRef.current;
    doneRef.current = null;
    done?.();
  }, []);

  const cancel = useCallback(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    settle();
  }, [settle]);

  const speak = useCallback(
    (text: string, onDone?: () => void) => {
      const trimmed = text.trim();
      if (!supported || !enabled || trimmed.length === 0) {
        onDone?.();
        return;
      }

      window.speechSynthesis.cancel();
      doneRef.current = onDone ?? null;

      const utterance = new SpeechSynthesisUtterance(trimmed);
      if (voiceRef.current) utterance.voice = voiceRef.current;
      utterance.rate = 1.04; // a touch brisk, the way order-takers actually speak
      utterance.pitch = 1;
      utterance.volume = 1;
      utterance.onend = settle;
      utterance.onerror = settle;

      setSpeaking(true);
      timeoutRef.current = setTimeout(settle, estimateDurationMs(trimmed));

      try {
        window.speechSynthesis.speak(utterance);
      } catch {
        settle();
      }
    },
    [enabled, settle, supported],
  );

  /**
   * Muting is an action, not a derived state: stopping the current utterance
   * belongs in the handler that mutes, not in an effect reacting to the flag.
   */
  const setEnabled = useCallback(
    (next: boolean) => {
      setEnabledState(next);
      if (!next) cancel();
    },
    [cancel],
  );

  return useMemo(
    () => ({ supported, speaking, enabled, setEnabled, speak, cancel }),
    [supported, speaking, enabled, setEnabled, speak, cancel],
  );
}
