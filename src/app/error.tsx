'use client';

import { useEffect } from 'react';

/**
 * Route-level error boundary.
 *
 * Next.js strips server error details in production and passes only a digest;
 * that digest is shown so a user-reported failure can be found in the logs,
 * while the underlying message stays server-side.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Unhandled error in the ordering app:', error);
  }, [error]);

  return (
    <main className="shell" style={{ placeContent: 'center', textAlign: 'center' }}>
      <div className="panel" style={{ padding: 32, maxWidth: 520, margin: '0 auto' }}>
        <h1 className="brand__name" style={{ marginBottom: 10 }}>
          Line dropped
        </h1>
        <p style={{ color: 'var(--muted)', marginTop: 0 }}>
          Something went wrong on our side and the call could not continue. Nothing has been sent to
          the kitchen.
        </p>
        {error.digest ? (
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)' }}>
            Reference: {error.digest}
          </p>
        ) : null}
        <button type="button" className="btn btn--primary" onClick={reset}>
          Start a new call
        </button>
      </div>
    </main>
  );
}
