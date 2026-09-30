'use client';

import { useEffect, useRef } from 'react';

import type { TranscriptEntry } from '@/agent/sessionStore';

interface TranscriptPaneProps {
  readonly entries: readonly TranscriptEntry[];
  /** Words currently being recognised, shown greyed until the phrase settles. */
  readonly interim: string;
  readonly started: boolean;
}

export function TranscriptPane({ entries, interim, started }: TranscriptPaneProps) {
  const endRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest turn in view without yanking the page around.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [entries.length, interim]);

  if (!started) {
    return (
      <div className="transcript">
        <p className="transcript__empty">
          Press <strong>Start call</strong> and order the way you would on the phone.
        </p>
      </div>
    );
  }

  return (
    <div className="transcript" role="log" aria-live="polite" aria-label="Call transcript">
      {entries.map((entry, index) => (
        <div
          key={`${entry.at}-${index}`}
          className={entry.role === 'agent' ? 'bubble bubble--agent' : 'bubble bubble--customer'}
        >
          <span className="bubble__role">{entry.role === 'agent' ? 'Smash & Go' : 'You'}</span>
          {entry.text}
        </div>
      ))}

      {interim ? (
        <div className="bubble bubble--interim">
          <span className="bubble__role">You · hearing</span>
          {interim}
        </div>
      ) : null}

      <div ref={endRef} />
    </div>
  );
}
