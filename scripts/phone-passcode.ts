/**
 * Prints the verifier for a phone passcode. Contacts nothing, stores nothing.
 *
 * The passcode is read from STDIN rather than from argv, because an argument
 * lands in shell history, in `ps` output, and in whatever the terminal keeps.
 * What this prints is a verifier: it cannot be turned back into the passcode,
 * and it is what goes in the env file.
 *
 *     pnpm phone:passcode
 *     (type the passcode, press enter)
 *
 * Nothing here writes to the database, reads a credential, or touches the
 * executor's credential file -- a human passcode and a machine credential are
 * different things with different lifetimes, and this tool knows about only
 * one of them.
 */
import { createInterface } from 'node:readline';
import { phonePasscodeVerifier } from '../packages/coordinator/src/http/phone-auth.js';

async function readPasscode(): Promise<string> {
  // A TTY gets a prompt; a pipe does not, so `echo … | pnpm phone:passcode`
  // stays usable in a runbook without a stray prompt in the output.
  if (process.stdin.isTTY) process.stderr.write('Passcode (at least 10 characters): ');
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  return '';
}

async function main(): Promise<void> {
  const passcode = await readPasscode();
  const verifier = phonePasscodeVerifier(passcode.trim());
  process.stdout.write(
    'Put this in your env file for THIS profile, and keep the passcode in your head:\n\n' +
      `DUCKY_DEV_PHONE_PASSCODE_VERIFIER=${verifier}\n` +
      '  (production: DUCKY_PROD_PHONE_PASSCODE_VERIFIER)\n\n' +
      'Then set DUCKY_PHONE_CAPTURE_ENABLED=1 and bind DUCKY_HTTP_HOST to your tailnet address.\n',
  );
}

main().catch((err: unknown) => {
  // The REASON, never the passcode -- it is the one thing that must not be
  // echoed, including by a failure.
  process.stderr.write(`${err instanceof Error ? err.message : 'could not build a verifier'}\n`);
  process.exit(1);
});
