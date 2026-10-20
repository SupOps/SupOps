import type { RuleHit } from './rule-kit.ts';
import { hit, worst } from './rule-kit.ts';

/*
 * `VAR=value cmd` sets VAR for that one command, and a bare `VAR=value` sets it for
 * the rest of the line. Some variables change what a harmless-looking command
 * actually does: `LD_PRELOAD=/tmp/x.so ls` loads arbitrary code into `ls`, and
 * `KUBECONFIG=/tmp/k kubectl get pods` talks to a cluster that is not the target.
 *
 * These rules only raise: the command's own tier still applies, and the line takes
 * the worst of the two. Locale, timezone and colour settings stay free.
 */

/** Change nothing but formatting, language or prompts. */
const BENIGN = new Set([
  'LANG', 'LANGUAGE', 'TZ', 'TERM', 'COLUMNS', 'LINES', 'NO_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE',
  'FORCE_COLOR', 'SYSTEMD_COLORS', 'SYSTEMD_LESS', 'LESS', 'DEBIAN_FRONTEND', 'NEEDRESTART_MODE',
  'NEEDRESTART_SUSPEND', 'TIME_STYLE', 'GREP_COLORS', 'LS_COLORS', 'QUOTING_STYLE',
]);
const BENIGN_PATTERN = /^LC_[A-Z]+$/;

/** Name a program to run (a pager or editor): fine when that program is a plain viewer. */
const RUNS_A_PROGRAM = new Set(['PAGER', 'SYSTEMD_PAGER', 'GIT_PAGER', 'MANPAGER', 'PSQL_PAGER', 'MYSQL_PAGER', 'EDITOR', 'VISUAL', 'GIT_EDITOR', 'SYSTEMD_EDITOR']);
const PLAIN_VIEWERS = new Set(['', 'cat', 'less', 'more', 'less -R', 'less -FRX', 'less -FRSX', '/bin/cat', '/usr/bin/cat', '/usr/bin/less']);

/** Load or run other code inside the command, or change how the shell reads it. */
const CODE_LOADING = new Set([
  'PATH', 'IFS', 'BASH_ENV', 'ENV', 'PROMPT_COMMAND', 'PS0', 'PS1', 'PS2', 'PS4', 'SHELLOPTS', 'BASHOPTS', 'CDPATH',
  'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'PYTHONINSPECT', 'PYTHONUSERBASE',
  'PERL5LIB', 'PERL5OPT', 'PERLLIB', 'RUBYOPT', 'RUBYLIB', 'NODE_OPTIONS', 'NODE_PATH',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH', 'GCONV_PATH', 'OPENSSL_CONF', 'OPENSSL_ENGINES',
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH', 'GIT_ASKPASS', 'GIT_EXTERNAL_DIFF', 'GIT_TEMPLATE_DIR',
  'SSH_ASKPASS', 'SUDO_ASKPASS', 'LESSOPEN', 'LESSCLOSE', 'BROWSER',
]);
const CODE_LOADING_PATTERN = /^(LD_[A-Z_]+|DYLD_[A-Z_]+|BASH_FUNC_.+|GIT_CONFIG.*|MALLOC_[A-Z_]+|GLIBC_TUNABLES)$/;

/** Point the command at another cluster, account, host, credential or network path. */
const RETARGETING = new Set([
  'KUBECONFIG', 'HELM_KUBECONTEXT', 'HELM_KUBETOKEN', 'HELM_KUBEAPISERVER', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH',
  'AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN', 'AWS_ENDPOINT_URL', 'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'AZURE_CONFIG_DIR', 'ARM_CLIENT_ID', 'ARM_CLIENT_SECRET', 'ARM_SUBSCRIPTION_ID',
  'VAULT_ADDR', 'VAULT_TOKEN', 'PGHOST', 'PGPASSWORD', 'PGSERVICEFILE', 'PGPASSFILE', 'MYSQL_HOST', 'MYSQL_PWD', 'REDISCLI_AUTH',
  'SSH_AUTH_SOCK', 'GNUPGHOME', 'NETRC', 'CURL_HOME', 'WGETRC', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'FTP_PROXY', 'ftp_proxy',
]);
const RETARGETING_PATTERN = /^(CLOUDSDK_.+|KUBE_.+|TF_VAR_.+|TF_CLI_ARGS.*|TF_DATA_DIR|ANSIBLE_.+)$/;

/** One assignment's verdict, or null for a benign one. */
function classifyOne(name: string, value: string, scope: string, statement: boolean): RuleHit | null {
  if (BENIGN.has(name) || BENIGN_PATTERN.test(name)) return null;
  if (RUNS_A_PROGRAM.has(name)) {
    if (PLAIN_VIEWERS.has(value.trim())) return null;
    return hit('shell.env.program', 'high', `${name}=${value} makes ${scope} run "${value}" as a program`, { category: 'code-execution' });
  }
  if (CODE_LOADING.has(name) || CODE_LOADING_PATTERN.test(name)) {
    return hit('shell.env.loader', 'high', `${name} set for ${scope} can load or run other code, or change how the shell reads the command`, { category: 'code-execution' });
  }
  if (RETARGETING.has(name) || RETARGETING_PATTERN.test(name)) {
    return hit('shell.env.retarget', 'high', `${name} set for ${scope} can point it at another cluster, account, host or credential than the registered target`, { category: 'privilege' });
  }
  // A bare `F=/var/log/x; tail $F` only names a value for the line (the lexer already
  // substitutes it); unlike a prefix, an unexported variable never reaches a program.
  if (statement) return null;
  return hit('shell.env.unknown', 'medium', `${name} set for ${scope}: an unrecognised variable can change what a program does, so a person checks it`);
}

/**
 * The verdict for a command's `VAR=value` prefix (`scope` names the command), or for
 * bare assignments (`statement`), which apply to the rest of the line. Null when
 * every one is benign.
 */
export function classifyAssignments(pairs: Array<[string, string]>, scope: string, statement = false): RuleHit | null {
  const hits = pairs.map(([n, v]) => classifyOne(n, v, scope, statement)).filter((h): h is RuleHit => h !== null);
  return hits.length ? worst(hits) : null;
}
