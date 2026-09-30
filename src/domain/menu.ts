/**
 * Menu loading and validation.
 *
 * `data/menu.json` is untrusted input like any other: it is validated against a
 * schema *and* against referential-integrity rules (every referenced group,
 * choice, category and combo component must exist) before a single order can
 * be taken. A bad catalogue fails loudly at boot rather than silently
 * mispricing an order.
 *
 * The result is loaded once per process, deep-frozen, and indexed.
 */

import { z } from 'zod';

import { MenuInvalidError } from './errors';
import { minor, type Minor } from './money';
import type {
  Category,
  Menu,
  MenuIndex,
  MenuItem,
  OptionChoice,
  OptionGroup,
} from './types';

import rawMenu from '@data/menu.json';

/* -------------------------------------------------------------------------- */
/* Schema                                                                      */
/* -------------------------------------------------------------------------- */

/** Ids are used in URLs, lexicons and logs — keep them to a boring alphabet. */
const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'ids must be lowercase kebab-case');

const moneySchema = z
  .number()
  .int('prices must be whole minor units (e.g. fils), not decimals')
  .min(-100_000)
  .max(1_000_000);

const aliasSchema = z.string().trim().min(1).max(64);

const selectionRefSchema = z
  .object({ groupId: idSchema, choiceId: idSchema })
  .strict();

const optionChoiceSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(64),
    priceDelta: moneySchema,
    aliases: z.array(aliasSchema).max(32).default([]),
  })
  .strict();

const optionGroupSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(64),
    kind: z.enum(['variant', 'modifier']),
    minSelect: z.number().int().min(0).max(16),
    maxSelect: z.number().int().min(1).max(16),
    defaultChoiceId: idSchema.optional(),
    askWhenUnspecified: z.boolean().default(false),
    choices: z.array(optionChoiceSchema).min(1).max(32),
  })
  .strict()
  .superRefine((group, ctx) => {
    if (group.maxSelect < group.minSelect) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `group "${group.id}": maxSelect (${group.maxSelect}) is below minSelect (${group.minSelect})`,
      });
    }
    if (group.kind === 'variant' && group.maxSelect !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `group "${group.id}": a variant group must have maxSelect of exactly 1`,
      });
    }
    // A required group with no default could leave a line unpriceable.
    if (group.minSelect > 0 && !group.defaultChoiceId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `group "${group.id}": required groups must declare a defaultChoiceId`,
      });
    }
    // There is nothing to ask about unless exactly one choice is expected and
    // a fallback exists for a caller who does not answer.
    if (group.askWhenUnspecified && (group.kind !== 'variant' || !group.defaultChoiceId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `group "${group.id}": askWhenUnspecified needs a variant group with a defaultChoiceId`,
      });
    }
    const duplicateIds = findDuplicates(group.choices.map((choice) => choice.id));
    if (duplicateIds.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `group "${group.id}": duplicate choice ids: ${duplicateIds.join(', ')}`,
      });
    }
  });

const comboComponentSchema = z
  .object({
    itemId: idSchema,
    quantity: z.number().int().min(1).max(10),
    fixedSelections: z.array(selectionRefSchema).max(8).default([]),
  })
  .strict();

const shortcutSchema = z
  .object({
    phrases: z.array(aliasSchema).min(1).max(16),
    selections: z.array(selectionRefSchema).min(1).max(8),
  })
  .strict();

const menuItemSchema = z
  .object({
    id: idSchema,
    categoryId: idSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().max(200).default(''),
    basePrice: moneySchema.min(0),
    available: z.boolean().default(true),
    optionGroupIds: z.array(idSchema).max(8).default([]),
    speechNameGroupId: idSchema.optional(),
    aliases: z.array(aliasSchema).max(32).default([]),
    shortcuts: z.array(shortcutSchema).max(16).optional(),
    components: z.array(comboComponentSchema).max(8).optional(),
  })
  .strict();

