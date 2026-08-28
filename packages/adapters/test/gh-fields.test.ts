import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_GH_VERBS, GH_OPERATIONS } from '../src/github/gh-cli.js';

const FIXTURE = path.resolve(
  import.meta.dirname, '..', 'src', 'github', 'gh.fixtures', 'json-fields.json',
);

interface Recorded {
  ghVersion: string;
  surfaces: Record<string, { exitCode: number; fields: string[] }>;
}

/**
 * Every `--json` selector Ducky sends, checked against what `gh` says it
 * supports.
 *
 * A selector `gh` does not know is an argv that fails at RUNTIME, in a watch
 * tick, hours after the change that introduced it. `pnpm probe:gh` records the
 * supported field names by asking `gh` itself — locally, with no repository
 * named and no network request — and this asserts the table against that
 * record.
 *
 * What it deliberately does not assert: response VALUES. No GitHub repository is
 * configured in this host's allowlist, so nothing here has ever seen one, and
 * the schemas built on this record are tolerant for exactly that reason.
 */
describe('the gh json selectors are recorded, not guessed', () => {
  const present = existsSync(FIXTURE);
  const data: Recorded | undefined = present
    ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Recorded)
    : undefined;

  /** `['pr','list',…]` → the surface key the probe records. */
  const surfaceOf = (argv: readonly string[]): string => `${argv[0]} ${argv[1]}`;

  const selectorsOf = (argv: readonly string[]): string[] => {
    const i = argv.indexOf('--json');
    return i >= 0 ? (argv[i + 1] ?? '').split(',').filter(Boolean) : [];
  };

  it('reports honestly when no probe has been recorded', () => {
    if (!present) {
      expect(data).toBeUndefined();
      return;
    }
    expect(data!.ghVersion).toMatch(/gh version/i);
  });

  it('sends only field selectors this gh supports', () => {
    if (!data) return;
    for (const build of Object.values(GH_OPERATIONS)) {
      const argv = build({ owner: 'acme', repo: 'demo' }, 1);
      const surface = surfaceOf(argv);
      const recorded = data.surfaces[surface];
      // `pr checks` reads its own fields; an unrecorded surface is a gap in the
      // probe, not a licence to skip the check.
      expect(recorded, `no recorded field list for \`gh ${surface}\``).toBeDefined();
      for (const selector of selectorsOf(argv)) {
        expect(recorded!.fields, `gh ${surface} --json ${selector}`).toContain(selector);
      }
    }
  });

  it('still constructs no write verb anywhere', () => {
    // Re-asserted here because the table grew: the watch surface is wider now,
    // and wider is exactly when a write verb slips in.
    for (const build of Object.values(GH_OPERATIONS)) {
      const argv = build({ owner: 'acme', repo: 'demo' }, 1).map((a) => a.toLowerCase());
      for (const verb of FORBIDDEN_GH_VERBS) {
        expect(argv, `${verb} in ${argv.join(' ')}`).not.toContain(verb);
      }
    }
  });

  it('bounds every list it asks for', () => {
    // An unbounded list is an unbounded response, and a watch runs forever.
    for (const [name, build] of Object.entries(GH_OPERATIONS)) {
      const argv = build({ owner: 'acme', repo: 'demo' }, 1);
      if (!argv.includes('list')) continue;
      expect(argv, name).toContain('--limit');
    }
  });
});
