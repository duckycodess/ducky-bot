import { describe, expect, it } from 'vitest';
import {
  COMMAND_POLICY, FORBIDDEN_COMMAND_VERBS, MAX_ALLOWED_COMMAND_CLASS,
  checkCommandAllowed, classifyCommand, exceedsAllowedClass, findForbiddenVerb,
} from '../src/command-policy.js';
import { GH_OPERATIONS } from '../../adapters/src/github/gh-cli.js';

describe('the command policy', () => {
  it('classifies nothing above a local mutation in this phase', () => {
    expect(MAX_ALLOWED_COMMAND_CLASS).toBe('local_mutation');
    for (const entry of COMMAND_POLICY) {
      expect(
        exceedsAllowedClass(entry.cls),
        `${entry.bin} ${entry.verb.join(' ')}`,
      ).toBe(entry.cls === 'external_mutation');
    }
    // The two classes that would matter are defined and refused, not absent.
    expect(exceedsAllowedClass('external_mutation')).toBe(true);
    expect(exceedsAllowedClass('high_risk')).toBe(true);
  });

  it('contains no forbidden verb anywhere in its own table', () => {
    for (const entry of COMMAND_POLICY) {
      expect(
        findForbiddenVerb(entry.verb, { allowExternalMutation: true }),
        `${entry.bin} ${entry.verb.join(' ')}`,
      ).toBeUndefined();
    }
  });

  it('refuses an unclassified command rather than defaulting to allowed', () => {
    const refusal = checkCommandAllowed('git', ['cherry-pick', 'main']);
    expect(refusal?.reason).toBe('unclassified');
    expect(checkCommandAllowed('curl', ['https://example.com'])?.reason).toBe('unclassified');
    // A classified binary with an unknown subcommand is still unclassified.
    expect(checkCommandAllowed('gh', ['issue', 'list'])?.reason).toBe('unclassified');
  });

  it('refuses a forbidden verb before it even looks at the table', () => {
    for (const verb of ['push', 'reset', 'clean', 'rm', 'exec', 'auth'] as const) {
      const refusal = checkCommandAllowed('git', [verb]);
      expect(refusal?.reason, verb).toBe('forbidden_verb');
    }
    // Including when it is buried in an otherwise-classified argv.
    expect(checkCommandAllowed('git', ['status', '--porcelain', 'clean'])?.reason).toBe(
      'forbidden_verb',
    );
    expect(checkCommandAllowed('git', ['push', 'origin', 'main'], 'external_mutation')).toBeUndefined();
    expect(checkCommandAllowed('git', ['push', 'origin', 'main', '--force'], 'external_mutation')?.reason).toBe(
      'forbidden_verb',
    );
    expect(checkCommandAllowed('git', ['branch', '-D', 'main'])?.reason).toBe('unclassified');
    expect(checkCommandAllowed('git', ['remote', 'remove', 'origin'])?.reason).toBe('unclassified');
  });

  it('does not mistake a flag for a verb', () => {
    expect(findForbiddenVerb(['status', '--porcelain'])).toBeUndefined();
    expect(findForbiddenVerb(['rev-parse', '--verify', '--quiet', 'HEAD'])).toBeUndefined();
  });

  it('allows exactly the surfaces the system actually uses today', () => {
    const allowed: [string, string[]][] = [
      ['gh', ['repo', 'view', 'acme/demo', '--json', 'name']],
      ['gh', ['pr', 'list', '-R', 'acme/demo']],
      ['git', ['rev-parse', '--verify', '--quiet', 'HEAD']],
      ['git', ['status', '--porcelain']],
      ['git', ['stash', 'list']],
      ['git', ['worktree', 'list', '--porcelain']],
      ['git', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']],
      ['herdr', ['agent', 'list']],
      ['herdr', ['agent', 'get', 'ducky-pi-demo']],
      ['herdr', ['agent', 'read', 'ducky-pi-demo', '--source', 'detection']],
      ['herdr', ['agent', 'wait', 'ducky-pi-demo', '--until', 'idle', '--timeout', '5000']],
      ['herdr', ['workspace', 'create']],
      ['herdr', ['workspace', 'close', 'ws-1']],
      ['herdr', ['worktree', 'remove', '--workspace', 'ws-1']],
    ];
    for (const [bin, argv] of allowed) {
      expect(checkCommandAllowed(bin, argv), `${bin} ${argv.join(' ')}`).toBeUndefined();
    }
  });

  it('prefers the longest matching verb, so a specific entry wins', () => {
    // `stash list` is read-only; a bare `stash` is not classified at all.
    expect(classifyCommand('git', ['stash', 'list'])?.cls).toBe('read_only');
    expect(classifyCommand('git', ['stash'])).toBeUndefined();
  });

  it('never lists a forbidden verb that the gh table could also produce', () => {
    // Belt and braces against the two tables drifting apart.
    for (const build of Object.values(GH_OPERATIONS)) {
      const argv = build({ owner: 'acme', repo: 'demo' }, 1);
      expect(findForbiddenVerb(argv, { allowExternalMutation: true }), argv.join(' ')).toBeUndefined();
      expect(checkCommandAllowed('gh', argv), argv.join(' ')).toBeUndefined();
    }
  });

  it('refuses a forced worktree removal even though the verb itself is allowed', () => {
    // The whole reason cleanup keeps a dirty checkout: forcing would delete
    // work nothing has committed. The flag is refused, not the operation.
    expect(checkCommandAllowed('herdr', ['worktree', 'remove', '--workspace', 'ws-1'])).toBeUndefined();
    expect(
      checkCommandAllowed('herdr', ['worktree', 'remove', '--workspace', 'ws-1', '--force'])?.reason,
    ).toBe('forbidden_verb');
  });

  it('keeps the forbidden list covering the verbs that actually matter', () => {
    for (const verb of ['push', 'reset', 'clean', 'rm', 'exec', 'token'] as const) {
      expect(FORBIDDEN_COMMAND_VERBS).toContain(verb);
    }
  });
});