const menuSchema = z
  .object({
    schemaVersion: z.literal(1),
    restaurant: z
      .object({
        name: z.string().trim().min(1).max(80),
        tagline: z.string().max(120).default(''),
        greeting: z.string().trim().min(1).max(300),
      })
      .strict(),
    currency: z
      .object({
        code: z.string().trim().length(3),
        spokenName: z.string().trim().min(1).max(32),
        minorUnitsPerUnit: z.union([z.literal(1), z.literal(100), z.literal(1000)]),
      })
      .strict(),
    pricing: z
      .object({
        vatRatePercent: z.number().min(0).max(100),
        roundingMode: z.literal('half-up'),
      })
      .strict(),
    categories: z
      .array(
        z
          .object({
            id: idSchema,
            name: z.string().trim().min(1).max(64),
            note: z.string().max(200).default(''),
            sortOrder: z.number().int(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    optionGroups: z.array(optionGroupSchema).max(40),
    items: z.array(menuItemSchema).min(1).max(200),
    offMenu: z
      .array(
        z
          .object({
            match: z.array(aliasSchema).min(1).max(40),
            reply: z.string().trim().min(1).max(200),
            suggestItemIds: z.array(idSchema).max(5).default([]),
          })
          .strict(),
      )
      .max(40)
      .default([]),
  })
  .strict();

export type RawMenu = z.infer<typeof menuSchema>;

/* -------------------------------------------------------------------------- */
/* Referential integrity                                                       */
/* -------------------------------------------------------------------------- */

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

/**
 * Checks every cross-reference in the catalogue. Returns a list of problems
 * rather than throwing on the first, so a broken menu can be fixed in one pass.
 */
function checkIntegrity(menu: RawMenu): string[] {
  const problems: string[] = [];

  const groupIds = new Set(menu.optionGroups.map((group) => group.id));
  const categoryIds = new Set(menu.categories.map((category) => category.id));
  const itemIds = new Set(menu.items.map((item) => item.id));

  for (const duplicate of findDuplicates(menu.items.map((item) => item.id))) {
    problems.push(`duplicate item id: "${duplicate}"`);
  }
  for (const duplicate of findDuplicates(menu.optionGroups.map((group) => group.id))) {
    problems.push(`duplicate option group id: "${duplicate}"`);
  }
  for (const duplicate of findDuplicates(menu.categories.map((category) => category.id))) {
    problems.push(`duplicate category id: "${duplicate}"`);
  }

  const choiceIdsByGroup = new Map<string, Set<string>>();
  for (const group of menu.optionGroups) {
    choiceIdsByGroup.set(group.id, new Set(group.choices.map((choice) => choice.id)));
    if (group.defaultChoiceId && !choiceIdsByGroup.get(group.id)?.has(group.defaultChoiceId)) {
      problems.push(
        `group "${group.id}": defaultChoiceId "${group.defaultChoiceId}" is not one of its choices`,
      );
    }
  }

  const assertSelectionAllowed = (
    where: string,
    itemGroupIds: readonly string[],
    selection: { groupId: string; choiceId: string },
  ): void => {
    if (!itemGroupIds.includes(selection.groupId)) {
      problems.push(`${where}: references group "${selection.groupId}", which the item does not allow`);
      return;
    }
    if (!choiceIdsByGroup.get(selection.groupId)?.has(selection.choiceId)) {
      problems.push(
        `${where}: choice "${selection.choiceId}" does not exist in group "${selection.groupId}"`,
      );
    }
  };

  const itemsById = new Map(menu.items.map((item) => [item.id, item]));

  for (const item of menu.items) {
    if (!categoryIds.has(item.categoryId)) {
      problems.push(`item "${item.id}": unknown categoryId "${item.categoryId}"`);
    }
    for (const groupId of item.optionGroupIds) {
      if (!groupIds.has(groupId)) {
        problems.push(`item "${item.id}": unknown optionGroupId "${groupId}"`);
      }
    }
    for (const duplicate of findDuplicates(item.optionGroupIds)) {
      problems.push(`item "${item.id}": optionGroupId "${duplicate}" listed twice`);
    }
    if (item.speechNameGroupId && !item.optionGroupIds.includes(item.speechNameGroupId)) {
      problems.push(
        `item "${item.id}": speechNameGroupId "${item.speechNameGroupId}" is not one of its option groups`,
      );
    }

    for (const [index, shortcut] of (item.shortcuts ?? []).entries()) {
      for (const selection of shortcut.selections) {
        assertSelectionAllowed(`item "${item.id}" shortcut #${index}`, item.optionGroupIds, selection);
      }
    }

    for (const [index, component] of (item.components ?? []).entries()) {
      const componentItem = itemsById.get(component.itemId);
      if (!componentItem) {
        problems.push(`item "${item.id}" component #${index}: unknown itemId "${component.itemId}"`);
        continue;
      }
      if (componentItem.components) {
        problems.push(`item "${item.id}" component #${index}: combos cannot nest combos`);
      }
      for (const selection of component.fixedSelections) {
        assertSelectionAllowed(
          `item "${item.id}" component #${index}`,
          componentItem.optionGroupIds,
          selection,
        );
      }
    }
  }

  for (const [index, rule] of menu.offMenu.entries()) {
    for (const itemId of rule.suggestItemIds) {
      if (!itemIds.has(itemId)) {
        problems.push(`offMenu rule #${index}: unknown suggestItemId "${itemId}"`);
      }
    }
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/* Load, brand, freeze, index                                                  */
/* -------------------------------------------------------------------------- */

function brandMenu(raw: RawMenu): Menu {
  const brandChoice = (choice: RawMenu['optionGroups'][number]['choices'][number]): OptionChoice => ({
    id: choice.id,
    name: choice.name,
    priceDelta: minor(choice.priceDelta),
    aliases: Object.freeze([...choice.aliases]),
  });

  const optionGroups: OptionGroup[] = raw.optionGroups.map((group) => ({
    id: group.id,
    name: group.name,
    kind: group.kind,
    minSelect: group.minSelect,
    maxSelect: group.maxSelect,
    askWhenUnspecified: group.askWhenUnspecified,
    ...(group.defaultChoiceId ? { defaultChoiceId: group.defaultChoiceId } : {}),
    choices: Object.freeze(group.choices.map(brandChoice)),
  }));

  const items: MenuItem[] = raw.items.map((item) => ({
    id: item.id,
    categoryId: item.categoryId,
    name: item.name,
    description: item.description,
    basePrice: minor(item.basePrice),
    available: item.available,
    optionGroupIds: Object.freeze([...item.optionGroupIds]),
    ...(item.speechNameGroupId ? { speechNameGroupId: item.speechNameGroupId } : {}),
    aliases: Object.freeze([...item.aliases]),
    ...(item.shortcuts
      ? { shortcuts: Object.freeze(item.shortcuts.map((shortcut) => Object.freeze(shortcut))) }
      : {}),
    ...(item.components
      ? { components: Object.freeze(item.components.map((component) => Object.freeze(component))) }
      : {}),
  }));

  const categories: Category[] = [...raw.categories].sort((a, b) => a.sortOrder - b.sortOrder);

  return Object.freeze({
    schemaVersion: raw.schemaVersion,
    restaurant: Object.freeze(raw.restaurant),
    currency: Object.freeze(raw.currency),
    pricing: Object.freeze(raw.pricing),
    categories: Object.freeze(categories),
    optionGroups: Object.freeze(optionGroups),
    items: Object.freeze(items),
    offMenu: Object.freeze(raw.offMenu.map((rule) => Object.freeze(rule))),
  }) as Menu;
}

function buildIndex(menu: Menu): MenuIndex {
  const itemsById = new Map(menu.items.map((item) => [item.id, item]));
  const groupsById = new Map(menu.optionGroups.map((group) => [group.id, group]));

  const choicesById = new Map<string, { group: OptionGroup; choice: OptionChoice }>();
  for (const group of menu.optionGroups) {
    for (const choice of group.choices) {
      // Choice ids are unique per group; the composite key keeps them unique
      // globally without forcing the catalogue author to invent prefixes.
      choicesById.set(choiceKey(group.id, choice.id), { group, choice });
    }
  }

  const categoriesById = new Map(menu.categories.map((category) => [category.id, category]));

  const itemsByCategory = new Map<string, MenuItem[]>();
  for (const category of menu.categories) itemsByCategory.set(category.id, []);
  for (const item of menu.items) {
    itemsByCategory.get(item.categoryId)?.push(item);
  }

  return Object.freeze({
    menu,
    itemsById,
    groupsById,
    choicesById,
    categoriesById,
    itemsByCategory: itemsByCategory as ReadonlyMap<string, readonly MenuItem[]>,
  });
}

/** Composite key for the choice index: choice ids are only unique per group. */
export function choiceKey(groupId: string, choiceId: string): string {
  return `${groupId}::${choiceId}`;
}

function loadMenu(): MenuIndex {
  const parsed = menuSchema.safeParse(rawMenu);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
    );
    throw new MenuInvalidError('data/menu.json does not match the menu schema.', {
      issues: issues.slice(0, 25),
      issueCount: issues.length,
    });
  }

  const problems = checkIntegrity(parsed.data);
  if (problems.length > 0) {
    throw new MenuInvalidError('data/menu.json has broken references.', {
      problems: problems.slice(0, 25),
      problemCount: problems.length,
    });
  }

  return buildIndex(brandMenu(parsed.data));
}

/**
 * Module-level singleton. Next.js keeps route modules warm, so this parses and
 * validates once per process, not once per request.
 */
let cached: MenuIndex | null = null;

export function getMenuIndex(): MenuIndex {
  cached ??= loadMenu();
  return cached;
}

/* -------------------------------------------------------------------------- */
/* Lookups — the only sanctioned way to reach catalogue data                   */
/* -------------------------------------------------------------------------- */

export function findItem(index: MenuIndex, itemId: string): MenuItem | undefined {
  return index.itemsById.get(itemId);
}

export function findGroup(index: MenuIndex, groupId: string): OptionGroup | undefined {
  return index.groupsById.get(groupId);
}

export function findChoice(
  index: MenuIndex,
  groupId: string,
  choiceId: string,
): { group: OptionGroup; choice: OptionChoice } | undefined {
  return index.choicesById.get(choiceKey(groupId, choiceId));
}

/** Option groups an item allows, in catalogue order. */
export function groupsForItem(index: MenuIndex, item: MenuItem): OptionGroup[] {
  return item.optionGroupIds
    .map((groupId) => index.groupsById.get(groupId))
    .filter((group): group is OptionGroup => group !== undefined);
}

/** Lowest price at which an item can be sold, used for "from AED x" copy. */
export function minimumPriceFor(index: MenuIndex, item: MenuItem): Minor {
  let total: number = item.basePrice;
  for (const group of groupsForItem(index, item)) {
    if (group.minSelect <= 0) continue;
    const cheapest = Math.min(...group.choices.map((choice) => choice.priceDelta));
    total += cheapest;
  }
  return minor(total);
}
