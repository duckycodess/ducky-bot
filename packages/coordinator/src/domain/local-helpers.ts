/**
 * The two small helpers the milestone asked for, built the only way they can be
 * built honestly on this host: from fixed local data, with no provider anywhere
 * near them.
 *
 * WHY THEY LIVE ON THE CONVERSATION ROUTE. Both were specified as owner-only,
 * and the obvious shape would be `/meal` and `/study`. `AGENTS.md` forbids
 * widening the owner-only surface, and a new slash command is exactly that — so
 * they ride the route that already exists, gated to the owner the same way a
 * conversation ATTACHMENT already is. No command was added, no interaction kind
 * was added, and `OWNER_ONLY_COMMANDS` is untouched.
 *
 * WHAT THEY ARE NOT. Neither generates a sentence. The meal helper picks from a
 * fixed list and says so; the study helper arranges the owner's own topic into a
 * fixed schedule and says so. That is the same rule `BriefingService` follows,
 * and it is why a missing conversation provider costs these nothing.
 */

export interface FilipinoDish {
  readonly name: string;
  /** Which meals it suits. Used to answer "what's for breakfast" sensibly. */
  readonly meals: readonly ('breakfast' | 'lunch' | 'dinner')[];
  /** Rough hands-on time, so "quick" can mean something. */
  readonly minutes: number;
  readonly mainProtein: 'pork' | 'chicken' | 'beef' | 'fish' | 'egg' | 'vegetable';
  /** What it needs, so the answer is useful rather than just a name. */
  readonly needs: string;
}

/**
 * A small, fixed, obviously-incomplete list.
 *
 * Deliberately short. A long list would look like a database and invite the
 * belief that Ducky knows about food; this is a handful of dishes somebody typed
 * into a source file, and the reply says exactly that.
 */
export const FILIPINO_DISHES: readonly FilipinoDish[] = Object.freeze([
  { name: 'Tapsilog', meals: ['breakfast'], minutes: 20, mainProtein: 'beef', needs: 'cured beef, garlic rice, egg' },
  { name: 'Tocilog', meals: ['breakfast'], minutes: 20, mainProtein: 'pork', needs: 'tocino, garlic rice, egg' },
  { name: 'Arroz caldo', meals: ['breakfast', 'dinner'], minutes: 45, mainProtein: 'chicken', needs: 'rice, ginger, chicken, calamansi' },
  { name: 'Adobo', meals: ['lunch', 'dinner'], minutes: 45, mainProtein: 'pork', needs: 'soy sauce, vinegar, garlic, bay leaf' },
  { name: 'Chicken adobo', meals: ['lunch', 'dinner'], minutes: 40, mainProtein: 'chicken', needs: 'soy sauce, vinegar, garlic, pepper' },
  { name: 'Sinigang na baboy', meals: ['lunch', 'dinner'], minutes: 60, mainProtein: 'pork', needs: 'pork, tamarind, kangkong, radish' },
  { name: 'Sinigang na isda', meals: ['lunch', 'dinner'], minutes: 35, mainProtein: 'fish', needs: 'fish, tamarind, tomatoes, okra' },
  { name: 'Ginisang munggo', meals: ['lunch', 'dinner'], minutes: 40, mainProtein: 'vegetable', needs: 'mung beans, garlic, tomato, ampalaya leaves' },
  { name: 'Tortang talong', meals: ['lunch', 'dinner'], minutes: 25, mainProtein: 'egg', needs: 'eggplant, eggs, onion' },
  { name: 'Pinakbet', meals: ['lunch', 'dinner'], minutes: 35, mainProtein: 'vegetable', needs: 'mixed vegetables, bagoong' },
  { name: 'Bistek Tagalog', meals: ['lunch', 'dinner'], minutes: 40, mainProtein: 'beef', needs: 'beef, calamansi, soy sauce, onion' },
  { name: 'Ginataang gulay', meals: ['lunch', 'dinner'], minutes: 30, mainProtein: 'vegetable', needs: 'coconut milk, squash, string beans' },
  { name: 'Daing na bangus', meals: ['breakfast', 'lunch'], minutes: 20, mainProtein: 'fish', needs: 'marinated milkfish, garlic rice' },
]);

