'use client';

import type { PricedLine, PricedOrder } from '@/domain/types';
import { amount, money } from '@/lib/format';

interface OrderTicketProps {
  readonly order: PricedOrder;
  /** Lines touched by the last turn, briefly highlighted. */
  readonly flashedLineIds: readonly string[];
  /** Shows the arithmetic behind every line — useful when demoing the model. */
  readonly showDerivation: boolean;
  readonly onToggleDerivation: () => void;
}

/**
 * The live ticket.
 *
 * Everything here arrives already priced from the server. The component does no
 * arithmetic of its own — not even summing the lines — which is the whole point
 * of deriving totals in one place.
 */
export function OrderTicket({
  order,
  flashedLineIds,
  showDerivation,
  onToggleDerivation,
}: OrderTicketProps) {
  const { currency, totals } = order;
  const flashed = new Set(flashedLineIds);

  return (
    <section className="panel panel--ticket" aria-label="Current order">
      <header className="panel__head">
        <h2 className="panel__title">Order</h2>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={onToggleDerivation}
          aria-pressed={showDerivation}
        >
          {showDerivation ? 'Hide maths' : 'Show maths'}
        </button>
      </header>

      <div className="panel__body">
        {order.lines.length === 0 ? (
          <p className="ticket__empty">
            Nothing on the ticket yet.
            <br />
            Start talking and it will appear here.
          </p>
        ) : (
          <ul className="ticket__lines">
            {order.lines.map((line) => (
              <LineRow
                key={line.lineId}
                line={line}
                currency={currency}
                flashed={flashed.has(line.lineId)}
                showDerivation={showDerivation}
              />
            ))}
          </ul>
        )}

        <div className="totals" aria-live="polite">
          <div className="totals__row">
            <span>
              Subtotal
              <span style={{ color: 'var(--muted)' }}>
                {' '}
                · {totals.itemCount} item{totals.itemCount === 1 ? '' : 's'}
              </span>
            </span>
            <span className="totals__value">{amount(totals.subtotal, currency)}</span>
          </div>

          {totals.vatRatePercent > 0 ? (
            <div className="totals__row">
              <span>VAT ({totals.vatRatePercent}%)</span>
              <span className="totals__value">{amount(totals.vat, currency)}</span>
            </div>
          ) : null}

          <div className="totals__row totals__row--grand">
            <span>Total</span>
            <span className="totals__value">{money(totals.total, currency)}</span>
          </div>

          {showDerivation ? (
            <p className="totals__note">
              total = Σ(line) {totals.vatRatePercent > 0 ? '+ VAT ' : ''}· derived on every read,
              never stored
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function LineRow({
  line,
  currency,
  flashed,
  showDerivation,
}: {
  line: PricedLine;
  currency: PricedOrder['currency'];
  flashed: boolean;
  showDerivation: boolean;
}) {
  return (
    <li className={flashed ? 'line line--flash' : 'line'}>
      <div className="line__top">
        <span className="line__name">
          <span className="line__qty">{line.quantity}×</span>
          {line.itemName}
        </span>
        <span className="line__total">{amount(line.lineTotal, currency)}</span>
      </div>

      {line.selections.length > 0 ? (
        <div className="line__mods">
          {line.selections.map((selection) => (
            <span
              key={`${selection.groupId}:${selection.choiceId}`}
              className={modifierClass(selection.priceDelta, selection.isDefault)}
              title={`${selection.groupName} · ${
                selection.priceDelta === 0
                  ? 'no price change'
                  : `${selection.priceDelta > 0 ? '+' : '−'}${amount(
                      Math.abs(selection.priceDelta),
                      currency,
                    )}`
              }${selection.isDefault ? ' · chosen by default' : ''}`}
            >
              {selection.choiceName}
              {selection.priceDelta !== 0
                ? ` +${amount(selection.priceDelta, currency)}`
                : ''}
            </span>
          ))}
        </div>
      ) : null}

      {showDerivation ? (
        <p className="line__math">
          {amount(line.unitBasePrice, currency)}
          {line.unitModifierTotal !== 0
            ? ` ${line.unitModifierTotal > 0 ? '+' : '−'} ${amount(
                Math.abs(line.unitModifierTotal),
                currency,
              )}`
            : ''}{' '}
          = {amount(line.unitPrice, currency)} × {line.quantity} ={' '}
          {amount(line.lineTotal, currency)}
        </p>
      ) : null}
    </li>
  );
}

function modifierClass(priceDelta: number, isDefault: boolean): string {
  if (isDefault) return 'mod mod--default';
  return priceDelta !== 0 ? 'mod mod--paid' : 'mod';
}
