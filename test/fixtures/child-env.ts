/** Child-process environment for tests that execute reverted or CLI code. */

/** Names that carry credentials: tokens, secrets, passwords, keys (API, access, private), auth material and cookies. `AUTH(?!OR)` keeps PM_AUTHOR. */
const CREDENTIAL_NAME = /TOKEN|SECRET|PASS|CREDENTIAL|KEY|AUTH(?!OR)|COOKIE|NPM_MEDIA_SERVER/i;

/** Copy `env` without inherited Node test/coverage options and without any credential-named variable. */
export function isolatedChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...env, NODE_OPTIONS: undefined, NODE_V8_COVERAGE: undefined, NODE_TEST_CONTEXT: undefined };
  for (const key of Object.keys(childEnv)) if (CREDENTIAL_NAME.test(key)) delete childEnv[key];
  return childEnv;
}
