'use client';

import { useMemo } from 'react';

import type { Menu, MenuItem, OptionGroup } from '@/domain/types';
import { amount, delta } from '@/lib/format';

interface MenuBoardProps {
  readonly menu: Menu;
  /** Ordering an item by tapping it goes through the same turn pipeline as speech. */
  readonly onPick: (utterance: string) => void;
  readonly disabled: boolean;
}

/**
 * The menu board, rendered from the same catalogue the agent understands.
 *
 * Tapping an item does not add it directly: it sends the item's name as an
 * utterance, so a click travels the identical parse -> intent -> order path a
 * spoken order does. One code path, one set of rules.
 */
export function MenuBoard({ menu, onPick, disabled }: MenuBoardProps) {
  const groupsById = useMemo(
    () => new Map(menu.optionGroups.map((group) => [group.id, group])),
    [menu.optionGroups],
  );

  const itemsByCategory = useMemo(() => {
    const map = new Map<string, MenuItem[]>();
    for (const category of menu.categories) map.set(category.id, []);
    for (const item of menu.items) map.get(item.categoryId)?.push(item);
    return map;
  }, [menu.categories, menu.items]);

  return (
    <section className="panel panel--menu" aria-label="Menu">
      <header className="panel__head">
        <h2 className="panel__title">Menu</h2>
        <span className="pill">{menu.currency.code}</span>
      </header>

      <div className="panel__body">
        {menu.categories.map((category) => {
          const items = (itemsByCategory.get(category.id) ?? []).filter((item) => item.available);
          if (items.length === 0) return null;

          const modifierGroups = collectModifierGroups(items, groupsById);

          return (
            <section className="menu__category" key={category.id}>
              <h3 className="menu__heading">{category.name}</h3>
              {category.note ? <p className="menu__note">{category.note}</p> : null}

              {items.map((item) => (
                <button
                  type="button"
                  className="menu__item"
                  key={item.id}
                  disabled={disabled}
                  onClick={() => onPick(item.name)}
                  title={`Order a ${item.name}`}
                >
                  <span>
                    <span className="menu__item-name">{item.name}</span>
                    {item.description ? (
                      <span className="menu__item-desc">{item.description}</span>
                    ) : null}
                  </span>
                  <span className="menu__item-price">
                    {priceLabel(item, groupsById, menu)}
                  </span>
                </button>
              ))}

              {modifierGroups.map((group) => (
                <p className="menu__addons" key={group.id}>
                  <strong>{group.name}:</strong>{' '}
                  {group.choices
                    .map((choice) => `${choice.name} ${delta(choice.priceDelta, menu.currency)}`)
                    .join('  |  ')}
                </p>
              ))}
            </section>
          );
        })}
      </div>
    </section>
  );
}

/** "28" for a fixed price, "10 / 15" when a size variant changes it. */
function priceLabel(
  item: MenuItem,
  groupsById: ReadonlyMap<string, OptionGroup>,
  menu: Menu,
): string {
  const variantPrices = item.optionGroupIds
    .map((groupId) => groupsById.get(groupId))
    .filter((group): group is OptionGroup => group?.kind === 'variant')
    .flatMap((group) => group.choices.map((choice) => choice.priceDelta))
    .filter((priceDelta) => priceDelta !== 0);

  if (variantPrices.length === 0) return amount(item.basePrice, menu.currency);

  const totals = new Set<number>([item.basePrice]);
  for (const priceDelta of variantPrices) totals.add(item.basePrice + priceDelta);

  return [...totals]
    .sort((a, b) => a - b)
    .map((total) => amount(total, menu.currency))
    .join(' / ');
}

/** Add-on groups shared across a category, shown once beneath it as on the PDF. */
function collectModifierGroups(
  items: readonly MenuItem[],
  groupsById: ReadonlyMap<string, OptionGroup>,
): OptionGroup[] {
  const seen = new Map<string, OptionGroup>();
  for (const item of items) {
    for (const groupId of item.optionGroupIds) {
      const group = groupsById.get(groupId);
      if (group?.kind === 'modifier') seen.set(group.id, group);
    }
  }
  return [...seen.values()];
}
