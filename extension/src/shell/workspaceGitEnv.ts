export function workspaceGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
  // Git's repository-local environment belongs to the launching process, not this workspace.
  // Dropping GIT_CONFIG_COUNT also handles hosts that strip an inherited GIT_CONFIG_VALUE.
  for (const key of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
    'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE',
    'GIT_GRAFT_FILE', 'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE',
    'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR',
  ]) delete env[key];
  return env;
}
