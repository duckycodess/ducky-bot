import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  CredentialFileSchema, keyFingerprint, sha256Hex, type CredentialFileEntry,
} from '@ducky/adapters';
import { KEY_ID_RE, EXECUTOR_ID_RE, newKeyId } from '@ducky/contracts';
import { createStore, openDatabase, runMigrations } from '@ducky/persistence';
import { resolveCliPaths } from '../config.js';

/**
 * Issues, lists and revokes executor credentials.
 *
 * The plaintext bearer and HMAC key are printed exactly once and written only
 * to the 0600 credential file. SQLite receives a verifier and a fingerprint --
 * never the secrets themselves. Two credentials can be active at once, which is
 * what makes zero-downtime rotation possible.
 */
function usage(): never {
  process.stdout.write(
    [
      'usage:',
      '  credentials issue --executor <id> [--name <n>] [--key-id <k>]',
      '  credentials list [--executor <id>]',
      '  credentials revoke-credential --key-id <k>',
      '  credentials revoke-executor --executor <id>',
      '',
      'env: DUCKY_PROFILE (development|production, default development),',
      '     DUCKY_DB_PATH, DUCKY_DEV_EXECUTOR_CREDENTIALS_FILE / DUCKY_PROD_EXECUTOR_CREDENTIALS_FILE,',
      '     DUCKY_EXECUTOR_CREDENTIALS_FILE (development-only shared fallback)',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function loadFile(path: string): { version: 1; executors: CredentialFileEntry[] } {
  if (!existsSync(path)) return { version: 1, executors: [] };
  return CredentialFileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) as {
    version: 1;
    executors: CredentialFileEntry[];
  };
}

function saveFile(path: string, data: { version: 1; executors: CredentialFileEntry[] }): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function main(): void {
  const [, , command, ...argv] = process.argv;
  const { dbPath, credentialsFile: filePath } = resolveCliPaths(process.env);

  const db = openDatabase({ location: dbPath });
  runMigrations(db);
  const store = createStore(db);

  switch (command) {
    case 'issue': {
      const executorId = arg(argv, 'executor');
      if (!executorId || !EXECUTOR_ID_RE.test(executorId)) usage();
      const keyId = arg(argv, 'key-id') ?? newKeyId();
      if (!KEY_ID_RE.test(keyId)) usage();
      const name = arg(argv, 'name') ?? executorId;

      const bearerToken = randomBytes(32).toString('base64url');
      const hmacSecret = randomBytes(32).toString('base64url');

      store.executors.upsertExecutor(executorId, name);
      store.executors.addCredential({
        keyId,
        executorId,
        bearerVerifier: sha256Hex(bearerToken),
        hmacKeyFingerprint: keyFingerprint(hmacSecret),
      });

      const file = loadFile(filePath);
      file.executors.push({ executorId, keyId, name, bearerToken, hmacSecret, state: 'active' });
      saveFile(filePath, file);

      // Printed once, never logged. Copy it into the executor's environment now.
      process.stdout.write(
        [
          `executor:      ${executorId}`,
          `key id:        ${keyId}`,
          `bearer token:  ${bearerToken}`,
          `hmac secret:   ${hmacSecret}`,
          `credential file updated (0600): ${filePath}`,
          '',
          'Store these in the executor environment now; they are not recoverable.',
          '',
        ].join('\n'),
      );
      break;
    }

    case 'list': {
      const executorId = arg(argv, 'executor');
      const rows = store.executors.listCredentials(executorId);
      process.stdout.write(
        rows
          .map(
            (r) =>
              `${r.executorId}  ${r.keyId}  ${r.state}  fp=${r.hmacKeyFingerprint.slice(0, 12)}  ` +
              `created=${r.createdAt}  last_used=${r.lastUsedAt ?? 'never'}`,
          )
          .join('\n') + '\n',
      );
      break;
    }

    case 'revoke-credential': {
      const keyId = arg(argv, 'key-id');
      if (!keyId) usage();
      const ok = store.executors.revokeCredential(keyId);
      process.stdout.write(
        ok
          ? `revoked ${keyId} in the database; remove its entry from ${filePath} to complete rotation\n`
          : `no active credential ${keyId}\n`,
      );
      break;
    }

    case 'revoke-executor': {
      const executorId = arg(argv, 'executor');
      if (!executorId) usage();
      store.executors.revokeExecutor(executorId);
      process.stdout.write(`revoked executor ${executorId} (all of its keys are now refused)\n`);
      break;
    }

    default:
      usage();
  }

  db.close();
}

main();
