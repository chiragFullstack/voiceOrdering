'use client';

import type { TurnResponse } from '@/agent/callService';
import type { PricedOrder } from '@/domain/types';

interface InspectorProps {
  readonly lastTurn: TurnResponse | null;
  readonly order: PricedOrder;
}

/**
 * A window onto the data model, for demos and debugging.
 *
 * Shows what the parser understood and what the order actually stores — note
 * that the stored line carries only `itemId`, `quantity` and `selections`. No
 * price is persisted anywhere; the priced view beside it is computed on read.
 */
export function Inspector({ lastTurn, order }: InspectorProps) {
  const storedLines = order.lines.map((line) => ({
    id: line.lineId,
    itemId: line.itemId,
    quantity: line.quantity,
    selections: line.selections.map((selection) => ({
      groupId: selection.groupId,
      choiceId: selection.choiceId,
    })),
  }));

  const derived = order.lines.map((line) => ({
    line: line.label,
    base: line.unitBasePrice,
    modifiers: line.unitModifierTotal,
    unit: line.unitPrice,
    quantity: line.quantity,
    lineTotal: line.lineTotal,
  }));

  return (
    <div className="inspector">
      <p className="inspector__legend">
        Stored state carries ids only. Prices below are derived from the catalogue on every read.
      </p>

      <pre className="inspector__pre">
        {JSON.stringify(
          {
            parsedIntents: lastTurn?.parse.intents ?? [],
            heardAs: lastTurn?.parse.normalized ?? null,
            storedOrderLines: storedLines,
            derivedPricing: derived,
            derivedTotals: order.totals,
          },
          null,
          2,
        )}
      </pre>
    </div>
  );
}