export interface MealSuggestion {
  readonly meal: 'breakfast' | 'lunch' | 'dinner';
  readonly picks: readonly FilipinoDish[];
  /** Constraints the message actually expressed, echoed back. */
  readonly applied: readonly string[];
  /** True when a constraint left nothing, so the reply can say so. */
  readonly narrowed: boolean;
}

/** Which meal a local hour belongs to. A projection, like everything else. */
export function mealForHour(hour: number): 'breakfast' | 'lunch' | 'dinner' {
  if (hour < 10) return 'breakfast';
  if (hour < 15) return 'lunch';
  return 'dinner';
}

/**
 * Picks from the fixed list, honouring only constraints it can actually check.
 *
 * The selection is deterministic given the same day and constraints: a
 * date-seeded rotation rather than a random pick, so asking twice in a minute
 * does not produce two different confident answers.
 */
export function suggestMeal(input: {
  readonly text: string;
  readonly hour: number;
  readonly dayKey: string;
  readonly explicitMeal?: 'breakfast' | 'lunch' | 'dinner';
}): MealSuggestion {
  const lower = input.text.toLowerCase();
  const meal = input.explicitMeal ??
    (/\bbreakfast\b/.test(lower) ? 'breakfast'
      : /\blunch\b/.test(lower) ? 'lunch'
      : /\bdinner\b|\bsupper\b/.test(lower) ? 'dinner'
      : mealForHour(input.hour));

  const applied: string[] = [];
  let pool = FILIPINO_DISHES.filter((d) => d.meals.includes(meal));

  if (/\bquick\b|\bfast\b|\bno time\b/.test(lower)) {
    applied.push('quick');
    pool = pool.filter((d) => d.minutes <= 30);
  }
  for (const protein of ['pork', 'chicken', 'beef', 'fish'] as const) {
    if (new RegExp(`\\bno ${protein}\\b`).test(lower)) {
      applied.push(`no ${protein}`);
      pool = pool.filter((d) => d.mainProtein !== protein);
    }
  }
  if (/\bveg(etarian|gie)?\b|\bmeatless\b/.test(lower)) {
    applied.push('vegetarian');
    pool = pool.filter((d) => d.mainProtein === 'vegetable' || d.mainProtein === 'egg');
  }

  const narrowed = pool.length === 0;
  if (narrowed) pool = FILIPINO_DISHES.filter((d) => d.meals.includes(meal));

  // Deterministic rotation: the same day and the same question give the same
  // answer, which is what makes this a suggestion rather than a slot machine.
  const seed = [...input.dayKey].reduce((n, c) => n + c.charCodeAt(0), 0);
  const start = pool.length > 0 ? seed % pool.length : 0;
  const picks = [0, 1, 2].map((i) => pool[(start + i) % pool.length]!).filter(
    (d, i, arr) => arr.indexOf(d) === i,
  );

  return { meal, picks, applied, narrowed };
}

export interface StudyPlan {
  readonly topic: string;
  readonly totalMinutes: number;
  readonly blocks: readonly { readonly label: string; readonly minutes: number }[];
}

/**
 * Arranges the owner's OWN topic into a fixed schedule.
 *
 * It knows nothing about the topic and does not pretend to: there is no summary,
 * no reading list and no generated question. It is a timer plan with the owner's
 * words in the title, which is the honest version of "help me study" without a
 * provider.
 *
 * No privileged tool is reachable from here, and no upload is accepted on this
 * path at all -- so there are no bytes to retain.
 */
export function buildStudyPlan(topic: string, requestedMinutes?: number): StudyPlan {
  const total = Math.min(Math.max(requestedMinutes ?? 50, 20), 180);
  // A 50/10 rhythm, scaled. Fixed ratios, not advice: the split is arithmetic.
  const blocks = [
    { label: 'Recall what you already know, without notes', minutes: Math.round(total * 0.15) },
    { label: 'Read or work through new material', minutes: Math.round(total * 0.45) },
    { label: 'Practise: write, solve or explain it aloud', minutes: Math.round(total * 0.25) },
    { label: 'Break', minutes: Math.round(total * 0.15) },
  ];
  return { topic: topic.trim().slice(0, 200), totalMinutes: total, blocks };
}

/** Minutes asked for in plain text, if any. Bounded by the plan builder. */
export function requestedStudyMinutes(text: string): number | undefined {
  const m = /\b(\d{1,3})\s*(?:m|min|mins|minutes)\b/i.exec(text);
  return m ? Number(m[1]) : undefined;
}
