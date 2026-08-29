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
    // `issue list` IS classified now (the watch reads issue updates), so the
    // unclassified case has to be a surface nothing uses.
    // `create` is not on the forbidden-VERB list (the gh argv table has its own,
    // stricter one), so it is refused the other way: unclassified.
    expect(checkCommandAllowed('gh', ['issue', 'create'])?.reason).toBe('unclassified');
    expect(checkCommandAllowed('gh', ['label', 'list'])?.reason).toBe('unclassified');
    // `release` IS a forbidden verb, and that is checked before the table.
    expect(checkCommandAllowed('gh', ['release', 'list'])?.reason).toBe('forbidden_verb');
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
      ['gh', ['run', 'list', '-R', 'acme/demo', '--limit', '10']],
      ['gh', ['issue', 'list', '-R', 'acme/demo', '--state', 'open']],
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

  describe('leading root flags', () => {
    it('classifies a verb that sits behind boolean root flags', () => {
      // The recorded OpenClaw shape. Index-0 matching alone would call this
      // unclassified and refuse a correctly-built command.
      expect(classifyCommand('openclaw', ['--dev', '--no-color', 'agent'])?.cls).toBe(
        'local_mutation',
      );
      expect(
        checkCommandAllowed('openclaw', [
          '--dev', '--no-color', 'agent', '--local', '--json',
          '--session-key', 'agent:ducky:1234', '--message-file', '/tmp/x/msg.txt',
        ]),
      ).toBeUndefined();
    });

    it('fails CLOSED on a root flag that takes a separate value', () => {
      // `dev` lands where the verb should be. Nothing matches, so it is
      // refused rather than guessed at.
      expect(
        checkCommandAllowed('openclaw', ['--profile', 'dev', 'agent', '--json'])?.reason,
      ).toBe('unclassified');
    });

    it('still scans the WHOLE argv for forbidden verbs and flags', () => {
      // The skipped prefix is skipped for MATCHING only. It is still searched.
      expect(
        checkCommandAllowed('openclaw', ['--dev', 'agent', '--json', 'push'])?.reason,
      ).toBe('forbidden_verb');
      expect(
        checkCommandAllowed('openclaw', ['--force', 'agent', '--json'])?.reason,
      ).toBe('forbidden_verb');
    });

    it('names the verb rather than the flag when it refuses', () => {
      expect(checkCommandAllowed('openclaw', ['--dev', 'onboard'])?.detail).toContain('onboard');
    });
  });

  describe('the openclaw surface', () => {
    it('classifies an agent turn as a local mutation, not a read', () => {
      // A turn writes a session record on this host. Calling it read-only
      // would be a small lie in the direction that always matters.
      expect(classifyCommand('openclaw', ['agent'])?.cls).toBe('local_mutation');
    });

    it('refuses every openclaw surface that is not the turn or a status read', () => {
      for (const argv of [
        ['onboard'],
        ['configure'],
        ['channels', 'add'],
        ['pairing'],
        ['gateway'],
        ['message', 'send'],
      ]) {
        expect(checkCommandAllowed('openclaw', argv)?.reason, argv.join(' ')).toBe('unclassified');
      }
    });

    it('refuses every auth surface outright, so no code path can sign in', () => {
      // Signing in is an OWNER act at a TTY. `auth`, `login` and `token` are
      // forbidden VERBS, so this is refused before the table is consulted --
      // which is why the policy needs no entry to express it.
      for (const argv of [
        ['models', 'auth', 'login', '--provider', 'openai'],
        ['models', 'auth', 'paste-api-key'],
        ['models', 'auth', 'list'],
      ]) {
        expect(checkCommandAllowed('openclaw', argv)?.reason, argv.join(' ')).toBe(
          'forbidden_verb',
        );
      }
    });
  });
});
